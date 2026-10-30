"""Router for the region-less name.

The internal Application Load Balancer (ALB) in each Region sends this function every request
for the region-less name. It reads the customer ID from the JSON request body, looks up the
customer's home Region in this Region's replica of the global table, and answers 307 with the
home Region's name. The client repeats the same request, method and body included, there.

The router never checks whether the home Region is up. When the ARC Region switch plan drains
it, the home Region name's failover record answers with the other Region, so the same redirect
lands there.

The Location header carries the request's path and query string. The path is percent-encoded
where it must be, so no character that ends a header line can reach Location. The ALB hands the
function one value per query key, the last one when a key repeats, unless the target group enables
multi-value headers, which this function does not read. A repeated query key therefore reaches the
home Region once.

A table call that fails or times out gets a 503 with a JSON reason, not the ALB's 502.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import urllib.parse

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

CUSTOMER_ID = re.compile(r"[a-z0-9-]{1,40}")
PATH_SAFE = "/%:@!$&'()*+,;=-._~"  # what a URL path may carry as is; % stays so an encoded byte is not encoded twice

LOG = logging.getLogger(__name__)
_dynamodb = None


def dynamodb():
    """This Region's DynamoDB client, created on first use so unit tests can replace it."""
    global _dynamodb
    if _dynamodb is None:
        # Two attempts of at most 3 s each fit the function's 10 s timeout, so a stalled table gets
        # a 503 from this function rather than the ALB's 502 when the function times out.
        _dynamodb = boto3.client("dynamodb", config=Config(
            connect_timeout=2, read_timeout=3, retries={"total_max_attempts": 2, "mode": "standard"}))
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
    except (ValueError, AttributeError, RecursionError):  # not base64, UTF-8 or JSON, nested too deeply, or not an object
        return None
    return customer if isinstance(customer, str) and CUSTOMER_ID.fullmatch(customer) else None


def table_unavailable(exc: Exception) -> dict:
    """The 503 for a table call that failed; the log keeps the full message, the response only the code."""
    LOG.warning("the customer table call failed: %s", exc)
    code = exc.response.get("Error", {}).get("Code", "ClientError") if isinstance(exc, ClientError) else type(exc).__name__
    return respond(503, "Service Unavailable", {"error": f"this Region's customer table did not answer ({code})"})


def route(event: dict) -> dict:
    regional_names = json.loads(os.environ["REGIONAL_NAMES"])  # home Region -> its regional name
    path = event.get("path") or "/"
    if not path.startswith("/"):  # keeps the path from becoming part of the authority in Location
        return respond(400, "Bad Request", {"error": "the path must start with /"})
    customer = customer_of(event)
    if customer is None:
        return respond(400, "Bad Request",
                       {"error": 'expected a JSON body that names the customer, such as {"customerId": "cust-001"}'})
    profile = dynamodb().get_item(TableName=os.environ["TABLE"],
                                  Key={"customerId": {"S": customer}, "record": {"S": "profile"}}).get("Item")
    if not profile:
        return respond(404, "Not Found", {"error": f"unknown customer {customer}"})
    # A profile that names no usable home Region is bad data: the client sent a valid request and a
    # retry will not help, so it is a 500, like a home Region this deployment does not have.
    home = (profile.get("homeRegion") or {}).get("S")
    if home is None:
        return respond(500, "Internal Server Error", {"error": f"{customer} has no home Region in its profile"})
    if home not in regional_names:
        return respond(500, "Internal Server Error", {"error": f"{customer} has an unknown home Region {home}"})
    proto = (event.get("headers") or {}).get("x-forwarded-proto")
    scheme = proto if proto in ("http", "https") else "http"
    params = event.get("queryStringParameters") or {}
    query = urllib.parse.quote("&".join(f"{k}={v}" for k, v in params.items()), safe="=&%+-._~")
    location = f"{scheme}://{regional_names[home]}{urllib.parse.quote(path, safe=PATH_SAFE)}" + (f"?{query}" if query else "")
    return respond(307, "Temporary Redirect", {"customerId": customer, "homeRegion": home, "location": location},
                   {"Location": location, "Cache-Control": "no-store"})


def handler(event: dict, _context=None) -> dict:
    try:
        return route(event)
    except (ClientError, BotoCoreError) as exc:
        return table_unavailable(exc)
