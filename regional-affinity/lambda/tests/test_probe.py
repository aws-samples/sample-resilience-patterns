"""The probe against a fake resolver and a fake ALB, both on 127.0.0.1."""
import http.server
import json
import socket
import struct
import threading
import time
import types

import pytest

import probe


def encode_name(name: str) -> bytes:
    return b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0"


def answer(rtype: int, ttl: int, rdata: bytes) -> bytes:
    return b"\xc0\x0c" + struct.pack("!2HIH", rtype, 1, ttl, len(rdata)) + rdata  # name: pointer to the question


def reply(query: bytes, flags: int, answers: list) -> bytes:
    return query[:2] + struct.pack("!5H", flags, 1, len(answers), 0, 0) + query[12:] + b"".join(answers)


def loopback(query: bytes) -> bytes:
    return reply(query, 0x8180, [answer(1, 60, socket.inet_aton("127.0.0.1"))])


def truncated(query: bytes) -> bytes:
    """An answer with the TC flag set that carries an address no test can reach."""
    return reply(query, 0x8380, [answer(1, 60, socket.inet_aton("10.255.255.1"))])


def lose(count: int, then=loopback):
    """A respond function that drops its first count queries, then answers with then."""
    seen = []

    def respond(query):
        seen.append(query)
        return None if len(seen) <= count else then(query)

    return respond


def bind_pair():
    """A UDP and a TCP socket bound to the same port on 127.0.0.1, as a resolver has them."""
    for _ in range(50):
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.bind(("127.0.0.1", 0))
        tcp = socket.socket()
        try:
            tcp.bind(("127.0.0.1", udp.getsockname()[1]))
        except OSError:  # something holds that TCP port; take another UDP port
            udp.close()
            tcp.close()
            continue
        return udp, tcp
    raise RuntimeError("no UDP and TCP port pair is free on 127.0.0.1")


class FakeResolver:
    """Answers each query on 127.0.0.1 with respond(query) -> response bytes, or drops it when that is None.

    With tcp_respond it also answers over TCP on the same port (a two-byte length, then the message).
    Without it the TCP port is reserved but refuses connections."""

    def __init__(self, respond, tcp_respond=None):
        self.sock, self.tcp = bind_pair()
        self.sock.settimeout(5)
        self.port = self.sock.getsockname()[1]
        self.queries, self.tcp_queries = [], []
        self.respond, self.tcp_respond = respond, tcp_respond
        self.running = True
        threading.Thread(target=self.serve, daemon=True).start()
        if tcp_respond:
            self.tcp.listen(5)
            self.tcp.settimeout(5)
            threading.Thread(target=self.serve_tcp, daemon=True).start()

    def serve(self):
        while self.running:
            try:
                data, peer = self.sock.recvfrom(512)
            except OSError:
                return
            self.queries.append(data)
            response = self.respond(data)
            if response is not None:
                self.sock.sendto(response, peer)

    def serve_tcp(self):
        while self.running:
            try:
                conn, _ = self.tcp.accept()
            except OSError:
                return
            with conn:
                conn.settimeout(5)
                size = struct.unpack("!H", conn.recv(2))[0]
                data = b""
                while len(data) < size:
                    data += conn.recv(size - len(data))
                self.tcp_queries.append(data)
                response = self.tcp_respond(data)
                conn.sendall(struct.pack("!H", len(response)) + response)

    def close(self):
        self.running = False
        self.sock.close()
        self.tcp.close()


@pytest.fixture
def resolver(monkeypatch):
    """Point the probe's queries at a fake resolver; call the fixture with a respond function.

    Other keyword arguments, such as timeout, are passed to every query the probe makes."""
    servers = []
    real_query = probe.query

    def start(respond=loopback, tcp_respond=None, **options):
        server = FakeResolver(respond, tcp_respond)
        servers.append(server)
        monkeypatch.setattr(probe, "query", lambda name, **kw: real_query(
            name, **{"server": "127.0.0.1", "port": server.port, **options, **kw}))
        return server

    yield start
    for server in servers:
        server.close()


def test_the_resolver_is_the_vpc_base_plus_two(monkeypatch):
    monkeypatch.setenv("VPC_CIDR", "10.11.0.0/16")
    assert probe.resolver() == "10.11.0.2"


def test_query_parses_a_records_and_skips_other_types(resolver):
    cname = answer(5, 300, encode_name("internal-x.us-east-2.elb.amazonaws.com"))
    a1 = answer(1, 42, socket.inet_aton("10.12.1.20"))
    a2 = answer(1, 37, socket.inet_aton("10.12.0.9"))
    server = resolver(lambda q: reply(q, 0x8180, [cname, a1, a2]))
    assert probe.query("ingest.ue2.example.com") == {"rcode": "NOERROR", "ttl": 37, "addresses": ["10.12.0.9", "10.12.1.20"]}
    sent = server.queries[0]
    assert struct.unpack("!H", sent[2:4])[0] & 0x0100 == 0x0100  # recursion desired
    assert sent[12:] == encode_name("ingest.ue2.example.com") + struct.pack("!2H", 1, 1)


def test_query_reports_nxdomain(resolver):
    resolver(lambda q: reply(q, 0x8183, []))
    assert probe.query("nope.example.com") == {"rcode": "NXDOMAIN", "ttl": None, "addresses": []}


def test_query_rejects_a_response_for_another_query(resolver):
    def wrong_id(q):
        other_id = (struct.unpack("!H", q[:2])[0] + 1) & 0xFFFF
        return struct.pack("!H", other_id) + reply(q, 0x8180, [])[2:]

    resolver(wrong_id)
    with pytest.raises(ValueError):
        probe.query("ingest.example.com")


def test_a_lost_query_is_sent_once_more(resolver):
    server = resolver(lose(1))
    assert probe.query("ingest.example.com", timeout=0.3)["addresses"] == ["127.0.0.1"]
    assert len(server.queries) == 2 and server.queries[0] == server.queries[1]  # the same datagram, id included


def test_a_query_that_is_lost_twice_fails_after_two_attempts(resolver):
    server = resolver(lose(5))
    with pytest.raises(socket.timeout):
        probe.query("ingest.example.com", timeout=0.2)
    for _ in range(100):  # the server thread may still be reading the second datagram
        if len(server.queries) >= 2:
            break
        time.sleep(0.02)
    time.sleep(0.1)  # and a third would show up by now
    assert len(server.queries) == 2


def test_a_truncated_answer_is_asked_again_over_tcp(resolver):
    full = [answer(1, ttl, socket.inet_aton(address))
            for ttl, address in ((30, "127.0.0.3"), (45, "127.0.0.1"), (40, "127.0.0.2"))]
    server = resolver(truncated, tcp_respond=lambda q: reply(q, 0x8180, full))
    assert probe.query("ingest.example.com") == {"rcode": "NOERROR", "ttl": 30,
                                                 "addresses": ["127.0.0.1", "127.0.0.2", "127.0.0.3"]}
    assert len(server.queries) == 1 and server.tcp_queries == server.queries  # the same query, in a TCP message


def test_a_truncated_answer_is_never_read_as_a_shorter_list(resolver):
    resolver(truncated)  # the resolver refuses TCP
    with pytest.raises(OSError):
        probe.query("ingest.example.com")


def test_a_tcp_answer_for_another_query_is_rejected(resolver):
    def wrong_id(q):
        other_id = (struct.unpack("!H", q[:2])[0] + 1) & 0xFFFF
        return struct.pack("!H", other_id) + reply(q, 0x8180, [])[2:]

    resolver(truncated, tcp_respond=wrong_id)
    with pytest.raises(ValueError):
        probe.query("ingest.example.com")


def test_handler_samples_every_name(resolver, monkeypatch):
    monkeypatch.setenv("VPC_CIDR", "10.12.0.0/16")
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    resolver(lambda q: reply(q, 0x8180, [answer(1, 60, socket.inet_aton("10.11.0.5"))]))
    names = ["ingest.example.com", "ingest.ue1.example.com"]
    out = probe.handler({"names": names, "samples": 3, "interval": 0})
    assert (out["region"], out["resolver"]) == ("us-east-2", "10.12.0.2")
    assert {n: len(v) for n, v in out["results"].items()} == {n: 3 for n in names}
    assert all(s["addresses"] == ["10.11.0.5"] for v in out["results"].values() for s in v)


class FakeAlb(http.server.BaseHTTPRequestHandler):
    """Answers the region-less name like the router (307 to the ue1 name) and any other name like the app.

    The other names are the cases a redirect chain can take:
      see-other      303 to /done
      permanent      308 to the ue1 name
      secure         307 to an https URL
      loop           307 to itself, forever
      chain          /<n>/<last>: 307 to /<n+1>/<last> until n reaches last, then 200
    """

    seen: list = []

    def answer(self, host, body):
        """(status, headers, payload) for a request to host."""
        router = {"X-Served-By": "router us-east-2"}
        if host == "ingest.example.com":
            location = f"http://ingest.ue1.example.com{self.path}"
            return 307, {"Location": location, **router}, {"customerId": "cust-001", "homeRegion": "us-east-1"}
        if host == "see-other.example.com" and self.path == "/start":
            return 303, {"Location": "/done", **router}, {}
        if host == "permanent.example.com":
            return 308, {"Location": f"http://ingest.ue1.example.com{self.path}", **router}, {}
        if host == "secure.example.com":
            return 307, {"Location": "https://ingest.ue1.example.com/read", **router}, {}
        if host == "loop.example.com":
            return 307, {"Location": "http://loop.example.com/again", **router}, {}
        if host == "chain.example.com":
            number, last = (int(n) for n in self.path.strip("/").split("/"))
            if number < last:
                return 307, {"Location": f"/{number + 1}/{last}", **router}, {}
        return 200, {"X-Served-By": "app us-east-1"}, {"echo": body, "method": self.command}

    def handle_any(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else None
        host = self.headers["Host"]
        FakeAlb.seen.append((self.command, host, self.path, body))
        status, headers, payload = self.answer(host, body)
        data = json.dumps(payload).encode()
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_PUT = do_POST = handle_any

    def log_message(self, *args):
        pass


@pytest.fixture
def alb(monkeypatch):
    FakeAlb.seen = []
    server = http.server.HTTPServer(("127.0.0.1", 0), FakeAlb)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()  # a quick shutdown
    monkeypatch.setattr(probe, "HTTP_PORT", server.server_address[1])
    yield server
    server.shutdown()
    server.server_close()


def test_a_get_follows_the_redirect_to_the_home_region_name(resolver, alb):
    resolver()
    hops = probe.fetch("GET", "http://ingest.example.com/read")
    assert [(h["status"], h["servedBy"]) for h in hops] == [(307, "router us-east-2"), (200, "app us-east-1")]
    assert hops[1]["url"] == "http://ingest.ue1.example.com/read"
    assert hops[0]["address"] == "127.0.0.1"
    assert hops[0]["body"]["homeRegion"] == "us-east-1"
    assert [(m, h) for m, h, _, _ in FakeAlb.seen] == [("GET", "ingest.example.com"), ("GET", "ingest.ue1.example.com")]


def test_a_post_repeats_its_method_and_body_after_a_307(resolver, alb):
    resolver()
    body = '{"customerId": "cust-001", "key": "demo", "value": {"note": "é"}}'
    hops = probe.fetch("POST", "http://ingest.example.com/write", body)
    assert hops[-1]["body"] == {"echo": body, "method": "POST"}
    assert FakeAlb.seen == [("POST", "ingest.example.com", "/write", body), ("POST", "ingest.ue1.example.com", "/write", body)]


def test_a_post_repeats_its_method_and_body_after_a_308(resolver, alb):
    resolver()
    body = '{"customerId": "cust-001", "key": "demo", "value": 1}'
    hops = probe.fetch("POST", "http://permanent.example.com/write", body)
    assert [h["status"] for h in hops] == [308, 200]
    assert hops[-1]["body"] == {"echo": body, "method": "POST"}
    assert FakeAlb.seen == [("POST", "permanent.example.com", "/write", body), ("POST", "ingest.ue1.example.com", "/write", body)]


def test_a_303_switches_to_get_without_the_body(resolver, alb):
    resolver()
    hops = probe.fetch("POST", "http://see-other.example.com/start", "{}")
    assert hops[-1]["url"] == "http://see-other.example.com/done"
    assert [(m, b) for m, _, _, b in FakeAlb.seen] == [("POST", "{}"), ("GET", None)]


def test_a_server_that_redirects_to_itself_ends_at_the_hop_limit_with_an_error(resolver, alb):
    resolver()
    hops = probe.fetch("POST", "http://loop.example.com/start", "{}")
    assert [h["status"] for h in hops] == [307] * probe.MAX_HOPS == [307, 307, 307]
    assert [h.get("error") for h in hops] == [None, None, "too many redirects"]
    assert len(FakeAlb.seen) == 3  # and no fourth request


def test_a_chain_that_ends_in_an_answer_at_the_hop_limit_is_not_too_many_redirects(resolver, alb):
    resolver()
    hops = probe.fetch("GET", "http://chain.example.com/1/3")
    assert [h["status"] for h in hops] == [307, 307, 200]
    assert not any("error" in h for h in hops)


def test_a_chain_one_hop_too_long_is_too_many_redirects(resolver, alb):
    resolver()
    hops = probe.fetch("GET", "http://chain.example.com/1/4")
    assert [h["status"] for h in hops] == [307, 307, 307]
    assert hops[-1]["error"] == "too many redirects"


def test_a_refused_connection_ends_the_trace(resolver, monkeypatch):
    resolver()
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    monkeypatch.setattr(probe, "HTTP_PORT", closed.getsockname()[1])
    closed.close()
    hops = probe.fetch("GET", "http://ingest.example.com/read")
    assert len(hops) == 1 and "Connection" in hops[0]["error"]


def test_a_missing_name_ends_the_trace(resolver):
    resolver(lambda q: reply(q, 0x8183, []))
    assert probe.fetch("GET", "http://nope.example.com/") == [
        {"method": "GET", "url": "http://nope.example.com/", "error": "NXDOMAIN: no address for nope.example.com"}]


def test_a_dns_query_that_is_lost_twice_ends_the_trace(resolver):
    resolver(lose(10), timeout=0.2)
    hops = probe.fetch("GET", "http://ingest.example.com/read")
    assert len(hops) == 1 and "timed out" in hops[0]["error"]


def test_a_lost_dns_query_does_not_fail_the_request(resolver, alb):
    resolver(lose(1), timeout=0.3)
    hops = probe.fetch("GET", "http://ingest.example.com/read")
    assert [h["status"] for h in hops] == [307, 200]


def test_a_truncated_dns_answer_is_completed_over_tcp_before_connecting(resolver, alb):
    resolver(truncated, tcp_respond=lambda q: reply(q, 0x8180, [answer(1, 60, socket.inet_aton("127.0.0.1"))]))
    hops = probe.fetch("GET", "http://ingest.example.com/read")
    assert hops[0]["address"] == "127.0.0.1"  # the UDP answer's only address could not be reached
    assert [h["status"] for h in hops] == [307, 200]


@pytest.mark.parametrize("url,problem", [
    ("https://ingest.example.com/read", "only http URLs are fetched, not https"),
    ("ftp://ingest.example.com/read", "only http URLs are fetched, not ftp"),
    ("ingest.example.com/read", "not a URL without a scheme"),
    ("//ingest.example.com/read", "not a URL without a scheme"),
    ("file:///etc/passwd", "not file"),
    ("", "not a URL without a scheme"),
    ("http:///read", "no host"),
    ("http://", "no host"),
    ("http://[::1/read", "Invalid IPv6 URL"),
])
def test_a_url_the_probe_cannot_fetch_ends_the_trace_with_an_error(resolver, alb, url, problem):
    server = resolver()
    hops = probe.fetch("GET", url)
    assert len(hops) == 1 and problem in hops[0]["error"]
    assert "address" not in hops[0]
    assert server.queries == [] and FakeAlb.seen == []  # nothing was resolved and nothing was connected to


def test_a_redirect_to_an_https_url_is_not_followed_in_the_clear(resolver, alb):
    resolver()
    hops = probe.fetch("GET", "http://secure.example.com/start")
    assert [h.get("status") for h in hops] == [307, None]
    assert "only http URLs" in hops[1]["error"] and hops[1]["url"] == "https://ingest.ue1.example.com/read"
    assert len(FakeAlb.seen) == 1


def test_a_url_without_a_scheme_in_a_payload_is_an_error_in_its_trace(resolver, alb, monkeypatch):
    monkeypatch.setenv("VPC_CIDR", "10.12.0.0/16")
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    resolver()
    out = probe.handler({"requests": [{"method": "GET", "url": "ingest.example.com/read"},
                                      {"method": "GET", "url": "http://ingest.ue1.example.com/b"}]})
    assert "only http URLs" in out["traces"][0][0]["error"]
    assert out["traces"][1][0]["status"] == 200  # the other request still ran


def test_handler_returns_one_trace_per_request(resolver, alb, monkeypatch):
    monkeypatch.setenv("VPC_CIDR", "10.12.0.0/16")
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    resolver()
    out = probe.handler({"requests": [{"method": "GET", "url": "http://ingest.example.com/a"},
                                      {"method": "GET", "url": "http://ingest.ue1.example.com/b"}]})
    assert [len(t) for t in out["traces"]] == [2, 1]
    assert "results" not in out


class Clock:
    """A monotonic clock that moves 4 s every time it is read."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        self.now += 4.0
        return self.now


def context(remaining_ms: int):
    return types.SimpleNamespace(get_remaining_time_in_millis=lambda: remaining_ms)


REQUESTS = [{"method": "GET", "url": "http://ingest.example.com/a"}, {"method": "GET", "url": "http://ingest.ue1.example.com/b"}]


@pytest.fixture
def invocation(resolver, alb, monkeypatch):
    monkeypatch.setenv("VPC_CIDR", "10.12.0.0/16")
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    return resolver()


def test_with_a_full_budget_every_hop_is_sent(invocation):
    out = probe.handler({"requests": REQUESTS}, context(60_000))
    assert [[h["status"] for h in trace] for trace in out["traces"]] == [[307, 200], [200]]


@pytest.mark.parametrize("remaining_ms", [7_000, 8_000])
def test_with_eight_seconds_or_less_left_no_hop_starts(invocation, remaining_ms):
    out = probe.handler({"requests": REQUESTS}, context(remaining_ms))
    assert [[(h["method"], h["url"]) for h in trace] for trace in out["traces"]] == [
        [("GET", "http://ingest.example.com/a")], [("GET", "http://ingest.ue1.example.com/b")]]
    assert all("not sent" in h["error"] for trace in out["traces"] for h in trace)
    assert invocation.queries == [] and FakeAlb.seen == []


def test_a_chain_in_progress_stops_when_the_time_runs_low_and_the_traces_so_far_come_back(invocation, monkeypatch):
    # The clock reads 4 s (the deadline: 16 - 8 s later = 12 s), 8 s (hop 1 may start), 12 s (hop 2 may not).
    monkeypatch.setattr(probe, "time", types.SimpleNamespace(monotonic=Clock(), sleep=lambda s: None))
    out = probe.handler({"requests": REQUESTS}, context(16_000))
    first, second = out["traces"]
    assert [h.get("status") for h in first] == [307, None]
    assert first[1]["url"] == "http://ingest.ue1.example.com/a" and "not sent" in first[1]["error"]
    assert [h.get("status") for h in second] == [None] and "not sent" in second[0]["error"]
    assert len(FakeAlb.seen) == 1  # only the first hop of the first request went out
