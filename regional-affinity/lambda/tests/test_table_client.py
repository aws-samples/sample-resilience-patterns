"""The DynamoDB client both functions build, with the real boto3 (these tests are skipped when it is not installed)."""
import socket

import pytest

import ingest_app
import router
from fakes import REGION_LESS, alb_event, invoke, request_body

MODULES = pytest.mark.parametrize("module", [router, ingest_app], ids=lambda module: module.__name__)


@MODULES
def test_the_client_gives_up_inside_the_function_timeout(module, real_boto3, monkeypatch):
    # The functions time out at 10 s. A read stalls for at most read_timeout per attempt, so two attempts and
    # the backoff between them end in about 7 s, where the three attempts of max_attempts=2 take more than 10 s
    # and the ALB would answer 502 instead of the function answering 503.
    monkeypatch.setattr(module, "_dynamodb", None)
    config = module.dynamodb().meta.config
    assert (config.connect_timeout, config.read_timeout) == (2, 3)
    assert (config.retries["mode"], config.retries["total_max_attempts"]) == ("standard", 2)


@pytest.fixture
def unreachable_table(real_boto3, monkeypatch, table):
    """The real client, pointed at a local port that refuses connections."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    monkeypatch.setenv("AWS_ENDPOINT_URL_DYNAMODB", f"http://127.0.0.1:{port}")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")  # a proxy in the developer's shell would answer for the port
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    monkeypatch.setattr(router, "_dynamodb", None)
    monkeypatch.setattr(ingest_app, "_dynamodb", None)


def test_the_router_answers_503_when_the_table_cannot_be_reached(unreachable_table, monkeypatch):
    event = alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-001"))
    response, answer = invoke(router, "us-east-2", event, monkeypatch)
    assert response["statusCode"] == 503
    assert response["headers"]["X-Served-By"] == "router us-east-2"
    assert "EndpointConnectionError" in answer["error"]  # the connection was refused, not a configuration problem


def test_the_app_answers_503_when_the_table_cannot_be_reached(unreachable_table, monkeypatch):
    event = alb_event("POST", "/read", "ingest.ue1.example.com", request_body(customerId="cust-001"))
    response, answer = invoke(ingest_app, "us-east-1", event, monkeypatch)
    assert response["statusCode"] == 503
    assert response["headers"]["X-Served-By"] == "app us-east-1"
    assert answer["servedBy"] == "us-east-1"
    assert "EndpointConnectionError" in answer["error"]
