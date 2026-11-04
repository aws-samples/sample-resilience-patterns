"""invoke() is what holds every handler test to the response shape the ALB needs; hold invoke() to it too."""
import types

import pytest

from fakes import invoke


def handler_answering(**overrides):
    response = {"statusCode": 307, "statusDescription": "307 Temporary Redirect", "headers": {"Location": "http://x/"},
                "body": "{}", "isBase64Encoded": False}
    return types.SimpleNamespace(handler=lambda event, context: {**response, **overrides})


def test_invoke_accepts_the_shape_the_alb_needs(monkeypatch):
    response, body = invoke(handler_answering(), "us-east-1", {}, monkeypatch)
    assert (response["statusCode"], body) == (307, {})


@pytest.mark.parametrize("overrides", [
    {"statusDescription": "307"},
    {"statusDescription": "307 "},
    {"statusDescription": "307  Temporary Redirect"},
    {"statusDescription": "Temporary Redirect"},
    {"statusDescription": "200 OK"},
    {"statusDescription": "307 Temporary\nRedirect"},
    {"isBase64Encoded": True},
    {"headers": {"Content-Length": 2}},
    {"body": {}},
    {"multiValueHeaders": {"Location": ["http://x/"]}},
])
def test_invoke_rejects_a_response_the_alb_would_answer_with_a_502(monkeypatch, overrides):
    with pytest.raises(AssertionError):
        invoke(handler_answering(**overrides), "us-east-1", {}, monkeypatch)
