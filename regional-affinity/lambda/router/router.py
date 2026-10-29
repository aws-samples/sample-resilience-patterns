"""Router for the region-less name.

The internal Application Load Balancer (ALB) in each Region sends this function every request
for the region-less name. It reads the customer ID from the JSON request body, looks up the
customer's home Region in this Region's replica of the global table, and answers 307 with the
home Region's name. The client repeats the same request, method and body included, there.

The router never checks whether the home Region is up. When the ARC Region switch plan drains
it, the home Region name's failover record answers with the other Region, so the same redirect
lands there.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.parse

import boto3

CUSTOMER_ID = re.compile(r"[a-z0-9-]{1,40}")
PATH = re.compile(r"/[A-Za-z0-9._~%/-]*")  # copied into the Location header as is

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
        "headers": {"Content-Type": "application/json", "X-Served-By": f"router {os.environ['AWS_REGION']}",
                    **(headers or {})},
        "body": json.dumps(body),
    }


def customer_of(event: dict) -> str | None:
    """The customer ID named in the JSON request body, or None."""
    try:
        body = event.get("body") or ""
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        customer = json.loads(body).get("customerId")
    except (ValueError, AttributeError):  # not base64, UTF-8 or JSON, or not a JSON object
        return None
    return customer if isinstance(customer, str) and CUSTOMER_ID.fullmatch(customer) else None


def handler(event: dict, _context=None) -> dict:
    regional_names = json.loads(os.environ["REGIONAL_NAMES"])  # home Region -> its regional name
    path = event.get("path") or "/"
    if not PATH.fullmatch(path):
        return respond(400, "Bad Request", {"error": "unsupported characters in the path"})
    customer = customer_of(event)
    if customer is None:
        return respond(400, "Bad Request",
                       {"error": 'expected a JSON body that names the customer, such as {"customerId": "cust-001"}'})
    profile = dynamodb().get_item(TableName=os.environ["TABLE"],
                                  Key={"customerId": {"S": customer}, "record": {"S": "profile"}}).get("Item")
    if not profile:
        return respond(404, "Not Found", {"error": f"unknown customer {customer}"})
    home = profile["homeRegion"]["S"]
    if home not in regional_names:
        return respond(500, "Internal Server Error", {"error": f"{customer} has an unknown home Region {home}"})
    proto = (event.get("headers") or {}).get("x-forwarded-proto")
    scheme = proto if proto in ("http", "https") else "http"
    params = event.get("queryStringParameters") or {}
    query = urllib.parse.quote("&".join(f"{k}={v}" for k, v in params.items()), safe="=&%+-._~")
    location = f"{scheme}://{regional_names[home]}{path}" + (f"?{query}" if query else "")
    return respond(307, "Temporary Redirect", {"customerId": customer, "homeRegion": home, "location": location},
                   {"Location": location, "Cache-Control": "no-store"})
