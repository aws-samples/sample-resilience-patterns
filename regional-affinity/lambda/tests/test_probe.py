"""The probe against a fake resolver and a fake ALB, both on 127.0.0.1."""
import http.server
import json
import socket
import struct
import threading

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


class FakeResolver:
    """Answers each UDP query on 127.0.0.1 with respond(query) -> response bytes."""

    def __init__(self, respond):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(5)
        self.port = self.sock.getsockname()[1]
        self.queries = []
        self.respond = respond
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.running = True
        self.thread.start()

    def serve(self):
        while self.running:
            try:
                data, peer = self.sock.recvfrom(512)
            except OSError:
                return
            self.queries.append(data)
            self.sock.sendto(self.respond(data), peer)

    def close(self):
        self.running = False
        self.sock.close()


@pytest.fixture
def resolver(monkeypatch):
    """Point the probe's queries at a fake resolver; call the fixture with a respond function."""
    servers = []
    real_query = probe.query

    def start(respond=loopback):
        server = FakeResolver(respond)
        servers.append(server)
        monkeypatch.setattr(probe, "query", lambda name, **kw: real_query(name, server="127.0.0.1", port=server.port))
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
    """Answers the region-less name like the router (307 to the ue1 name) and any other name like the app."""

    seen: list = []

    def handle_any(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else None
        host = self.headers["Host"]
        FakeAlb.seen.append((self.command, host, self.path, body))
        if host == "ingest.example.com":
            status, headers = 307, {"Location": f"http://ingest.ue1.example.com{self.path}", "X-Served-By": "router us-east-2"}
            payload = {"customerId": "cust-001", "homeRegion": "us-east-1"}
        elif host == "see-other.example.com" and self.path == "/start":
            status, headers, payload = 303, {"Location": "/done", "X-Served-By": "router us-east-2"}, {}
        else:
            status, headers, payload = 200, {"X-Served-By": "app us-east-1"}, {"echo": body, "method": self.command}
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
    threading.Thread(target=server.serve_forever, daemon=True).start()
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


def test_a_303_switches_to_get_without_the_body(resolver, alb):
    resolver()
    hops = probe.fetch("POST", "http://see-other.example.com/start", "{}")
    assert hops[-1]["url"] == "http://see-other.example.com/done"
    assert [(m, b) for m, _, _, b in FakeAlb.seen] == [("POST", "{}"), ("GET", None)]


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


def test_handler_returns_one_trace_per_request(resolver, alb, monkeypatch):
    monkeypatch.setenv("VPC_CIDR", "10.12.0.0/16")
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    resolver()
    out = probe.handler({"requests": [{"method": "GET", "url": "http://ingest.example.com/a"},
                                      {"method": "GET", "url": "http://ingest.ue1.example.com/b"}]})
    assert [len(t) for t in out["traces"]] == [2, 1]
    assert "results" not in out
