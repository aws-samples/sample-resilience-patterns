"""DRS orchestration steps for an ARC Region Switch plan.

Seven step functions, one package. Each module exposes ``handler(event, context)`` and is
selected by the Lambda ``Handler`` setting (``drs_region_switch.<module>.handler``). The step
table below is the contract shared by the CDK construct, the Terraform module, the tests and
the documentation; keep them in sync through this file.
"""
from dataclasses import dataclass
from typing import Tuple

__version__ = "0.1.0"


@dataclass(frozen=True)
class Step:
    name: str            # ARC step name
    module: str          # python module in this package
    region_to_run: str   # ARC: activatingRegion | deactivatingRegion
    timeout_seconds: int  # Lambda timeout
    arc_retry_minutes: int
    arc_timeout_minutes: int
    stateful_only: bool
    workflow: str        # activateSecondary | activatePrimary

    @property
    def handler(self) -> str:
        return f"drs_region_switch.{self.module}.handler"


STEPS: Tuple[Step, ...] = (
    Step("drs-recover-ec2",          "recover",           "activatingRegion",   900, 1, 30,  False, "activateSecondary"),
    Step("register-target",          "register_target",   "activatingRegion",   300, 1, 15,  False, "activateSecondary"),
    Step("drs-reverse-replicate",    "reverse_replicate", "deactivatingRegion", 120, 1, 120, True,  "activatePrimary"),
    Step("drs-failback-launch",      "failback_launch",   "deactivatingRegion", 120, 1, 45,  True,  "activatePrimary"),
    Step("register-failback-target", "register_failback", "deactivatingRegion", 300, 1, 15,  True,  "activatePrimary"),
    # -- the consumer's Aurora / DNS steps go here in the activatePrimary workflow --
    Step("drs-reprotect",            "reprotect",         "deactivatingRegion", 120, 1, 120, True,  "activatePrimary"),
    Step("drs-retire",               "retire",            "deactivatingRegion", 120, 1, 30,  False, "activatePrimary"),
)

# Index in activatePrimary steps before which the consumer's Aurora switchover-back and DNS
# flip-back steps must be inserted (after register-failback-target, before drs-reprotect).
ACTIVATE_PRIMARY_SPLIT = 3
