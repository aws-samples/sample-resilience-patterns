"""Helpers for the function tests: a fake DynamoDB client, the event an ALB sends, and a runner."""
from __future__ import annotations

import json

REGIONS = ("us-east-1", "us-east-2")
REGION_LESS = "ingest.example.com"
REGIONAL_NAMES = {"us-east-1": "ingest.ue1.example.com", "us-east-2": "ingest.ue2.example.com"}
APP_NAMES = {"us-east-1": "ingest-app.ue1.example.com", "us-east-2": "ingest-app.ue2.example.com"}
TABLE = "regional-affinity-customers"


class FakeDynamoDB:
    """get_item and put_item over a dict, recording each call."""

    def __init__(self):
        self.items, self.calls = {}, []

    def get_item(self, TableName, Key, ConsistentRead=False):
        self.calls.append(("get_item", TableName, ConsistentRead))
        item = self.items.get((Key["customerId"]["S"], Key["record"]["S"]))
        return {"Item": item} if item else {}

    def put_item(self, TableName, Item):
        self.calls.append(("put_item", TableName))
        self.items[(Item["customerId"]["S"], Item["record"]["S"])] = Item
        return {}

    def home(self, customer: str, region: str) -> None:
        self.items[(customer, "profile")] = {"customerId": {"S": customer}, "record": {"S": "profile"},
                                             "homeRegion": {"S": region}}


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
    assert response["statusDescription"].split()[0] == str(response["statusCode"])  # ALB needs "<code> <reason>"
    assert response["isBase64Encoded"] is False
    return response, json.loads(response["body"])
