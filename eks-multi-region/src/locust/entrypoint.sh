#!/usr/bin/env sh
#
# Entry point for the generic Locust load generator (changeset §3b).
#
# The SAME image serves both LoadGenerator modes — the construct injects
# LOCUST_WEB_UI=true|false, so the container picks web UI vs headless at runtime:
#   - exposeWebUi=true  → LOCUST_WEB_UI=true  → web UI on :8089 (ALB health-checks /).
#   - exposeWebUi=false → LOCUST_WEB_UI=false → headless run driven by users/spawn-rate.
set -eu

if [ "${LOCUST_WEB_UI:-false}" = "true" ]; then
  exec locust -f locustfile.py --web-port 8089 --host "${TARGET_URL}"
else
  exec locust -f locustfile.py --headless \
    --users "${LOCUST_USERS:-10}" --spawn-rate "${LOCUST_SPAWN_RATE:-10}" \
    --host "${TARGET_URL}"
fi
