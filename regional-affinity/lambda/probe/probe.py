"""Probe: DNS queries and HTTP requests from inside one Region's VPC.

The private hosted zone answers only inside the two VPCs it is associated with, so the operator
script (scripts/demo.py) sees DNS and HTTP the way a client in the VPC does by invoking this
function. Two kinds of event:

    {"names": ["ingest.demo.io", ...], "samples": 20, "interval": 0.5}
        Sends A queries straight to this VPC's Route 53 Resolver (the VPC CIDR base plus two), so
        each answer shows the TTL the resolver hands out, and returns them per name.

    {"requests": [{"method": "POST", "url": "http://ingest.demo.io/read", "body": "{...}"}]}
        Resolves each URL's host the same way, connects to the first address answered, and follows
        redirects, recording one hop per response.

Only the Python standard library is used; the function has no route to the internet.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
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


def query(name: str, server: str | None = None, port: int | None = None, timeout: float = 2.0) -> dict:
    """One A query: {"rcode", "ttl" (lowest of the answers), "addresses" (sorted)}."""
    qid = random.getrandbits(16)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in name.rstrip(".").split("."))
    packet = struct.pack("!6H", qid, 0x0100, 1, 0, 0, 0) + qname + b"\0" + struct.pack("!2H", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(packet, (server or resolver(), port or DNS_PORT))
        data = sock.recv(4096)
    rid, flags, qdcount, ancount = struct.unpack("!4H", data[:8])
    if rid != qid:
        raise ValueError("response id does not match the query")
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


def fetch(method: str, url: str, body: str | None = None, max_hops: int = MAX_HOPS) -> list:
    """Send one request and follow redirects; one hop per response, or an error ends the trace."""
    hops = []
    for _ in range(max_hops):
        parts = urllib.parse.urlsplit(url)
        hop = {"method": method, "url": url}
        hops.append(hop)
        try:
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
    return hops


def handler(event: dict, _context=None) -> dict:
    out = {"region": os.environ["AWS_REGION"], "resolver": resolver()}
    if "requests" in event:
        out["traces"] = [fetch(r["method"], r["url"], r.get("body")) for r in event["requests"][:MAX_REQUESTS]]
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
