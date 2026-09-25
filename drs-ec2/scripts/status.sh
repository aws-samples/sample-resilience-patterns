#!/usr/bin/env bash
# Resting-state check: Aurora writer, ARC health checks + plan evaluation from BOTH regional
# endpoints, DRS source servers / recovery instances, secondary target group, observer bastion.
# Usage: status.sh [aws-profile|-]
set -uo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""
PRIMARY="${PRIMARY_REGION:-us-east-2}"; SECONDARY="${SECONDARY_REGION:-us-west-2}"; OBSERVER="${OBSERVER_REGION:-us-east-1}"; PROJECT="${PROJECT:-drsdemo}"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }
outp() { aws cloudformation describe-stacks --region "$1" --stack-name "${PROJECT}-$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text 2>/dev/null; }

PLAN=$(outp "$PRIMARY" plan SwitchoverPlanArn)
echo "plan:        ${PLAN:-<none>}"
echo "writer:      $(aws rds describe-global-clusters --region "$PRIMARY" --global-cluster-identifier "${PROJECT}-global" \
  --query 'GlobalClusters[0].GlobalClusterMembers[?IsWriter].DBClusterArn|[0]' --output text 2>/dev/null | cut -d: -f4)"
if [[ -n "$PLAN" && "$PLAN" != None ]]; then
  echo "arc hc:      $(aws arc-region-switch list-route53-health-checks --region "$PRIMARY" --arn "$PLAN" --query 'healthChecks[].join(`=`,[region,status])' --output text | tr '\t' ' ')"
  for r in "$PRIMARY" "$SECONDARY"; do
    echo "eval $r: $(aws arc-region-switch get-plan-evaluation-status --region "$r" --plan-arn "$PLAN" --query evaluationState --output text 2>&1 | head -1)"
  done
fi
echo "drs $SECONDARY:"; aws drs describe-source-servers --region "$SECONDARY" \
  --query 'items[].join(`  `,[sourceServerID,replicationDirection,dataReplicationInfo.dataReplicationState,sourceProperties.identificationHints.awsInstanceID,to_string(tags)])' --output text 2>/dev/null | sed 's/^/  /'
echo "recovery instances: $(aws drs describe-recovery-instances --region "$SECONDARY" --query 'items[?ec2InstanceState!=`TERMINATED`].join(`:`,[ec2InstanceID,ec2InstanceState])' --output text 2>/dev/null || echo none)"
TG=$(outp "$SECONDARY" alb-secondary SecondaryTargetGroupArn)
[[ -n "$TG" && "$TG" != None ]] && echo "secondary tg: $(aws elbv2 describe-target-health --region "$SECONDARY" --target-group-arn "$TG" --query 'TargetHealthDescriptions[].join(`:`,[Target.Id,TargetHealth.State])' --output text) (empty = at rest)"
B=$(outp "$OBSERVER" observer BastionInstanceId)
[[ -n "$B" && "$B" != None ]] && echo "observer bastion: $B ($(aws ssm describe-instance-information --region "$OBSERVER" --filters "Key=InstanceIds,Values=$B" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null))"
exit 0
