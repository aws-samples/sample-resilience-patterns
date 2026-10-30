"""What demo.py assumes about the CDK app, and what it does with a bad setting. The assumptions are read from
lib/*.ts, because demo.py is standard-library Python and cannot import them, and no command may ask CloudFormation."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

import demo

ROOT = Path(__file__).resolve().parents[2]  # regional-affinity/
SCRIPT = ROOT / "scripts" / "demo.py"


def source(relative: str) -> str:
    return (ROOT / relative).read_text()


# ---- constants that stand in for CloudFormation outputs --------------------------------------------


def test_the_vpc_cidrs_are_the_ones_lib_names_ts_gives_the_stacks():
    match = re.search(r"export const VPC_CIDRS = \[([^\]]*)\]", source("lib/names.ts"))
    assert match, "lib/names.ts no longer declares VPC_CIDRS as an array"
    assert tuple(re.findall(r"""['"]([^'"]+)['"]""", match.group(1))) == demo.VPC_CIDRS


def test_vpc_cidrs_belong_to_the_regions_in_order():
    assert {region: str(net) for region, net in demo.vpc_cidrs().items()} == {
        "us-east-1": "10.11.0.0/16", "us-east-2": "10.12.0.0/16"}


def test_the_probe_is_named_the_way_the_region_stack_names_it():
    assert "functionName: `${project}-probe`," in source("lib/region-stack.ts")
    assert demo.PROBE_FUNCTION == "regional-affinity-probe"
    done = subprocess.run([sys.executable, "-B", "-c", "import demo; print(demo.PROBE_FUNCTION)"], capture_output=True, text=True,
                          env={"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(ROOT / "scripts"), "PROJECT": "my-demo"})
    assert done.stdout.strip() == "my-demo-probe", done.stderr


def test_the_plan_is_named_after_the_project_so_it_can_be_found_by_name():
    assert re.search(r"new arc\.CfnPlan\(this, 'Plan', \{\s*name: project,", source("lib/plan-stack.ts"))


# ---- a bad setting is one line, not a traceback ---------------------------------------------------


def run_script(*argv, **env):
    """scripts/demo.py in its own process, with only the settings given."""
    return subprocess.run([sys.executable, "-B", str(SCRIPT), *argv], capture_output=True, text=True, timeout=60,
                          env={"PATH": os.environ.get("PATH", ""), **env})


TWO = "it must name two different Regions, such as us-east-1,us-east-2"


@pytest.mark.parametrize("regions,reason", [
    (",", TWO),
    ("us-east-1", TWO),
    ("us-east-1,us-east-1", TWO),
    ("us-east-1,us-east-2,us-west-2", TWO),
    ("useast1,us-east-2", '"useast1" is not an AWS Region name such as us-east-1'),
    ("us-east-1,US-EAST-2", '"US-EAST-2" is not an AWS Region name such as us-east-1'),
    ("ap-south-1,ap-southeast-1", "ap-south-1 and ap-southeast-1 would get the same label, as1"),
])
def test_a_bad_regions_setting_ends_in_one_line_from_main(regions, reason):
    done = run_script("names", REGIONS=regions)
    assert done.returncode == 1 and done.stdout == ""
    assert "Traceback" not in done.stderr
    assert done.stderr == f'error: REGIONS="{regions}" cannot be used: {reason}\n'


def test_every_command_checks_the_setting_before_anything_else():
    done = run_script("drain", "us-east-1", REGIONS="useast1,us-east-2")
    assert done.returncode == 1 and "Traceback" not in done.stderr and "cannot be used" in done.stderr


def test_regions_may_have_spaces_around_them():
    done = run_script("names", "--json", REGIONS=" eu-west-1 , eu-central-1 ")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["regional"] == {
        "eu-west-1": "ingest.ew1.example.com", "eu-central-1": "ingest.ec1.example.com"}


def test_parse_regions_follows_parse_regions_in_names_ts():
    assert demo.parse_regions(" us-east-1 , us-west-2 ") == ("us-east-1", "us-west-2")
    for bad in ("", ",", "us-east-1", "us-east-1,us-east-1", "us-east-1,us-east-2,us-west-2", "ap-south-1,ap-southeast-1"):
        with pytest.raises(ValueError):
            demo.parse_regions(bad)
