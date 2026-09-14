#!/usr/bin/env bash
#
# Start the region-wide gray failure: arm the node fleet, then fan every per-AZ FIS
# experiment together.
#
# WHY A WRAPPER EXISTS AT ALL. FisNetworkExperiments emits one experiment template PER AZ
# (that is how the shipped construct is built). Starting ONE of them degrades a single
# availability zone, and a single sick AZ's correct answer is a zonal shift, not a Region
# switch -- an audience that knows this will say so. Starting all of them together is what
# makes the blast radius a Region, which is the failure this demo's failover answers.
#
# WHY TAGGING IS A SEPARATE, DELIBERATE STEP. The FIS targets select
# aws:ec2:instance by the tag ChaosAllowed=true. Managed-node-group instances are owned by
# an AWS-managed Auto Scaling group, so CloudFormation cannot tag them -- and that turns
# out to be useful: tagging IS the arming gesture. An experiment started against untagged
# instances resolves no targets and does nothing, so nothing here can fire by accident.
#
# Usage:
#   start-region-wide-injection.sh <region> <cluster-name> <nodegroup-name> <template-ids-csv>
#
# Template ids come from the RegionStack CfnOutputs FisLatencyTemplateIds /
# FisPacketLossTemplateIds / FisMemoryStressTemplateIds -- pick ONE fault's list per run.
# Mixing latency and packet loss in one run makes the resulting availability number
# impossible to attribute, and this band has to be calibrated against real numbers.
#
# THIS SCRIPT IS AN OPERATOR TOOL, NOT A PROJEN TASK. It never runs through projen's dax
# shell, so ordinary bash applies. It is still written to pass `bash -n`.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <region> <cluster-name> <nodegroup-name> <template-ids-csv>" >&2
  exit 2
fi

REGION="$1"
CLUSTER="$2"
NODEGROUP="$3"
IDS="$4"

echo "== resolving node instances for $NODEGROUP in $CLUSTER ($REGION)"
ASG=$(aws eks describe-nodegroup --region "$REGION" \
  --cluster-name "$CLUSTER" --nodegroup-name "$NODEGROUP" \
  --query 'nodegroup.resources.autoScalingGroups[0].name' --output text)
if [ -z "$ASG" ] || [ "$ASG" = None ]; then
  echo "could not resolve the node group's Auto Scaling group" >&2
  exit 1
fi

INSTANCES=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
  --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' \
  --output text)
if [ -z "$INSTANCES" ]; then
  echo "no InService instances in $ASG -- nothing to arm" >&2
  exit 1
fi
echo "   instances: $INSTANCES"

# The SSM agent must have REGISTERED for aws:ssm:send-command to reach these nodes. It
# needs the ssm/ssmmessages/ec2messages interface endpoints (added in step 3a/3b) because
# these subnets have no NAT. Checked here rather than discovered as a silent zero-target
# run: FIS would report success having done nothing.
echo "== checking SSM registration"
# COUNT CLIENT-SIDE, NOT WITH length(). describe-instance-information is paginated and
# the AWS CLI applies --query PER PAGE, so `length(InstanceInformationList)` returns one
# count per page once the result set exceeds the service's default MaxResults (10) --
# MANAGED becomes "10<tab>2" and the `-eq 0` test below dies with "integer expression
# expected". Asking for the IDs and counting words is page-count-independent. (Same trap
# that broke restore-steady-state.sh's kubectl discovery live on 2026-09-08.)
MANAGED=$(aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$(echo "$INSTANCES" | tr '\t' ',')" \
  --query 'InstanceInformationList[].InstanceId' --output text 2>/dev/null | wc -w)
COUNT=$(echo "$INSTANCES" | wc -w)
echo "   $MANAGED of $COUNT nodes are SSM-managed"
if [ "$MANAGED" -eq 0 ]; then
  echo "NO nodes are registered with Systems Manager. aws:ssm:send-command faults would" >&2
  echo "resolve zero targets and the experiment would report success having done nothing." >&2
  echo "Check the ssm, ssmmessages and ec2messages VPC endpoints and the node role." >&2
  exit 1
fi

echo "== arming: tagging instances ChaosAllowed=true"
# shellcheck disable=SC2086 -- word splitting is intended; INSTANCES is a space-separated list
aws ec2 create-tags --region "$REGION" --resources $INSTANCES \
  --tags Key=ChaosAllowed,Value=true
echo "   armed"

echo "== starting experiments (region-wide fan)"
IFS=',' read -ra ARR <<< "$IDS"
for T in "${ARR[@]}"; do
  EID=$(aws fis start-experiment --region "$REGION" --experiment-template-id "$T" \
    --tags Name=region-wide-gray-failure \
    --query 'experiment.id' --output text)
  echo "   started template $T as experiment $EID"
done

cat <<'NOTE'

== running.
Watch the DECISION alarm (<demo>-ClientAvailability, availability < 99% for 3 of 5
minutes). Target band is roughly 90-96%: high enough that the guardrail (< 50%) does not
stop the experiment, low enough that the decision signal fires and stays lit. That band
is the demo's main tuning number and MUST be checked against real numbers here -- it was
chosen from the alarm arithmetic, not measured.

If availability sits above 99%, the fault is too gentle to be a signal. If the guardrail
fires, the experiment stops itself and the story ends before the human decides.

To stop early:   aws fis stop-experiment --region <region> --id <experiment-id>
To disarm:       aws ec2 delete-tags --region <region> --resources <ids> --tags Key=ChaosAllowed
NOTE
