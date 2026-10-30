"""Probe: DNS queries and HTTP requests from inside one Region's VPC.

The private hosted zone answers only inside the two VPCs it is associated with, so the operator
script (scripts/demo.py) sees DNS and HTTP the way a client in the VPC does by invoking this
function. Two kinds of event:

    {"names": ["ingest.example.com", ...], "samples": 20, "interval": 0.5}
        Sends A queries straight to this VPC's Route 53 Resolver (the VPC CIDR base plus two), so
        each answer shows the TTL the resolver hands out, and returns them per name. A query that
        times out is sent once more, and an answer cut short (the TC bit) is asked again over TCP.

    {"requests": [{"method": "POST", "url": "http://ingest.example.com/read", "body": "{...}"}]}
        Resolves each URL's host the same way, connects to the lowest address answered (the list is
        sorted, so the choice does not depend on the order the resolver answered in), and follows
        redirects, recording one hop per response. Only http URLs are fetched. A hop that cannot
        start in time, or a chain that is still redirecting after MAX_HOPS, ends with an error.

Only the Python standard library is used; the function has no route to the internet.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import math
import os
import random
import socket
import struct
import time
import urllib.parse

DNS_PORT = 53
HTTP_PORT = 80
REDIRECTS = (301, 302, 303, 307, 308)
RCODES = {0: "NOERROR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED"}
ERRORS = (OSError, ValueError, IndexError, struct.error, http.client.HTTPException)
MAX_REQUESTS = 10
MAX_HOPS = 3
TRUNCATED = 0x0200  # the TC flag: the answer did not fit in a UDP datagram
SPARE_SECONDS = 8  # one hop can take about this long (DNS timeouts, connect, read), so none starts with less left


def resolver() -> str:
    """The Route 53 Resolver address of this VPC: the base of its CIDR plus two."""
    return str(ipaddress.ip_network(os.environ["VPC_CIDR"])[2])


def skip_name(data: bytes, offset: int) -> int:
    """The offset just past a (possibly compressed) DNS name."""
    while data[offset]:
        if data[offset] & 0xC0 == 0xC0:  # a pointer ends the name
            return offset + 2
        offset += data[offset] + 1
    return offset + 1


def ask_udp(packet: bytes, server: str, port: int, timeout: float) -> bytes:
    """Send a query datagram; if no answer comes in time, send it once more."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(packet, (server, port))
        try:
            return sock.recv(4096)
        except socket.timeout:  # one lost datagram must not fail a rehearsal that runs for minutes
            sock.sendto(packet, (server, port))
            return sock.recv(4096)


def read_exactly(sock: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ValueError("the resolver closed the connection before the answer was complete")
        data += chunk
    return data


def ask_tcp(packet: bytes, server: str, port: int, timeout: float) -> bytes:
    """The same query over TCP, where each message carries a two-byte length in front."""
    with socket.create_connection((server, port), timeout=timeout) as sock:
        sock.sendall(struct.pack("!H", len(packet)) + packet)
        (size,) = struct.unpack("!H", read_exactly(sock, 2))
        return read_exactly(sock, size)


def header(data: bytes, qid: int) -> tuple:
    """(flags, question count, answer count) of a response to query qid."""
    rid, flags, qdcount, ancount = struct.unpack("!4H", data[:8])
    if rid != qid:
        raise ValueError("response id does not match the query")
    return flags, qdcount, ancount


def query(name: str, server: str | None = None, port: int | None = None, timeout: float = 2.0) -> dict:
    """One A query: {"rcode", "ttl" (lowest of the answers), "addresses" (sorted)}."""
    qid = random.getrandbits(16)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in name.rstrip(".").split("."))
    packet = struct.pack("!6H", qid, 0x0100, 1, 0, 0, 0) + qname + b"\0" + struct.pack("!2H", 1, 1)
    server, port = server or resolver(), port or DNS_PORT
    data = ask_udp(packet, server, port, timeout)
    flags, qdcount, ancount = header(data, qid)
    if flags & TRUNCATED:  # a cut-short answer would read as a complete, shorter address list
        data = ask_tcp(packet, server, port, timeout)
        flags, qdcount, ancount = header(data, qid)
    offset = 12
    for _ in range(qdcount):
        offset = skip_name(data, offset) + 4
    addresses, ttls = [], []
    for _ in range(ancount):
        offset = skip_name(data, offset)
        rtype, _, ttl, length = struct.unpack("!2HIH", data[offset:offset + 10])
        offset += 10
        if rtype == 1 and length == 4:
            addresses.append(socket.inet_ntoa(data[offset:offset + 4]))
            ttls.append(ttl)
        offset += length
    rcode = flags & 0xF
    return {"rcode": RCODES.get(rcode, str(rcode)), "ttl": min(ttls) if ttls else None, "addresses": sorted(addresses)}


def fetch(method: str, url: str, body: str | None = None, max_hops: int = MAX_HOPS, deadline: float = math.inf) -> list:
    """Send one request and follow redirects; one hop per response, or an error ends the trace.

    deadline is a time.monotonic() value: a hop that would start after it is recorded as an error
    and not sent."""
    hops = []
    for _ in range(max_hops):
        hop = {"method": method, "url": url}
        hops.append(hop)
        if time.monotonic() >= deadline:
            hop["error"] = "not sent: the function is nearly out of time"
            break
        try:
            parts = urllib.parse.urlsplit(url)
            if parts.scheme != "http":  # the ALBs have an HTTP listener only; never send an https URL in the clear
                raise ValueError(f"only http URLs are fetched, not {parts.scheme or 'a URL without a scheme'}")
            if not parts.hostname:
                raise ValueError("the URL has no host")
            answer = query(parts.hostname)
            if not answer["addresses"]:
                hop["error"] = f"{answer['rcode']}: no address for {parts.hostname}"
                break
            hop["address"] = answer["addresses"][0]
            headers = {"Host": parts.netloc}
            if body is not None:
                headers["Content-Type"] = "application/json"
            conn = http.client.HTTPConnection(hop["address"], parts.port or HTTP_PORT, timeout=5)
            try:
                target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
                conn.request(method, target, None if body is None else body.encode(), headers)
                response = conn.getresponse()
                data = response.read(4096).decode("utf-8", "replace")
            finally:
                conn.close()
        except ERRORS as exc:
            hop["error"] = f"{type(exc).__name__}: {exc}"
            break
        hop.update(status=response.status, servedBy=response.getheader("X-Served-By"),
                   location=response.getheader("Location"))
        try:
            hop["body"] = json.loads(data)
        except ValueError:
            hop["body"] = data[:300]
        if response.status not in REDIRECTS or not hop["location"]:
            break
        url = urllib.parse.urljoin(url, hop["location"])
        if response.status in (301, 302, 303):
            method, body = "GET", None  # only 307 and 308 repeat the method and body
    else:  # every hop was a redirect
        hops[-1]["error"] = "too many redirects"
    return hops


def handler(event: dict, context=None) -> dict:
    out = {"region": os.environ["AWS_REGION"], "resolver": resolver()}
    if "requests" in event:
        remaining = context.get_remaining_time_in_millis() / 1000 if context is not None else math.inf
        deadline = time.monotonic() + remaining - SPARE_SECONDS
        out["traces"] = [fetch(r["method"], r["url"], r.get("body"), deadline=deadline)
                         for r in event["requests"][:MAX_REQUESTS]]
        return out
    samples = max(1, min(int(event.get("samples", 1)), 100))
    interval = max(0.0, float(event.get("interval", 0)))
    results: dict = {name: [] for name in event["names"]}
    for i in range(samples):
        if i:
            time.sleep(interval)
        for name in results:
            try:
                results[name].append(query(name))
            except ERRORS as exc:
                results[name].append({"error": f"{type(exc).__name__}: {exc}"})
    out["results"] = results
    return out
