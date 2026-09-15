"""Fake AWS clients for unit-testing the step state machines.

Each test builds a ``World`` describing DRS/EC2/ELB state per region, then calls a handler and
asserts on the outcome (return / RetryLater / StepFailed) and on the API calls recorded. The
fakes implement only the operations the steps use, with the response shapes of the real APIs.
"""
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple

import pytest

from drs_region_switch import common

PRIMARY = "us-east-2"
SECONDARY = "us-west-2"


class ConflictException(Exception):
    pass


class _Exceptions:
    ConflictException = ConflictException


class _Paginator:
    def __init__(self, page):
        self._page = page

    def paginate(self, **kwargs):
        return [self._page]


@dataclass
class FakeClient:
    service: str
    region: str
    world: "World"
    calls: List[Tuple[str, dict]] = field(default_factory=list)
    exceptions = _Exceptions()

    def _rec(self, op, kwargs):
        self.calls.append((op, kwargs))

    # ---- generic ----
    def get_paginator(self, op):
        assert op == "describe_source_servers"
        return _Paginator({"items": self.world.source_servers[self.region]})

    # ---- DRS ----
    def describe_source_servers(self, filters=None, **_):
        ids = (filters or {}).get("sourceServerIDs")
        items = self.world.source_servers[self.region]
        return {"items": [s for s in items if not ids or s["sourceServerID"] in ids]}

    def describe_recovery_instances(self, filters=None, **_):
        self._rec("describe_recovery_instances", filters or {})
        ids = (filters or {}).get("sourceServerIDs")
        items = self.world.recovery_instances[self.region]
        return {"items": [r for r in items if not ids or r["sourceServerID"] in ids]}

    def describe_jobs(self, filters=None, **_):
        ids = (filters or {}).get("jobIDs")
        return {"items": [j for j in self.world.jobs[self.region] if not ids or j["jobID"] in ids]}

    def describe_job_log_items(self, jobID, **_):
        return {"items": self.world.job_logs.get(jobID, [])}

    def start_recovery(self, sourceServers, isDrill):
        self._rec("start_recovery", {"sourceServers": sourceServers, "isDrill": isDrill})
        return {"job": {"jobID": f"job-new-{self.region}", "status": "PENDING"}}

    def reverse_replication(self, recoveryInstanceID):
        self._rec("reverse_replication", {"recoveryInstanceID": recoveryInstanceID})
        if recoveryInstanceID in self.world.initializing:
            raise ConflictException("Recovery instance not finished initializing")
        return {"reversedDirectionSourceServerArn": f"arn:aws:drs:{PRIMARY}:1:source-server/s-rev"}

    def get_launch_configuration(self, sourceServerID):
        return self.world.launch_configs.get(sourceServerID, {"ec2LaunchTemplateID": "lt-1"})

    def update_launch_configuration(self, **kw): self._rec("update_launch_configuration", kw); return {}
    def tag_resource(self, **kw): self._rec("tag_resource", kw); return {}
    def untag_resource(self, **kw): self._rec("untag_resource", kw); return {}
    def stop_replication(self, **kw): self._rec("stop_replication", kw); return {}
    def stop_failback(self, **kw): self._rec("stop_failback", kw); return {}
    def disconnect_source_server(self, **kw): self._rec("disconnect_source_server", kw); return {}
    def delete_source_server(self, **kw): self._rec("delete_source_server", kw); return {}
    def delete_recovery_instance(self, **kw): self._rec("delete_recovery_instance", kw); return {}

    def terminate_recovery_instances(self, recoveryInstanceIDs):
        self._rec("terminate_recovery_instances", {"recoveryInstanceIDs": recoveryInstanceIDs})
        if self.world.refuse_terminate:
            raise Exception("Recovery instances cannot be terminated during failback")
        return {}

    # ---- EC2 ----
    def describe_instances(self, InstanceIds):
        state = self.world.ec2_state.get(InstanceIds[0], "running")
        return {"Reservations": [{"Instances": [{"InstanceId": InstanceIds[0], "State": {"Name": state}}]}]}

    def stop_instances(self, **kw): self._rec("stop_instances", kw); return {}
    def create_tags(self, **kw): self._rec("create_tags", kw); return {}

    def describe_launch_template_versions(self, **_):
        return {"LaunchTemplateVersions": [{"LaunchTemplateData": self.world.launch_template_data}]}

    def create_launch_template_version(self, **kw):
        self._rec("create_launch_template_version", kw)
        return {"LaunchTemplateVersion": {"VersionNumber": 2}}

    def modify_launch_template(self, **kw): self._rec("modify_launch_template", kw); return {}

    # ---- ELB ----
    def describe_target_health(self, TargetGroupArn, Targets=None):
        return {"TargetHealthDescriptions": self.world.targets.get(TargetGroupArn, [])}

    def register_targets(self, **kw): self._rec("register_targets", kw); return {}
    def deregister_targets(self, **kw): self._rec("deregister_targets", kw); return {}

    # ---- SSM ----
    def put_parameter(self, **kw): self._rec("put_parameter", kw); return {}


@dataclass
class World:
    source_servers: Dict[str, List[dict]] = field(default_factory=lambda: {PRIMARY: [], SECONDARY: []})
    recovery_instances: Dict[str, List[dict]] = field(default_factory=lambda: {PRIMARY: [], SECONDARY: []})
    jobs: Dict[str, List[dict]] = field(default_factory=lambda: {PRIMARY: [], SECONDARY: []})
    job_logs: Dict[str, List[dict]] = field(default_factory=dict)
    launch_configs: Dict[str, dict] = field(default_factory=dict)
    launch_template_data: dict = field(default_factory=dict)
    ec2_state: Dict[str, str] = field(default_factory=dict)
    targets: Dict[str, List[dict]] = field(default_factory=dict)
    initializing: set = field(default_factory=set)
    refuse_terminate: bool = False
    clients: Dict[Tuple[str, str], FakeClient] = field(default_factory=dict)

    def client(self, service, region) -> FakeClient:
        key = (service, region)
        if key not in self.clients:
            self.clients[key] = FakeClient(service, region, self)
        return self.clients[key]

    def calls(self, service, region, op=None):
        c = self.client(service, region).calls
        return [k for k in c if op is None or k[0] == op]


# ---- builders -------------------------------------------------------------------------------

TAG_KEY, TAG_VALUE = "drsdemo:role", "app"
PRI_TG = "arn:aws:elasticloadbalancing:us-east-2:1:targetgroup/pri/1"
SEC_TG = "arn:aws:elasticloadbalancing:us-west-2:1:targetgroup/sec/1"


def forward_server(instance_id="i-primary", state="CONTINUOUS", tags=None, sid="s-fwd", disks=None, lag="P0D"):
    return {"sourceServerID": sid, "arn": f"arn:aws:drs:{SECONDARY}:1:source-server/{sid}",
            "replicationDirection": "FAILOVER",
            "tags": {TAG_KEY: TAG_VALUE, **(tags or {})},
            "sourceProperties": {"identificationHints": {"awsInstanceID": instance_id}},
            "dataReplicationInfo": {"dataReplicationState": state, "lagDuration": lag,
                                    "replicatedDisks": disks if disks is not None else
                                    [{"deviceName": "/dev/xvda", "totalStorageBytes": 100, "replicatedStorageBytes": 100,
                                      "rescannedStorageBytes": 100, "backloggedStorageBytes": 0}]}}


def failback_server(instance_id="i-recovered", state="CONTINUOUS", sid="s-fb"):
    return {"sourceServerID": sid, "arn": f"arn:aws:drs:{PRIMARY}:1:source-server/{sid}",
            "replicationDirection": "FAILBACK", "tags": {},
            "sourceProperties": {"identificationHints": {"awsInstanceID": instance_id}},
            "dataReplicationInfo": {"dataReplicationState": state, "replicatedDisks": []}}


def recovery_instance(ec2_id, sid, state="RUNNING", rid=None, job_id=None, repl_state=None, failback_state=None):
    ri = {"recoveryInstanceID": rid or f"ri-{ec2_id}", "ec2InstanceID": ec2_id, "ec2InstanceState": state,
          "sourceServerID": sid, "isDrill": False, "jobID": job_id}
    if repl_state:
        ri["dataReplicationInfo"] = {"dataReplicationState": repl_state}
    if failback_state:
        ri["failback"] = {"state": failback_state}
    return ri


def target(instance_id, state="healthy"):
    return {"Target": {"Id": instance_id}, "TargetHealth": {"State": state}}


@pytest.fixture
def env(monkeypatch):
    for k, v in {
        "PROJECT": "drsdemo", "SOURCE_SERVER_TAG_KEY": TAG_KEY, "SOURCE_SERVER_TAG_VALUE": TAG_VALUE,
        "PRIMARY_REGION": PRIMARY, "SECONDARY_REGION": SECONDARY,
        "PRIMARY_TARGET_GROUP_ARN": PRI_TG, "SECONDARY_TARGET_GROUP_ARN": SEC_TG,
        "APP_INSTANCE_PROFILE_ARN": "arn:aws:iam::1:instance-profile/app",
        "SECONDARY_DB_ENDPOINT": "db.usw2.example", "PRIMARY_SUBNET_ID": "subnet-p", "PRIMARY_APP_SG_ID": "sg-p",
    }.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("STATEFUL_EC2", "false")
    yield monkeypatch


@pytest.fixture
def world(env):
    w = World()
    common.set_client_factory(w.client)
    yield w
    common.set_client_factory(None)


@pytest.fixture
def stateful(env):
    env.setenv("STATEFUL_EC2", "true")
