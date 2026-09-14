"""Generic single-target Locust workload for the LoadGenerator construct (changeset §3c).

Entirely env-driven so the base image is demo-agnostic: a demo overlays its own
``locustfile.py`` (+ helper modules) via ``workloadDirectory`` without touching the
container or the cross-provider build path (changeset §3d).

Observability (zero-infra EMF): every request prints ONE Embedded Metric Format JSON
line to stdout. The Fargate awslogs driver ships it to CloudWatch Logs, which
auto-extracts the metrics into the namespace named by ``DEMO_METRIC_NAMESPACE`` — no
MetricFilter, no extra infra. C3: the namespace env var is ``DEMO_METRIC_NAMESPACE``
(NOT ``EMF_NAMESPACE``) so this file and the observability Python helper read the same
variable the CDK stack injects.
"""

import json
import os
import time

from locust import HttpUser, between, task

TARGET_URL = os.environ["TARGET_URL"]  # required
TARGET_PATH = os.environ.get("TARGET_PATH", "/")
HTTP_METHOD = os.environ.get("HTTP_METHOD", "GET")
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "5"))
# C3: read the SAME env var name the CDK stack injects (DEMO_METRIC_NAMESPACE).
METRIC_NAMESPACE = os.environ.get("DEMO_METRIC_NAMESPACE", "MyResilienceDemo")
MIN_WAIT = float(os.environ.get("MIN_WAIT", "0.5"))
MAX_WAIT = float(os.environ.get("MAX_WAIT", "1.0"))


class LoadUser(HttpUser):
    host = TARGET_URL
    wait_time = between(MIN_WAIT, MAX_WAIT)

    @task
    def hit(self) -> None:
        start = time.monotonic()
        with self.client.request(
            HTTP_METHOD,
            TARGET_PATH,
            timeout=REQUEST_TIMEOUT,
            catch_response=True,
        ) as resp:
            elapsed_ms = (time.monotonic() - start) * 1000
            ok = 0 < resp.status_code < 500
            # ONE EMF line per request — aggregate/client-level metrics live on exactly
            # one line to avoid double-counting.
            print(
                json.dumps(
                    {
                        "_aws": {
                            "Timestamp": int(time.time() * 1000),
                            "CloudWatchMetrics": [
                                {
                                    "Namespace": METRIC_NAMESPACE,
                                    "Dimensions": [["Target"]],
                                    "Metrics": [
                                        {"Name": "Latency", "Unit": "Milliseconds"},
                                        {"Name": "Success", "Unit": "Count"},
                                        {"Name": "Error", "Unit": "Count"},
                                    ],
                                }
                            ],
                        },
                        "Target": TARGET_PATH,
                        "Latency": elapsed_ms,
                        "Success": 1 if ok else 0,
                        "Error": 0 if ok else 1,
                    }
                ),
                flush=True,
            )
            if ok:
                resp.success()
            else:
                resp.failure(f"status {resp.status_code}")
