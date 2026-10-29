"""scripts/demo.py reads its settings from the environment when it is imported. The Makefile exports
them, so clear them here: the tests expect the defaults (us-east-1 and us-east-2, demo.io, ingest)."""
import os

for name in ("PROJECT", "REGIONS", "DOMAIN", "APP_LABEL", "ACCOUNT", "PROFILE"):
    os.environ.pop(name, None)
