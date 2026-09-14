"""POST/GET /inject — control-plane Lambda for the error-rate SSM knob.

Generalized from five-nines ``src/lambda/inject/handler.py``; the fixed 3-target
``TARGET_MAP`` module constant is now read from the ``TARGET_MAP`` env var (JSON)
that the ``InjectApi`` construct injects, so the Lambda is demo-independent.

- ``GET /inject``  -> current error rates for every target (logical -> int).
- ``POST /inject`` with body ``{"target": "<name>", "rate": <0-100>}`` -> set the rate.
"""
import json
import os

import boto3
import botocore.config

# RULE 16 (vendor patch): the Lambda timeout is 5s (set in inject-api.ts). An unbounded
# get_parameter/put_parameter consumes the whole budget and the caller gets an opaque
# Lambda timeout instead of this handler's own JSON error. Budget: (1s + 1s) x 2 = 4s < 5s.
#
# Patched on vendor even though InjectApi is opt-in and OFF in this demo, so the file is
# correct if it is ever enabled.
_BOTO_CFG = botocore.config.Config(
    connect_timeout=1,
    read_timeout=1,
    retries={"max_attempts": 2, "mode": "standard"},
)

_ssm = None
TARGET_MAP = json.loads(os.environ.get("TARGET_MAP", "{}"))


def handler(event, context):
    global _ssm
    if _ssm is None:
        _ssm = boto3.client("ssm", config=_BOTO_CFG)

    method = event.get("httpMethod", "POST")

    if method == "GET":
        rates = {}
        for target, param in TARGET_MAP.items():
            try:
                rates[target] = int(_ssm.get_parameter(Name=param)["Parameter"]["Value"])
            except Exception:
                rates[target] = 0
        return _resp(200, rates)

    try:
        body = json.loads(event.get("body") or "{}")
    except (json.JSONDecodeError, TypeError):
        return _resp(400, {"error": "Invalid JSON body"})

    target, rate = body.get("target"), body.get("rate")
    if target not in TARGET_MAP:
        return _resp(400, {"error": f"Invalid target. One of: {list(TARGET_MAP)}"})
    if not isinstance(rate, int) or not 0 <= rate <= 100:
        return _resp(400, {"error": "rate must be an integer 0-100"})

    try:
        _ssm.put_parameter(Name=TARGET_MAP[target], Value=str(rate), Type="String", Overwrite=True)
    except Exception as e:
        return _resp(500, {"error": f"SSM put_parameter failed: {str(e)}"})

    return _resp(200, {"status": "ok", "target": target, "rate": rate, "parameter": TARGET_MAP[target]})


def _resp(code, body):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
