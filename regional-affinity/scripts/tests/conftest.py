"""scripts/demo.py reads its settings from the environment when it is imported. The Makefile exports
them, so clear them here: the tests expect the defaults (us-east-1 and us-east-2, example.com, ingest)."""
import os
import subprocess

import pytest

for name in ("PROJECT", "REGIONS", "DOMAIN", "APP_LABEL", "ACCOUNT", "PROFILE"):
    os.environ.pop(name, None)


@pytest.fixture(autouse=True)
def no_real_aws_cli(monkeypatch):
    """No test may run the real AWS CLI. A developer's shell may hold credentials for a real account, and a test
    that forgets to replace demo.aws would call it. The tests replace demo.aws (or demo.subprocess); one that
    forgets fails here, naming the command it tried to run."""
    real_run = subprocess.run

    def run(cmd, *args, **kwargs):
        program = cmd[0] if isinstance(cmd, (list, tuple)) and cmd else str(cmd).split()[0]
        if os.path.basename(str(program)) == "aws":
            raise AssertionError(f"a test reached the real AWS CLI: {' '.join(str(part) for part in cmd[:8])} ...")
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
