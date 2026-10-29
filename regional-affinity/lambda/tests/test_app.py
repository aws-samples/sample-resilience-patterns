import base64

import pytest

import ingest_app
from fakes import APP_NAMES, REGIONAL_NAMES, alb_event, invoke, request_body

HOME = REGIONAL_NAMES["us-east-1"]  # cust-001's home Region name


@pytest.fixture
def call(table, monkeypatch):
    monkeypatch.setattr(ingest_app, "_dynamodb", table)

    def run(region, path, body, method="POST", host=HOME, **headers):
        response, answer = invoke(ingest_app, region, alb_event(method, path, host, body, **headers), monkeypatch)
        assert response["headers"]["X-Served-By"] == f"app {region}"
        return response, answer

    return run


def test_a_read_without_a_key_reports_the_home_region_and_who_served(call):
    response, answer = call("us-east-1", "/read", request_body(customerId="cust-001"))
    assert (response["statusCode"], answer) == (200, {"customerId": "cust-001", "homeRegion": "us-east-1",
                                                      "servedBy": "us-east-1"})


def test_a_write_in_one_region_reads_back_in_the_other(call, table):
    response, wrote = call("us-east-1", "/write", request_body(customerId="cust-001", key="demo", value={"note": "hi"}))
    assert (response["statusCode"], wrote["writtenIn"], wrote["key"]) == (200, "us-east-1", "demo")
    # After a drain of us-east-1, the home Region name answers with us-east-2's ALB.
    response, read = call("us-east-2", "/read", request_body(customerId="cust-001", key="demo"))
    assert response["statusCode"] == 200
    assert (read["value"], read["writtenIn"], read["servedBy"]) == ({"note": "hi"}, "us-east-1", "us-east-2")
    reads = [c for c in table.calls if c[0] == "get_item"]
    assert reads and all(consistent for _, _, consistent in reads)


@pytest.mark.parametrize("host", [REGIONAL_NAMES["us-east-2"], APP_NAMES["us-east-1"], APP_NAMES["us-east-2"],
                                  "10.11.0.20", "", None])
@pytest.mark.parametrize("path", ["/read", "/write"])
def test_the_guard_redirects_any_other_name_to_the_home_region_name(call, table, host, path):
    body = request_body(customerId="cust-001", key="demo", value={"note": "elsewhere"})
    response, answer = call("us-east-2", path, body, host=host)
    assert response["statusCode"] == 307
    assert response["headers"]["Location"] == f"http://{HOME}{path}"
    assert response["headers"]["Cache-Control"] == "no-store"
    assert (answer["homeRegion"], answer["servedBy"]) == ("us-east-1", "us-east-2")
    assert ("cust-001", "item#demo") not in table.items  # a redirected write writes nothing


def test_the_guard_ignores_a_port_and_case_in_the_host_and_keeps_the_scheme(call):
    assert call("us-east-1", "/read", request_body(customerId="cust-001"), host="INGEST.UE1.DEMO.IO:80")[0]["statusCode"] == 200
    response, _ = call("us-east-1", "/read", request_body(customerId="cust-001"), host=APP_NAMES["us-east-1"],
                       **{"x-forwarded-proto": "https"})
    assert response["headers"]["Location"] == f"https://{HOME}/read"


def test_the_guard_does_not_loop_the_home_region_name_is_always_served(call):
    for region in ("us-east-1", "us-east-2"):  # whichever ALB DNS sends the home Region name to
        assert call(region, "/read", request_body(customerId="cust-001"))[0]["statusCode"] == 200


@pytest.mark.parametrize("path,body,method,status", [
    ("/read", request_body(customerId="cust-001", key="none"), "POST", 404),
    ("/read", request_body(customerId="cust-404"), "POST", 404),
    ("/read", request_body(customerId="cust-001"), "GET", 405),
    ("/nope", request_body(customerId="cust-001"), "POST", 404),
    ("/read", "not json", "POST", 400),
    ("/read", request_body(key="demo"), "POST", 400),
    ("/read", request_body(customerId="cust-001", key="bad key!"), "POST", 400),
    ("/read", request_body(customerId="cust-001", key=7), "POST", 400),
    ("/write", request_body(customerId="cust-001", value=1), "POST", 400),
    ("/write", request_body(customerId="cust-001", key="demo"), "POST", 400),
    ("/write", request_body(customerId="cust-001", key="big", value="x" * 2000), "POST", 413),
])
def test_missing_items_unknown_customers_and_bad_requests(call, table, path, body, method, status):
    assert call("us-east-1", path, body, method)[0]["statusCode"] == status
    assert ("cust-001", "item#big") not in table.items


def test_an_unknown_customer_gets_404_on_any_name(call):
    assert call("us-east-2", "/read", request_body(customerId="cust-404"), host="anything")[0]["statusCode"] == 404


def test_decodes_a_base64_body(call, table, monkeypatch):
    event = alb_event("POST", "/write", HOME, base64.b64encode(
        request_body(customerId="cust-001", key="b64", value="plain text").encode()).decode())
    event["isBase64Encoded"] = True
    invoke(ingest_app, "us-east-1", event, monkeypatch)
    assert table.items[("cust-001", "item#b64")]["value"]["S"] == '"plain text"'
