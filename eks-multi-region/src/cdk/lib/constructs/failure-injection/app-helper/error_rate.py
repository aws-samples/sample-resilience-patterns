"""Reusable error-rate knob reader (5s TTL cache).

Lifted from five-nines ``src/lambda/backend/handler.py:9-44``; the hardcoded
``Name="/five-nines-demo/error-rate"`` is now read from the ``ERROR_RATE_PARAM``
environment variable that the ``FailureInjectionParameter`` construct injects.

Wire (in the demo's CDK stack)::

    fn.addEnvironment('ERROR_RATE_PARAM', knob.parameterName)

Then in the demo's handler::

    from error_rate import should_fail  # vendored helper
    def handler(event, context):
        if should_fail():
            return {"statusCode": 500, "body": '{"error":"Internal Server Error"}'}
        ...  # normal path

Gotcha (five-nines AGENTS.md:39): after injecting failure, wait ~5s before
expecting full effect — that's the TTL.
"""
import os
import random
import time

import boto3
import botocore.config

# RULE 16 (vendor patch): every boto3 client needs an explicit module-scope timeout
# config. should_fail() runs on the REQUEST HOT PATH — an unbounded get_parameter can
# hang past any upstream timeout, and because the TTL is only refreshed on a completed
# call, the `except: return 0` safety path never runs. A hanging call looks like an app
# outage, not a knob read.
#
# Budget: connect 1s + read 2s, up to 2 attempts, all inside the 5s _CACHE_TTL below,
# so a degraded SSM endpoint fails FAST to error-rate 0 and the app keeps serving.
_BOTO_CFG = botocore.config.Config(
    connect_timeout=1,
    read_timeout=2,
    retries={"max_attempts": 2, "mode": "standard"},
)

_PARAM_NAME = os.environ.get("ERROR_RATE_PARAM", "")
_CACHE_TTL = 5  # seconds — bounds GetParameter call rate; ~5s propagation delay
_ssm_client = None
_cached_error_rate = 0
_cache_expiry = 0.0


def get_error_rate() -> int:
    """Return the configured error rate (0-100) from SSM, cached with TTL.

    Returns 0 (no failure) on any error or if ``ERROR_RATE_PARAM`` is unset, so the
    app stays GREEN until the knob is both deployed and consumed.
    """
    global _ssm_client, _cached_error_rate, _cache_expiry
    if not _PARAM_NAME:
        return 0
    now = time.monotonic()
    if now < _cache_expiry:
        return _cached_error_rate
    try:
        if _ssm_client is None:
            _ssm_client = boto3.client("ssm", config=_BOTO_CFG)
        resp = _ssm_client.get_parameter(Name=_PARAM_NAME)
        _cached_error_rate = int(resp["Parameter"]["Value"])
    except Exception:
        _cached_error_rate = 0
    _cache_expiry = now + _CACHE_TTL
    return _cached_error_rate


def should_fail() -> bool:
    """Convenience: True for ~error_rate% of calls (five-nines handler.py:39)."""
    return random.randint(0, 99) < get_error_rate()
