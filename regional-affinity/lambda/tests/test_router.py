import base64
import logging
from urllib.parse import urlsplit

import pytest
from botocore.exceptions import ReadTimeoutError

import router
from fakes import REGION_LESS, SECRET, TABLE, alb_event, client_error, invoke, request_body

HOME_NAME = "ingest.ue1.example.com"  # cust-001's home Region name


@pytest.fixture
def call(table, monkeypatch):
    monkeypatch.setattr(router, "_dynamodb", table)
    return lambda event, region="us-east-2": invoke(router, region, event, monkeypatch)


def one_header_line_each(response):
    """No header value can end a header line: printable ASCII only, so no CR, LF or other control character."""
    for name, value in response["headers"].items():
        assert value.isascii() and value.isprintable(), (name, value)


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


@pytest.mark.parametrize("base64_encoded", [False, True])
@pytest.mark.parametrize("body", ["[" * 100_000, '{"customerId": "cust-001", "extra": ' + "[" * 100_000],
                         ids=["nested arrays", "nested arrays in an object"])
def test_a_body_nested_too_deeply_for_the_json_parser_gets_400(call, table, body, base64_encoded):
    # json.loads raises RecursionError, not ValueError; unhandled, the ALB would answer 502.
    event = alb_event("POST", "/read", REGION_LESS, base64.b64encode(body.encode()).decode() if base64_encoded else body)
    event["isBase64Encoded"] = base64_encoded
    response, _ = call(event)
    assert response["statusCode"] == 400
    assert "Location" not in response["headers"]
    assert table.calls == []


def test_unknown_customers_get_404(call):
    assert call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-999")))[0]["statusCode"] == 404


@pytest.mark.parametrize("path", [
    "/v1/orders/o-1:cancel", "/files/a+b.txt", "/users/@me", "/a,b", "/items;v=2", "/x!y", "/a(b)", "/a'b", "/a*b", "/a$b",
    "/a&b", "/a=b", "/ok/path_1-2.x~y%20z", "//double/slash", "/%0d%0aSet-Cookie:x"])
def test_a_valid_path_reaches_the_home_region_name_unchanged(call, path):
    # %0d%0a is the text of an encoded CR LF, which a client may send and the home Region decodes itself.
    response, _ = call(alb_event("POST", path, REGION_LESS, request_body(customerId="cust-001")))
    assert response["statusCode"] == 307
    assert response["headers"]["Location"] == f"http://{HOME_NAME}{path}"


@pytest.mark.parametrize("path,encoded", [
    ("/read<script>", "/read%3Cscript%3E"),
    ("/a b", "/a%20b"),
    ('/"quoted"', "/%22quoted%22"),
    ("/caf\u00e9", "/caf%C3%A9"),
    ("/a#frag", "/a%23frag"),
    ("/a?b", "/a%3Fb"),
    ("/a\\b", "/a%5Cb"),
    ("/a\r\nSet-Cookie: x=1", "/a%0D%0ASet-Cookie:%20x=1"),
    ("/a\rb", "/a%0Db"),
    ("/a\nb", "/a%0Ab"),
    ("/a\tb", "/a%09b"),
    ("/a\x00b", "/a%00b"),
    ("/a\x7fb", "/a%7Fb"),
])
def test_a_path_is_percent_encoded_where_it_must_be_and_cannot_end_the_header_line(call, path, encoded):
    response, answer = call(alb_event("POST", path, REGION_LESS, request_body(customerId="cust-001")))
    assert response["statusCode"] == 307
    assert response["headers"]["Location"] == f"http://{HOME_NAME}{encoded}"
    assert answer["location"] == response["headers"]["Location"]
    one_header_line_each(response)


@pytest.mark.parametrize("path", ["@evil.example/", "evil", "http://evil.example/"])
def test_a_path_that_does_not_start_with_a_slash_gets_400(call, path):
    # Appended to the host, "@evil.example/" would make the home Region name the user info of another host.
    response, _ = call(alb_event("POST", path, REGION_LESS, request_body(customerId="cust-001")))
    assert response["statusCode"] == 400
    assert "Location" not in response["headers"]


@pytest.mark.parametrize("params,query", [
    ({"a": "1", "b": "2"}, "a=1&b=2"),
    ({"a": "x\r\nSet-Cookie: z"}, "a=x%0D%0ASet-Cookie%3A%20z"),
    ({"a": "x\ny"}, "a=x%0Ay"),
    ({"a\r\nb": "1"}, "a%0D%0Ab=1"),
    ({"a": "x#frag"}, "a=x%23frag"),
    ({"a": "caf\u00e9"}, "a=caf%C3%A9"),
    ({"a": "%0d%0a"}, "a=%0d%0a"),  # the text of an encoded CR LF stays text
    ({"a": "x%26y"}, "a=x%26y"),  # the ALB does not decode the query, and an encoded & stays encoded
])
def test_the_query_is_encoded_and_cannot_end_the_header_line(call, params, query):
    response, _ = call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-001"), query=params))
    assert response["statusCode"] == 307
    assert response["headers"]["Location"] == f"http://{HOME_NAME}/read?{query}"
    one_header_line_each(response)


@pytest.mark.parametrize("hostile", ["x&Set-Cookie=1", "x\r\nLocation: http://evil.example/", "x#@evil.example/", "\u2028"])
def test_hostile_text_in_the_path_or_query_changes_neither_the_host_nor_the_headers(call, hostile):
    event = alb_event("POST", f"/p/{hostile}", REGION_LESS, request_body(customerId="cust-001"), query={"q": hostile})
    response, _ = call(event)
    assert response["statusCode"] == 307
    assert set(response["headers"]) == {"Content-Type", "X-Served-By", "Location", "Cache-Control"}
    one_header_line_each(response)
    location = urlsplit(response["headers"]["Location"])
    assert (location.scheme, location.netloc, location.fragment) == ("http", HOME_NAME, "")


def test_an_unknown_home_region_is_an_error_not_a_redirect(call, table):
    table.home("cust-003", "eu-west-1")
    response, _ = call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-003")))
    assert response["statusCode"] == 500
    assert "Location" not in response["headers"]


def test_a_profile_without_a_home_region_is_an_error_not_a_redirect(call, table):
    table.no_home("cust-004")
    response, answer = call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-004")))
    assert response["statusCode"] == 500
    assert "no home Region" in answer["error"]
    assert "Location" not in response["headers"]


@pytest.mark.parametrize("error,code", [
    (client_error("ProvisionedThroughputExceededException"), "ProvisionedThroughputExceededException"),
    (client_error("AccessDeniedException"), "AccessDeniedException"),
    (ReadTimeoutError(endpoint_url="https://dynamodb.us-east-2.amazonaws.com/"), "ReadTimeoutError"),
])
def test_a_table_error_gets_503_with_the_reason_and_the_responder(call, table, error, code):
    table.fail(error)
    response, answer = call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-001")))
    assert response["statusCode"] == 503
    assert response["headers"]["X-Served-By"] == "router us-east-2"
    assert response["headers"]["Content-Type"] == "application/json"
    assert code in answer["error"]
    assert "Location" not in response["headers"]


def test_the_full_error_message_goes_to_the_log_and_only_the_code_to_the_client(call, table, caplog):
    table.fail(client_error("AccessDeniedException"))  # its message names the role
    with caplog.at_level(logging.WARNING, logger="router"):
        response, _ = call(alb_event("POST", "/read", REGION_LESS, request_body(customerId="cust-001")))
    assert SECRET not in response["body"]
    assert SECRET in caplog.text
