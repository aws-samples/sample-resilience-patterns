#!/usr/bin/env bash
# Multi-cycle proof for drs-ec2: run N legs alternating ACTIVATE us-west-2 / ACTIVATE
# us-east-2 through the ARC plan, and after EVERY fail-back assert the resting-state invariant:
#   * exactly one FAILOVER source server tagged drsdemo:role=app in the secondary, CONTINUOUS,
#     protecting the SAME primary EC2 id as before the cycle;
#   * no recovery instances in either region; no FAILBACK source servers;
#   * secondary target group empty; Aurora writer + ARC health checks back on the primary.
# In stateful mode (STATEFUL_EC2=true) a marker file is written to the SERVING EC2's disk via SSM
# before each leg and asserted present on the other side afterwards -- i.e. state really rides
# the DRS replication both ways.
#
# Usage: rehearse-cycle.sh <aws-profile> [legs=4] [graceful|ungraceful]
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""   # usage: rehearse-cycle.sh [aws-profile|-] [legs] [graceful|ungraceful]
LEGS="${2:-4}"; MODE="${3:-graceful}"
PRIMARY="${PRIMARY_REGION:-us-east-2}"; SECONDARY="${SECONDARY_REGION:-us-west-2}"; PROJECT="${PROJECT:-drsdemo}"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }  # never page; profile optional
outp() { aws cloudformation describe-stacks --region "$1" --stack-name "$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text; }
fail() { echo "FAIL: $*"; exit 1; }

PLAN=$(outp "$PRIMARY" "${PROJECT}-plan" SwitchoverPlanArn)
SEC_TG=$(outp "$SECONDARY" "${PROJECT}-alb-secondary" SecondaryTargetGroupArn)
STATEFUL=$(aws cloudformation describe-stacks --region "$SECONDARY" --stack-name "${PROJECT}-drs-steps-secondary" \
  --query "Stacks[0].Parameters[?ParameterKey=='StatefulEc2'].ParameterValue" --output text)
PRIMARY_EC2=$(outp "$PRIMARY" "${PROJECT}-app-primary" AppInstanceId)
echo "plan=$PLAN stateful=$STATEFUL primary_ec2=$PRIMARY_EC2 legs=$LEGS mode=$MODE"

writer_region() { aws rds describe-global-clusters --region "$PRIMARY" --global-cluster-identifier "${PROJECT}-global" \
  --query 'GlobalClusters[0].GlobalClusterMembers[?IsWriter].DBClusterArn|[0]' --output text | cut -d: -f4; }
hc() { aws arc-region-switch list-route53-health-checks --region "$PRIMARY" --arn "$PLAN" --query "healthChecks[?region=='$1'].status|[0]" --output text; }
protected_ec2() { aws drs describe-source-servers --region "$SECONDARY" \
  --query "items[?replicationDirection=='FAILOVER' && tags.\"drsdemo:role\"=='app'].sourceProperties.identificationHints.awsInstanceID | [0]" --output text; }
fwd_state() { aws drs describe-source-servers --region "$SECONDARY" \
  --query "items[?replicationDirection=='FAILOVER' && tags.\"drsdemo:role\"=='app'].dataReplicationInfo.dataReplicationState | [0]" --output text; }
recovery_count() { aws drs describe-recovery-instances --region "$1" --query "length(items[?ec2InstanceState!='TERMINATED'])" --output text; }
failback_count() { aws drs describe-source-servers --region "$1" --query "length(items[?replicationDirection=='FAILBACK'])" --output text; }
serving_ec2() {  # the instance currently serving: recovery instance in secondary, else primary
  local r; r=$(aws drs describe-recovery-instances --region "$SECONDARY" --query "items[?ec2InstanceState=='RUNNING'].ec2InstanceID|[0]" --output text)
  [[ -n "$r" && "$r" != None ]] && echo "$SECONDARY $r" || echo "$PRIMARY $PRIMARY_EC2"; }

run_plan() { # run_plan <target-region> <mode>
  local ex; ex=$(aws arc-region-switch start-plan-execution --region "$1" --plan-arn "$PLAN" --target-region "$1" --action activate --mode "$2" \
        --comment "rehearse-cycle leg" --query executionId --output text)
  echo "  execution $ex"; local id="${ex##*/}" st
  for i in $(seq 1 720); do
    st=$(aws arc-region-switch get-plan-execution --region "$1" --plan-arn "$PLAN" --execution-id "$id" --query executionState --output text)
    case "$st" in completed) echo "  -> completed"; return 0;; completedWithExceptions|failed|canceled|pausedByFailedStep) fail "execution $ex ended $st";; esac
    sleep 20
  done; fail "execution $ex did not finish in 4h"
}

ssm_run() { # ssm_run <region> <instance> <command>  (prints stdout)
  local cid; cid=$(aws ssm send-command --region "$1" --instance-ids "$2" --document-name AWS-RunShellScript --parameters "commands=[\"$3\"]" --query Command.CommandId --output text)
  for i in $(seq 1 30); do
    local s; s=$(aws ssm get-command-invocation --region "$1" --command-id "$cid" --instance-id "$2" --query Status --output text 2>/dev/null || echo Pending)
    case "$s" in Success) aws ssm get-command-invocation --region "$1" --command-id "$cid" --instance-id "$2" --query StandardOutputContent --output text; return 0;;
                 Failed|Cancelled|TimedOut) fail "ssm command $s on $2";; esac; sleep 4
  done; fail "ssm command timed out on $2"
}

assert_resting() {
  echo "  asserting resting-state invariant..."
  # ARC health-check status, DRS lifecycle and TG membership settle asynchronously for a minute
  # or so after an execution reports completed; re-evaluate rather than fail on the first read.
  local why i
  for i in $(seq 1 20); do
    why=""
    [[ "$(writer_region)" == "$PRIMARY" ]] || why="writer not in $PRIMARY"
    [[ -n "$why" || ( "$(hc "$PRIMARY")" == healthy && "$(hc "$SECONDARY")" == unhealthy ) ]] || why="ARC health checks not primary-healthy/secondary-unhealthy"
    [[ -n "$why" || "$(protected_ec2)" == "$PRIMARY_EC2" ]] || why="protected primary is $(protected_ec2), expected $PRIMARY_EC2 (identity drifted)"
    [[ -n "$why" || "$(fwd_state)" == CONTINUOUS ]] || why="forward replication is $(fwd_state)"
    [[ -n "$why" || ( "$(recovery_count "$SECONDARY")" == 0 && "$(recovery_count "$PRIMARY")" == 0 ) ]] || why="recovery instances remain"
    [[ -n "$why" || ( "$(failback_count "$PRIMARY")" == 0 && "$(failback_count "$SECONDARY")" == 0 ) ]] || why="FAILBACK source servers remain"
    [[ -n "$why" || "$(aws elbv2 describe-target-health --region "$SECONDARY" --target-group-arn "$SEC_TG" --query 'length(TargetHealthDescriptions)' --output text)" == 0 ]] || why="secondary TG not empty"
    [[ -z "$why" ]] && { echo "  invariant holds"; return 0; }
    echo "  not settled yet ($why); recheck $i/20 in 15s"; sleep 15
  done
  fail "invariant did not settle within 5 min: $why"
}

echo "== leg 0: baseline =="; assert_resting
for leg in $(seq 1 "$LEGS"); do
  read -r cur_region cur_ec2 <<<"$(serving_ec2)"
  if [[ "$STATEFUL" == true ]]; then
    marker="leg${leg}-$(date -u +%s)"; echo "  writing marker '$marker' on $cur_ec2 ($cur_region)"
    ssm_run "$cur_region" "$cur_ec2" "echo $marker >> /opt/app/cycle-markers && sync" >/dev/null
  fi
  if (( leg % 2 == 1 )); then
    echo "== leg $leg: ACTIVATE $SECONDARY ($MODE) =="; run_plan "$SECONDARY" "$MODE"
    [[ "$(writer_region)" == "$SECONDARY" ]] || fail "writer not in $SECONDARY after leg $leg"
    read -r new_region new_ec2 <<<"$(serving_ec2)"; [[ "$new_region" == "$SECONDARY" ]] || fail "no recovery instance serving after leg $leg"
  else
    echo "== leg $leg: ACTIVATE $PRIMARY (graceful fail-back) =="; run_plan "$PRIMARY" graceful
    assert_resting; new_region=$PRIMARY; new_ec2=$PRIMARY_EC2
  fi
  if [[ "$STATEFUL" == true ]]; then
    echo "  checking markers on $new_ec2 ($new_region)"
    got=$(ssm_run "$new_region" "$new_ec2" "cat /opt/app/cycle-markers 2>/dev/null | wc -l" | tr -d '[:space:]')
    [[ "$got" -ge "$leg" ]] || fail "expected >= $leg markers on $new_ec2 after leg $leg, found $got -- state did not ride the replication"
    echo "  $got marker(s) present: state carried across leg $leg"
  fi
done
echo "=== $LEGS legs complete; estate back at resting state; primary EC2 identity $PRIMARY_EC2 preserved ==="
