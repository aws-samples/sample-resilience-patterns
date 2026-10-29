"""Fixtures for the function tests. The helpers live in fakes.py."""
import importlib.util
import json
import sys
import types

import pytest

if importlib.util.find_spec("boto3") is None:  # the functions import boto3; these tests never call it
    sys.modules["boto3"] = types.ModuleType("boto3")

from fakes import REGIONAL_NAMES, TABLE, FakeDynamoDB  # noqa: E402


@pytest.fixture
def table(monkeypatch):
    monkeypatch.setenv("TABLE", TABLE)
    monkeypatch.setenv("REGIONAL_NAMES", json.dumps(REGIONAL_NAMES))
    fake = FakeDynamoDB()
    fake.home("cust-001", "us-east-1")
    return fake
