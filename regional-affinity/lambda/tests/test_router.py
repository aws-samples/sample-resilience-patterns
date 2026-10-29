import base64

import pytest

import router
from fakes import REGION_LESS, TABLE, alb_event, invoke, request_body


@pytest.fixture
def call(table, monkeypatch):
    monkeypatch.setattr(router, "_dynamodb", table)
    return lambda event, region="us-east-2": invoke(router, region, event, monkeypatch)


def test_redirects_to_the_home_region_name_of_the_customer_in_the_body(call, table):
    body = request_body(customerId="cust-001", key="demo", value={"note": "hi"})
    response, answer = call(alb_event("POST", "/write", REGION_LESS, body))
    assert response["statusCode"] == 307
    assert response["statusDescription"] == "307 Temporary Redirect"
    assert response["headers"]["Location"] == "http://ingest.ue1.example.com/write"
    assert response["headers"]["X-Served-By"] == "router us-east-2"
    assert response["headers"]["Cache-Control"] == "no-store"
    assert (answer["customerId"], answer["homeRegion"]) == ("cust-001", "us-east-1")
    assert table.calls == [("get_item", TABLE, False)]


def test_reads_a_base64_body(call):
    event = alb_event("POST", "/read", REGION_LESS, base64.b64encode(b'{"customerId": "cust-001"}').decode())
    event["isBase64Encoded"] = True
    assert call(event)[0]["headers"]["Location"] == "http://ingest.ue1.example.com/read"


def test_keeps_the_path_query_and_scheme(call):
    event = alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-001"), query={"a": "1", "b": "x%20y"})
    event["headers"]["x-forwarded-proto"] = "https"
    assert call(event)[0]["headers"]["Location"] == "https://ingest.ue1.example.com/read?a=1&b=x%20y"
    event["headers"]["x-forwarded-proto"] = "javascript"
    assert call(event)[0]["headers"]["Location"].startswith("http://ingest.ue1.")


@pytest.mark.parametrize("body", ["", "not json", "[1]", '"cust-001"', request_body(key="demo"),
                                  request_body(customerId=7), request_body(customerId="CUST-001"),
                                  request_body(customerId="cust/001"), request_body(account="cust-001")])
def test_a_body_that_names_no_valid_customer_gets_400(call, table, body):
    response, _ = call(alb_event("POST", "/read", REGION_LESS, body))
    assert response["statusCode"] == 400
    assert "Location" not in response["headers"]
    assert table.calls == []


def test_a_garbled_base64_body_gets_400(call):
    event = alb_event("POST", "/read", REGION_LESS, "%%%")
    event["isBase64Encoded"] = True
    assert call(event)[0]["statusCode"] == 400


def test_unknown_customers_get_404(call):
    assert call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-999")))[0]["statusCode"] == 404


@pytest.mark.parametrize("path", ["/read<script>", "/a b", '/"quoted"'])
def test_unsafe_paths_get_400_and_no_location(call, path):
    response, _ = call(alb_event("POST", path, REGION_LESS, request_body(customerId="cust-001")))
    assert response["statusCode"] == 400
    assert "Location" not in response["headers"]


def test_an_unknown_home_region_is_an_error_not_a_redirect(call, table):
    table.home("cust-003", "eu-west-1")
    response, _ = call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-003")))
    assert response["statusCode"] == 500
    assert "Location" not in response["headers"]
