#!/usr/bin/env bash
# drs-ec2 teardown -- everything, all three regions, unattended, PARALLEL where the dependency
# graph allows. Hard edges (CloudFormation exports / DRS ENIs) are the only serialization:
#   * app-primary and db-primary import from net-primary; app-primary imports db-primary's writer endpoint
#   * db-secondary and alb-secondary import from net-secondary; db-secondary must leave the
#     global cluster before db-primary can go
#   * DRS recovery instances sit in app-primary's / alb-secondary's security groups -> DRS unwind first
#   * iam after app-primary (instance profile); networks last
# Waves (each wave's members run concurrently):
#   1. [DRS unwind -> app-primary || alb-secondary] || db-secondary || plan || drs-steps-{primary,secondary} || observer || app-code bucket
#   2. db-primary || iam
#   3. DRS-created security groups swept, then net-primary || net-secondary; runtime SSM residue
# Critical path ~ max(DRS+04, 03b) + 03a + nets  (~30 min)  vs ~60 min fully serial.
# Usage: teardown.sh <aws-profile>
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""   # usage: teardown.sh [aws-profile|-]; empty/- = default credential chain
PRIMARY="${PRIMARY_REGION:-us-east-2}"; SECONDARY="${SECONDARY_REGION:-us-west-2}"; OBSERVER="${OBSERVER_REGION:-us-east-1}"; PROJECT="${PROJECT:-drsdemo}"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }  # never page; profile optional
ACCT=$(aws sts get-caller-identity --query Account --output text)

del() { # del <region> <stack>  -- idempotent; re-issues once on DELETE_FAILED, prints the failing resources
  aws cloudformation describe-stacks --region "$1" --stack-name "$2" >/dev/null 2>&1 || { echo "== [$1] $2: absent =="; return 0; }
  echo "== [$1] delete $2 =="
  local attempt st
  for attempt in 1 2; do
    aws cloudformation delete-stack --region "$1" --stack-name "$2"
    aws cloudformation wait stack-delete-complete --region "$1" --stack-name "$2" 2>/dev/null && return 0
    st=$(aws cloudformation describe-stacks --region "$1" --stack-name "$2" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo GONE)
    [[ "$st" == GONE ]] && return 0
    echo "   [$1] $2 is $st after attempt $attempt:"
    aws cloudformation describe-stack-events --region "$1" --stack-name "$2" \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output text | sort -u | head -5 | sed 's/^/      /'
    [[ $attempt == 1 ]] && sleep 20
  done
}

drs_regions() { for r in "$SECONDARY" "$PRIMARY"; do aws drs describe-source-servers --region "$r" >/dev/null 2>&1 && echo "$r"; done; }

drs_phase1() { # <region>: stop replication on every source server (releases "during failback")
  local r=$1
  for ss in $(aws drs describe-source-servers --region "$r" --query "items[?dataReplicationInfo.dataReplicationState!='STOPPED' && dataReplicationInfo.dataReplicationState!='DISCONNECTED'].sourceServerID" --output text); do
    echo "   [$r] stop-replication $ss"; aws drs stop-replication --region "$r" --source-server-id "$ss" >/dev/null 2>&1 || true
  done
  for i in $(seq 1 30); do
    left=$(aws drs describe-source-servers --region "$r" --query "length(items[?dataReplicationInfo.dataReplicationState!='STOPPED' && dataReplicationInfo.dataReplicationState!='DISCONNECTED'])" --output text 2>/dev/null || echo 0)
    [[ "$left" == 0 ]] && break; sleep 10
  done
}
drs_phase2() { # <region>: stop failback, terminate recovery instances, wait TERMINATED
  local r=$1 ris out
  for ri in $(aws drs describe-recovery-instances --region "$r" --query "items[?failback.state!='FAILBACK_NOT_STARTED'].recoveryInstanceID" --output text); do
    echo "   [$r] stop-failback $ri"; aws drs stop-failback --region "$r" --recovery-instance-id "$ri" >/dev/null 2>&1 || true
  done
  ris=$(aws drs describe-recovery-instances --region "$r" --query "items[?ec2InstanceState!='TERMINATED'].recoveryInstanceID" --output text)
  [[ -z "$ris" ]] && return 0
  echo "   [$r] terminating: $ris"
  for attempt in $(seq 1 12); do
    out=$(aws drs terminate-recovery-instances --region "$r" --recovery-instance-ids $ris 2>&1) && break
    echo "   [$r] terminate refused; retry $attempt in 20s :: ${out##*: }"; sleep 20
  done
  for i in $(seq 1 40); do
    left=$(aws drs describe-recovery-instances --region "$r" --query "length(items[?ec2InstanceState!='TERMINATED'])" --output text 2>/dev/null || echo 0)
    [[ "$left" == 0 ]] && break; sleep 15
  done
}
drs_phase3() { # <region>: disconnect + delete source servers, FAILBACK first, then FAILOVER, then sweep
  local r=$1 st
  for direction in FAILBACK FAILOVER; do
    for ss in $(aws drs describe-source-servers --region "$r" --query "items[?replicationDirection=='$direction'].sourceServerID" --output text); do
      echo "   [$r] disconnect + delete $direction source server $ss"
      aws drs disconnect-source-server --region "$r" --source-server-id "$ss" >/dev/null 2>&1 || true
      for i in $(seq 1 20); do
        st=$(aws drs describe-source-servers --region "$r" --filters sourceServerIDs="$ss" --query 'items[0].dataReplicationInfo.dataReplicationState' --output text 2>/dev/null || echo DISCONNECTED)
        [[ "$st" == DISCONNECTED || "$st" == None || -z "$st" ]] && break; sleep 10
      done
      aws drs delete-source-server --region "$r" --source-server-id "$ss" >/dev/null 2>&1 || echo "   [$r] delete $ss failed (will not block stack deletes)"
    done
  done
  for ss in $(aws drs describe-source-servers --region "$r" --query 'items[].sourceServerID' --output text); do
    aws drs disconnect-source-server --region "$r" --source-server-id "$ss" >/dev/null 2>&1 || true
    aws drs delete-source-server --region "$r" --source-server-id "$ss" >/dev/null 2>&1 || true
  done
}
drs_cleanup_all() {
  # After a stateful fail-back the estate is cross-linked: a recovery instance in one region is
  # the SOURCE of a FAILBACK-direction server in the other, and DRS refuses to terminate a
  # recovery instance "during failback". Unwind in the DRS-documented order; each phase must
  # finish in BOTH regions before the next starts (the linkage crosses regions), but within a
  # phase the two regions run concurrently.
  local regions; regions=$(drs_regions); [[ -z "$regions" ]] && { echo "== DRS not initialized anywhere ==" ; return 0; }
  echo "== DRS phase 1: stop replication (both regions) ==";           for r in $regions; do drs_phase1 "$r" & done; wait
  echo "== DRS phase 2: stop failback + terminate (both regions) ==";  for r in $regions; do drs_phase2 "$r" & done; wait
  echo "== DRS phase 3: delete source servers (both regions) ==";     for r in $regions; do drs_phase3 "$r" & done; wait
}

empty_bucket() { # empty_bucket <bucket> <region>
  aws s3api head-bucket --bucket "$1" --region "$2" >/dev/null 2>&1 || return 0
  echo "== remove bucket $1 =="
  aws s3 rm "s3://$1" --recursive --region "$2" --only-show-errors || true
  aws s3 rb "s3://$1" --region "$2" || true
}

# ---- Wave 1: everything with no unmet dependency, concurrently ----
echo "=== wave 1: DRS->app/alb | aurora-secondary | plan | lambdas | observer | buckets ==="
( drs_cleanup_all
  del "$PRIMARY"   "${PROJECT}-app-primary" &
  del "$SECONDARY" "${PROJECT}-alb-secondary" &
  wait ) &
del "$SECONDARY" "${PROJECT}-db-secondary" &   # must leave the global cluster before db-primary
del "$PRIMARY"   "${PROJECT}-plan" &
del "$SECONDARY" "${PROJECT}-drs-steps-secondary" &
del "$PRIMARY"   "${PROJECT}-drs-steps-primary" &
del "$OBSERVER"  "${PROJECT}-observer" &              # peerings + observer routes go with it
empty_bucket "${PROJECT}-app-code-${ACCT}-${PRIMARY}" "$PRIMARY" &
wait

# ---- Wave 2: db-primary (needs 03b gone from the global cluster and 04's import released),
#              iam (needs 04's instance profile and 07's roles released) ----
echo "=== wave 2: db-primary | iam ==="
del "$PRIMARY" "${PROJECT}-db-primary" &
del "$PRIMARY" "${PROJECT}-iam" &
wait

# ---- Wave 3: networks. DRS creates two security groups per VPC OUTSIDE CloudFormation when a
#      region is initialized ("default Replication Server" / "default Conversion Server" SGs) and
#      never removes them, so the VPC delete fails with "has dependencies" (live, 2026-09-11). ----
sweep_drs_sgs() { # sweep_drs_sgs <region> <net-stack>
  local vpc; vpc=$(aws cloudformation describe-stack-resources --region "$1" --stack-name "$2" \
    --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" --output text 2>/dev/null) || return 0
  [[ -z "$vpc" || "$vpc" == None ]] && return 0
  for sg in $(aws ec2 describe-security-groups --region "$1" --filters Name=vpc-id,Values="$vpc" \
      --query "SecurityGroups[?starts_with(GroupName,'AWS Elastic Disaster Recovery')].GroupId" --output text); do
    echo "   [$1] delete DRS-created security group $sg in $vpc"
    aws ec2 delete-security-group --region "$1" --group-id "$sg" >/dev/null 2>&1 || echo "   [$1] $sg still referenced"
  done
}
echo "=== wave 3: networks ==="
sweep_drs_sgs "$PRIMARY"   "${PROJECT}-net-primary"
sweep_drs_sgs "$SECONDARY" "${PROJECT}-net-secondary"
del "$PRIMARY"   "${PROJECT}-net-primary" &
del "$SECONDARY" "${PROJECT}-net-secondary" &
wait

# ---- Residue created at RUNTIME, outside CloudFormation ----
#  * /drsdemo/db-writer-endpoint in the SECONDARY: written by register_target during a failover
#    (stack 04 owns only the primary copy). Lambda log groups are CloudFormation-owned (stack 07).
echo "=== runtime residue: secondary SSM parameter ==="
aws ssm delete-parameter --region "$SECONDARY" --name "/${PROJECT}/db-writer-endpoint" >/dev/null 2>&1 && echo "   [$SECONDARY] deleted /${PROJECT}/db-writer-endpoint" || true

echo "=== teardown complete ==="
