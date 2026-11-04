"""The router's answer fed to the app's guard, with the real handlers of both and one environment."""
from urllib.parse import urlsplit

import pytest

import ingest_app
import router
from fakes import APP_NAMES, REGION_LESS, REGIONAL_NAMES, alb_event, invoke, request_body


@pytest.fixture
def both(table, monkeypatch):
    table.home("cust-002", "us-east-2")
    monkeypatch.setattr(router, "_dynamodb", table)
    monkeypatch.setattr(ingest_app, "_dynamodb", table)


def body_for(customer, path):
    """A read of the customer's home Region, or a write of one item."""
    return request_body(customerId=customer) if path == "/read" else request_body(customerId=customer, key="k", value=1)


def redirect_of(customer, path, monkeypatch):
    """The Location the router in us-east-2 answers a request for customer on the region-less name with."""
    response, _ = invoke(router, "us-east-2", alb_event("POST", path, REGION_LESS, body_for(customer, path)), monkeypatch)
    assert response["statusCode"] == 307
    return urlsplit(response["headers"]["Location"])


@pytest.mark.parametrize("serving_region", ["us-east-1", "us-east-2"])  # DNS sends a home Region name to either ALB
@pytest.mark.parametrize("customer,home", [("cust-001", "us-east-1"), ("cust-002", "us-east-2")])
@pytest.mark.parametrize("path", ["/read", "/write"])
def test_the_app_serves_the_name_the_router_redirects_to(both, monkeypatch, path, customer, home, serving_region):
    target = redirect_of(customer, path, monkeypatch)
    assert target.netloc == REGIONAL_NAMES[home]
    # The client repeats the request, body included, on the name it was sent to.
    event = alb_event("POST", target.path, target.netloc, body_for(customer, path))
    response, answer = invoke(ingest_app, serving_region, event, monkeypatch)
    assert response["statusCode"] == 200
    assert (answer["homeRegion"], answer["servedBy"]) == (home, serving_region)


@pytest.mark.parametrize("other_name", [REGION_LESS, REGIONAL_NAMES["us-east-2"], *APP_NAMES.values()])
def test_a_request_the_guard_turns_away_is_sent_to_the_name_the_router_uses(both, monkeypatch, other_name):
    routed = redirect_of("cust-001", "/read", monkeypatch)
    event = alb_event("POST", "/read", other_name, request_body(customerId="cust-001"))
    response, _ = invoke(ingest_app, "us-east-2", event, monkeypatch)
    assert response["statusCode"] == 307
    assert urlsplit(response["headers"]["Location"]) == routed
