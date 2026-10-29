"""Stand-in for the ingest app: reads and writes one customer's items in this Region's replica.

Every request is a POST whose JSON body names the customer:

    POST /write  {"customerId": "cust-001", "key": "demo", "value": <any JSON>}
    POST /read   {"customerId": "cust-001", "key": "demo"}   (without a key: the home Region)

Home-Region guard: the app serves a customer's request only when it arrives on the name of the
customer's home Region, such as ingest.ue1.demo.io, and answers 307 to that name otherwise. Which
Region serves that name is DNS's decision: its own Region at rest, the other Region after the ARC
Region switch plan drains the home Region. So a client that calls the wrong regional name, or an
app name directly, is sent to the one name that tracks the plan.

The guard does not cover the DNS cache window. For up to the record TTL after a drain or a restore,
clients holding the old answer still reach the other Region on the home Region's name, and the
global table resolves concurrent writes to one item by last writer wins.

Every response names the Region that served it, so a request that a failover record sent to the
other Region shows as served outside the customer's home Region.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time

import boto3

CUSTOMER_ID = re.compile(r"[a-z0-9-]{1,40}")
KEY = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_VALUE = 1024  # bytes of JSON per item value

_dynamodb = None


def dynamodb():
    """This Region's DynamoDB client, created on first use so unit tests can replace it."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.client("dynamodb")
    return _dynamodb


def respond(status: int, reason: str, body: dict, headers: dict | None = None) -> dict:
    return {
        "statusCode": status,
        "statusDescription": f"{status} {reason}",
        "isBase64Encoded": False,
        "headers": {"Content-Type": "application/json", "X-Served-By": f"app {os.environ['AWS_REGION']}",
                    **(headers or {})},
        "body": json.dumps(body),
    }


def item_key(customer: str, record: str) -> dict:
    return {"customerId": {"S": customer}, "record": {"S": record}}


def parse(event: dict) -> dict | None:
    """The JSON object in the request body, or None."""
    try:
        body = event.get("body") or ""
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        request = json.loads(body)
    except ValueError:
        return None
    return request if isinstance(request, dict) else None


def host_of(event: dict) -> str:
    """The Host header without a port, lowercased; ALB lowercases header names."""
    return ((event.get("headers") or {}).get("host") or "").split(":", 1)[0].strip().lower()


def handler(event: dict, _context=None) -> dict:
    table, region = os.environ["TABLE"], os.environ["AWS_REGION"]
    regional_names = json.loads(os.environ["REGIONAL_NAMES"])  # home Region -> its regional name
    path = event.get("path")
    if path not in ("/read", "/write"):
        return respond(404, "Not Found", {"error": "use POST /read or POST /write"})
    if event.get("httpMethod") != "POST":
        return respond(405, "Method Not Allowed", {"error": "use POST with a JSON body"})
    request = parse(event) or {}
    customer, key = request.get("customerId"), request.get("key")
    if not (isinstance(customer, str) and CUSTOMER_ID.fullmatch(customer)) or not (
            key is None or isinstance(key, str) and KEY.fullmatch(key)):
        return respond(400, "Bad Request", {"error": 'expected {"customerId": "cust-001", "key": "demo", ...}'})
    # Strongly consistent within this Region's replica: it reflects every write this Region
    # accepted, and the other Region's writes once they have replicated.
    profile = dynamodb().get_item(TableName=table, Key=item_key(customer, "profile"), ConsistentRead=True).get("Item")
    if not profile:
        return respond(404, "Not Found", {"error": f"unknown customer {customer}"})
    home = profile["homeRegion"]["S"]
    out = {"customerId": customer, "homeRegion": home, "servedBy": region}
    home_name = regional_names.get(home)
    if home_name is None:
        return respond(500, "Internal Server Error", {**out, "error": f"unknown home Region {home}"})
    if host_of(event) != home_name:
        proto = (event.get("headers") or {}).get("x-forwarded-proto")
        location = f"{proto if proto in ('http', 'https') else 'http'}://{home_name}{path}"
        return respond(307, "Temporary Redirect", {**out, "location": location,
                                                   "error": f"{customer} is served on {home_name}"},
                       {"Location": location, "Cache-Control": "no-store"})
    if key is None:
        if path == "/write":
            return respond(400, "Bad Request", {**out, "error": "a write needs a key"})
        return respond(200, "OK", out)
    out["key"] = key
    if path == "/write":
        if "value" not in request:
            return respond(400, "Bad Request", {**out, "error": "a write needs a value"})
        value = json.dumps(request["value"])
        if len(value.encode("utf-8")) > MAX_VALUE:
            return respond(413, "Payload Too Large", {**out, "error": "keep the value under 1 KB"})
        written_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        dynamodb().put_item(TableName=table, Item={**item_key(customer, f"item#{key}"), "value": {"S": value},
                                                   "writtenIn": {"S": region}, "writtenAt": {"S": written_at}})
        return respond(200, "OK", {**out, "writtenIn": region, "writtenAt": written_at})
    found = dynamodb().get_item(TableName=table, Key=item_key(customer, f"item#{key}"), ConsistentRead=True).get("Item")
    if not found:
        return respond(404, "Not Found", {**out, "error": f"no item {key} yet"})
    return respond(200, "OK", {**out, "value": json.loads(found["value"]["S"]),
                               "writtenIn": found["writtenIn"]["S"], "writtenAt": found["writtenAt"]["S"]})
