import base64
import json
import logging

import pytest
from botocore.exceptions import ReadTimeoutError

import ingest_app
from fakes import APP_NAMES, REGIONAL_NAMES, SECRET, FakeDynamoDB, alb_event, client_error, invoke, request_body

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


def test_a_write_lands_in_its_own_regions_replica_and_reads_back_in_the_other_once_replicated(table, monkeypatch):
    replicas = {"us-east-1": table, "us-east-2": FakeDynamoDB()}
    replicas["us-east-2"].home("cust-001", "us-east-1")

    def run(region, path, body):
        monkeypatch.setattr(ingest_app, "_dynamodb", replicas[region])
        return invoke(ingest_app, region, alb_event("POST", path, HOME, body), monkeypatch)

    response, wrote = run("us-east-1", "/write", request_body(customerId="cust-001", key="demo", value={"note": "hi"}))
    assert (response["statusCode"], wrote["writtenIn"], wrote["key"]) == (200, "us-east-1", "demo")
    assert ("cust-001", "item#demo") in replicas["us-east-1"].items
    assert ("cust-001", "item#demo") not in replicas["us-east-2"].items  # each Region's app touches its own replica only
    # After a drain of us-east-1, the home Region name answers with us-east-2's ALB. Until the global table
    # has replicated the write, the app there finds nothing.
    assert run("us-east-2", "/read", request_body(customerId="cust-001", key="demo"))[0]["statusCode"] == 404
    replicas["us-east-2"].items.update(replicas["us-east-1"].items)  # what the global table does, asynchronously
    response, read = run("us-east-2", "/read", request_body(customerId="cust-001", key="demo"))
    assert response["statusCode"] == 200
    assert (read["value"], read["writtenIn"], read["servedBy"]) == ({"note": "hi"}, "us-east-1", "us-east-2")
    reads = [c for replica in replicas.values() for c in replica.calls if c[0] == "get_item"]
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
    upper = call("us-east-1", "/read", request_body(customerId="cust-001"), host="INGEST.UE1.EXAMPLE.COM:80")
    assert upper[0]["statusCode"] == 200
    response, _ = call("us-east-1", "/read", request_body(customerId="cust-001"), host=APP_NAMES["us-east-1"],
                       **{"x-forwarded-proto": "https"})
    assert response["headers"]["Location"] == f"https://{HOME}/read"


@pytest.mark.parametrize("host", ["ingest.ue1.example.com.", "INGEST.UE1.EXAMPLE.COM.:80"])
def test_the_guard_serves_the_home_region_name_written_with_a_trailing_dot(call, host):
    # A client that pins this Host header would otherwise be redirected to the dotless name on every request.
    assert call("us-east-1", "/read", request_body(customerId="cust-001"), host=host)[0]["statusCode"] == 200


def test_the_guard_strips_one_trailing_dot_only(call):
    response, _ = call("us-east-1", "/read", request_body(customerId="cust-001"), host="ingest.ue1.example.com..")
    assert (response["statusCode"], response["headers"]["Location"]) == (307, f"http://{HOME}/read")


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


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
def test_a_405_names_the_allowed_method(call, method):
    response, _ = call("us-east-1", "/read", request_body(customerId="cust-001"), method)
    assert (response["statusCode"], response["headers"]["Allow"]) == (405, "POST")


def test_an_unknown_customer_gets_404_on_any_name(call):
    assert call("us-east-2", "/read", request_body(customerId="cust-404"), host="anything")[0]["statusCode"] == 404


def test_decodes_a_base64_body(call, table, monkeypatch):
    event = alb_event("POST", "/write", HOME, base64.b64encode(
        request_body(customerId="cust-001", key="b64", value="plain text").encode()).decode())
    event["isBase64Encoded"] = True
    invoke(ingest_app, "us-east-1", event, monkeypatch)
    assert table.items[("cust-001", "item#b64")]["value"]["S"] == '"plain text"'


@pytest.mark.parametrize("base64_encoded", [False, True])
@pytest.mark.parametrize("body", ["[" * 100_000, '{"customerId": "cust-001", "key": "k", "value": ' + "[" * 100_000],
                         ids=["nested arrays", "nested arrays in a value"])
def test_a_body_nested_too_deeply_for_the_json_parser_gets_400(table, monkeypatch, body, base64_encoded):
    # json.loads raises RecursionError, not ValueError; unhandled, the ALB would answer 502.
    monkeypatch.setattr(ingest_app, "_dynamodb", table)
    event = alb_event("POST", "/write", HOME, base64.b64encode(body.encode()).decode() if base64_encoded else body)
    event["isBase64Encoded"] = base64_encoded
    response, _ = invoke(ingest_app, "us-east-1", event, monkeypatch)
    assert response["statusCode"] == 400
    assert table.calls == []


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "[1, NaN]", '{"a": Infinity}',
                                   "1e999", "-1e999", "[0, 1e999]"])
def test_a_value_that_strict_json_parsers_reject_gets_400_and_is_not_stored(call, table, value):
    # The last three are infinities that json.loads builds from a number too large for a float.
    response, answer = call("us-east-1", "/write", '{"customerId": "cust-001", "key": "n", "value": ' + value + "}")
    assert response["statusCode"] == 400
    assert ("cust-001", "item#n") not in table.items
    assert "put_item" not in [c[0] for c in table.calls]


@pytest.mark.parametrize("path", ["/read", "/write"])
@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_a_body_with_nan_or_infinity_anywhere_gets_400(call, table, path, constant):
    # Even in a field the app ignores: the body is not JSON, and the parser says so before anything is read from it.
    body = '{"customerId": "cust-001", "key": "n", "value": 1, "note": ' + constant + "}"
    assert call("us-east-1", path, body)[0]["statusCode"] == 400
    assert table.calls == []


def test_a_value_with_a_lone_surrogate_gets_400_and_is_not_stored(call, table):
    # Valid JSON, but not text that UTF-8 can hold; measuring its size must not raise.
    response, _ = call("us-east-1", "/write", '{"customerId": "cust-001", "key": "s", "value": "\\ud800"}')
    assert response["statusCode"] == 400
    assert ("cust-001", "item#s") not in table.items


@pytest.mark.parametrize("value,status", [
    pytest.param("x" * 1022, 200, id="1024 bytes of ASCII with the quotes"),
    pytest.param("x" * 1023, 413, id="1025 bytes of ASCII"),
    pytest.param("\u00e9" * 511, 200, id="511 two-byte characters"),
    pytest.param("\u00e9" * 512, 413, id="512 two-byte characters, 1026 bytes"),
    pytest.param("\U0001F600" * 255, 200, id="255 four-byte characters"),
    pytest.param("\U0001F600" * 256, 413, id="256 four-byte characters"),
])
def test_the_1_kb_cap_counts_the_utf8_bytes_of_the_value(call, table, value, status):
    response, _ = call("us-east-1", "/write", request_body(customerId="cust-001", key="big", value=value))
    assert response["statusCode"] == status
    assert (("cust-001", "item#big") in table.items) == (status == 200)


def test_a_stored_value_is_utf8_json_and_reads_back(call, table):
    value = {"note": "caf\u00e9 \U0001F600"}
    call("us-east-1", "/write", request_body(customerId="cust-001", key="u", value=value))
    assert table.items[("cust-001", "item#u")]["value"]["S"] == json.dumps(value, ensure_ascii=False)
    assert call("us-east-1", "/read", request_body(customerId="cust-001", key="u"))[1]["value"] == value


def test_a_profile_without_a_home_region_is_an_error_on_any_name(call, table):
    table.no_home("cust-004")
    response, answer = call("us-east-1", "/read", request_body(customerId="cust-004"), host="anything")
    assert response["statusCode"] == 500
    assert "no home Region" in answer["error"]
    assert "Location" not in response["headers"]


@pytest.mark.parametrize("path,operation,nth,body", [
    ("/read", "get_item", 1, request_body(customerId="cust-001")),  # the profile
    ("/read", "get_item", 2, request_body(customerId="cust-001", key="demo")),  # the item
    ("/write", "put_item", 1, request_body(customerId="cust-001", key="demo", value=1)),  # the write
])
@pytest.mark.parametrize("error,shown", [
    (client_error("ThrottlingException"), "ThrottlingException"),
    (ReadTimeoutError(endpoint_url="https://dynamodb.us-east-1.amazonaws.com/"), "ReadTimeoutError"),
])
def test_a_table_error_gets_503_with_the_reason_and_the_responder(call, table, path, operation, nth, body, error, shown):
    table.fail(error, operation, nth)
    response, answer = call("us-east-1", path, body)
    assert response["statusCode"] == 503
    assert response["headers"]["Content-Type"] == "application/json"
    assert (answer["servedBy"], shown in answer["error"]) == ("us-east-1", True)
    assert ("cust-001", "item#demo") not in table.items


def test_the_full_error_message_goes_to_the_log_and_only_the_code_to_the_client(call, table, caplog):
    table.fail(client_error("AccessDeniedException"))  # its message names the role
    with caplog.at_level(logging.WARNING, logger="ingest_app"):
        response, _ = call("us-east-1", "/read", request_body(customerId="cust-001"))
    assert SECRET not in response["body"]
    assert SECRET in caplog.text
