"""Fixtures for the function tests. The helpers live in fakes.py."""
import importlib.util
import json
import sys
import types

import pytest

if importlib.util.find_spec("boto3") is None:  # the functions import boto3; only test_table_client.py needs the real one
    sys.modules["boto3"] = types.ModuleType("boto3")
if importlib.util.find_spec("botocore") is None:  # ... and botocore's Config and error classes: stand-ins of the same shape
    botocore, config, exceptions = (types.ModuleType(name) for name in ("botocore", "botocore.config", "botocore.exceptions"))

    class Config:
        def __init__(self, **options):
            self.options = options

    class BotoCoreError(Exception):
        pass

    class ClientError(Exception):
        def __init__(self, error_response, operation_name):
            code, message = error_response["Error"]["Code"], error_response["Error"]["Message"]
            super().__init__(f"An error occurred ({code}) when calling the {operation_name} operation: {message}")
            self.response = error_response

    class ReadTimeoutError(BotoCoreError):
        def __init__(self, endpoint_url):
            super().__init__(f"Read timeout on endpoint URL: {endpoint_url}")

    config.Config = Config
    exceptions.BotoCoreError, exceptions.ClientError, exceptions.ReadTimeoutError = BotoCoreError, ClientError, ReadTimeoutError
    botocore.config, botocore.exceptions = config, exceptions
    sys.modules.update({"botocore": botocore, "botocore.config": config, "botocore.exceptions": exceptions})

from fakes import REGIONAL_NAMES, TABLE, FakeDynamoDB  # noqa: E402


@pytest.fixture
def table(monkeypatch):
    monkeypatch.setenv("TABLE", TABLE)
    monkeypatch.setenv("REGIONAL_NAMES", json.dumps(REGIONAL_NAMES))
    fake = FakeDynamoDB()
    fake.home("cust-001", "us-east-1")
    return fake


@pytest.fixture
def real_boto3(monkeypatch, tmp_path):
    """The installed boto3 with fake credentials and no profile, for tests of the client the functions build."""
    boto3 = importlib.import_module("boto3")
    if not hasattr(boto3, "client"):  # the bare stand-in above
        pytest.skip("boto3 is not installed")
    for name in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_DYNAMODB"):
        monkeypatch.delenv(name, raising=False)  # a profile or endpoint from the developer's shell must not leak in
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "no-config"))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "no-credentials"))
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-2")
    return boto3
