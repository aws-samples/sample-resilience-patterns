"""Helpers for the function tests: a fake DynamoDB client, the event an ALB sends, and a runner."""
from __future__ import annotations

import json
import re

from botocore.exceptions import ClientError

REGIONS = ("us-east-1", "us-east-2")
REGION_LESS = "ingest.example.com"
REGIONAL_NAMES = {"us-east-1": "ingest.ue1.example.com", "us-east-2": "ingest.ue2.example.com"}
APP_NAMES = {"us-east-1": "ingest-app.ue1.example.com", "us-east-2": "ingest-app.ue2.example.com"}
TABLE = "regional-affinity-customers"
SECRET = "arn:aws:iam::111122223333:role/regional-affinity-app"  # in an AccessDenied message; must stay out of responses


def client_error(code: str, operation: str = "GetItem") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": f"User {SECRET} is not authorized"}}, operation)


class FakeDynamoDB:
    """get_item and put_item over a dict, recording each call."""

    def __init__(self):
        self.items, self.calls, self.failures = {}, [], {}

    def fail(self, error: Exception, operation: str = "get_item", nth: int = 1) -> None:
        """Make the nth call of operation raise error."""
        self.failures[(operation, nth)] = error

    def record(self, operation: str, *details) -> None:
        self.calls.append((operation, *details))
        nth = sum(1 for call in self.calls if call[0] == operation)
        if (operation, nth) in self.failures:
            raise self.failures[(operation, nth)]

    def get_item(self, TableName, Key, ConsistentRead=False):
        self.record("get_item", TableName, ConsistentRead)
        item = self.items.get((Key["customerId"]["S"], Key["record"]["S"]))
        return {"Item": item} if item else {}

    def put_item(self, TableName, Item):
        self.record("put_item", TableName)
        self.items[(Item["customerId"]["S"], Item["record"]["S"])] = Item
        return {}

    def home(self, customer: str, region: str) -> None:
        self.items[(customer, "profile")] = {"customerId": {"S": customer}, "record": {"S": "profile"},
                                             "homeRegion": {"S": region}}

    def no_home(self, customer: str) -> None:
        """A profile item that names no home Region."""
        self.items[(customer, "profile")] = {"customerId": {"S": customer}, "record": {"S": "profile"}}


def alb_event(method: str, path: str, host: str | None, body: str | None = None, query=None, **headers) -> dict:
    """The event an ALB sends a Lambda target (multi-value headers off)."""
    all_headers = {"x-forwarded-proto": "http", **headers}
    if host is not None:
        all_headers["host"] = host
    return {"httpMethod": method, "path": path, "queryStringParameters": query or {}, "headers": all_headers,
            "body": body or "", "isBase64Encoded": False}


def request_body(**fields) -> str:
    return json.dumps(fields)


def invoke(module, region: str, event: dict, monkeypatch) -> tuple:
    """Run a handler as Lambda would in region; returns (response, decoded body)."""
    monkeypatch.setenv("AWS_REGION", region)
    response = module.handler(event, None)
    # The shape the ALB needs from a Lambda target (multi-value headers off).
    assert set(response) == {"statusCode", "statusDescription", "headers", "body", "isBase64Encoded"}
    assert re.fullmatch(rf"{response['statusCode']} \S.*", response["statusDescription"])  # "<code> <reason>"
    assert response["isBase64Encoded"] is False
    assert isinstance(response["body"], str) and all(isinstance(v, str) for v in response["headers"].values())
    return response, json.loads(response["body"])
