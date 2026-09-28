#!/usr/bin/env bash
# End-to-end DRS setup for drs-ec2, driven entirely from here (no host SSH):
#   1. Initialize DRS in the SECONDARY region (us-west-2) + create a replication template
#      pinned to the real staging subnet.
#   2. Wait for the app EC2 (primary region) to exist and register with SSM.
#   3. Install + run the DRS replication agent on the EC2 via SSM Send-Command, targeting
#      the DRS endpoint in the secondary region.
#   4. Wait for a DRS source server to appear, configure its launch template, tag it, and wait
#      for forward replication to reach CONTINUOUS (the resting state `make deploy` ends at).
#
# Usage: drs-setup.sh [aws-profile|-]   (- or empty = default credential chain)
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""   # usage: drs-setup.sh [aws-profile|-]; empty/- = default credential chain
PRIMARY="${PRIMARY_REGION:-us-east-2}"; SECONDARY="${SECONDARY_REGION:-us-west-2}"; PROJECT="${PROJECT:-drsdemo}"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }  # never page; profile optional

# init_drs_region <region> <staging-subnet-id>
# Idempotent: initialize-service + one replication configuration template. Called for
# the SECONDARY (forward replication target) AND the PRIMARY: reversed replication --
# the fail-back prototype in lambda/drs_reverse_replicate.py -- creates its source
# server in the PRIMARY and needs a template + staging subnet there too.
init_drs_region() {
  local R="$1" STAGING_SUBNET="$2"
  echo "== [1] DRS initialize-service in $R =="
  # initialize-service needs the six AWSElasticDisasterRecovery*Role service roles (with instance
  # profiles for the four EC2-trust ones) and fails with "Failed to attach the following IAM roles to
  # their instance profiles" when any is missing. create-drs-service-roles.py is idempotent; run it
  # first, WITH the profile -- boto3's default chain is not the shell's `aws --profile` identity.
  python3 "$(dirname "$0")/create-drs-service-roles.py" \
    "$(aws sts get-caller-identity --query Account --output text)" "${PROFILE:--}"
  if ! OUT=$(aws drs initialize-service --region "$R" 2>&1); then
    if aws drs describe-replication-configuration-templates --region "$R" >/dev/null 2>&1; then
      echo "(already initialized)"
    else
      echo "ERROR: initialize-service failed and account is NOT initialized:"; echo "$OUT"; exit 1
    fi
  fi

  echo "staging subnet: $STAGING_SUBNET"

  TPL=$(aws drs describe-replication-configuration-templates --region "$R" \
    --query 'items[0].replicationConfigurationTemplateID' --output text 2>/dev/null || echo "None")
  if [[ "$TPL" == "None" || -z "$TPL" ]]; then
    echo "creating replication configuration template..."
    # pitPolicy MUST be the full MINUTE+HOUR+DAY ladder. A single MINUTE-only rule is
    # rejected as "Invalid request body" (bisected live 2026-09-10; the dedicated-server
    # flag and createPublicIP were innocent). Staging subnet is private w/ NAT -> no public IP.
    # useDedicatedReplicationServer=false: one shared t3.small carries all source servers.
    aws drs create-replication-configuration-template --region "$R" \
      --associate-default-security-group --bandwidth-throttling 0 --no-create-public-ip \
      --data-plane-routing PRIVATE_IP --default-large-staging-disk-type GP3 \
      --ebs-encryption DEFAULT \
      --pit-policy '[{"enabled":true,"interval":10,"retentionDuration":60,"units":"MINUTE","ruleID":1},{"enabled":true,"interval":1,"retentionDuration":24,"units":"HOUR","ruleID":2},{"enabled":true,"interval":1,"retentionDuration":7,"units":"DAY","ruleID":3}]' \
      --replication-server-instance-type t3.small --replication-servers-security-groups-ids '[]' \
      --staging-area-subnet-id "$STAGING_SUBNET" --staging-area-tags '{}' \
      --no-use-dedicated-replication-server --query replicationConfigurationTemplateID --output text
  else
    # The template is ACCOUNT-level and outlives our stacks. After a teardown/redeploy it still
    # names the OLD staging subnet -> replication stalls at CREATE_SECURITY_GROUP with
    # FAILED_TO_CREATE_SECURITY_GROUP (live, 2026-09-11). Reconcile it to the current subnet.
    CUR=$(aws drs describe-replication-configuration-templates --region "$R" \
      --query 'items[0].stagingAreaSubnetId' --output text)
    if [[ "$CUR" != "$STAGING_SUBNET" ]]; then
      echo "replication template $TPL: staging subnet $CUR -> $STAGING_SUBNET"
      aws drs update-replication-configuration-template --region "$R" \
        --replication-configuration-template-id "$TPL" --staging-area-subnet-id "$STAGING_SUBNET" \
        --replication-servers-security-groups-ids '[]' --associate-default-security-group >/dev/null
    else
      echo "replication template exists: $TPL (staging subnet current)"
    fi
  fi
}

SEC_STAGING=$(aws cloudformation describe-stacks --region "$SECONDARY" \
  --stack-name "${PROJECT}-net-secondary" --query "Stacks[0].Outputs[?OutputKey=='PrivateSubnets'].OutputValue" --output text | cut -d, -f1)
STAGING_SUBNET="$SEC_STAGING"   # used again by the launch-template step below
PRI_STAGING=$(aws cloudformation describe-stacks --region "$PRIMARY" \
  --stack-name "${PROJECT}-net-primary" --query "Stacks[0].Outputs[?OutputKey=='PrivateSubnets'].OutputValue" --output text | cut -d, -f1)
init_drs_region "$SECONDARY" "$SEC_STAGING"
init_drs_region "$PRIMARY" "$PRI_STAGING"   # for reversed replication (fail-back prototype)
# Primary-region DRS launch template default: fail back ONTO the original instance (same id,
# same CFN identity, already in the target group) instead of launching a new one. Requires the
# AWSDRS=AllowLaunchingIntoThisInstance tag and BIOS boot on the target (t2.small in 04).
LCT=$(aws drs describe-launch-configuration-templates --region "$PRIMARY" --query 'items[0].launchConfigurationTemplateID' --output text 2>/dev/null || echo None)
if [[ -n "$LCT" && "$LCT" != None ]]; then
  aws drs update-launch-configuration-template --region "$PRIMARY" --launch-configuration-template-id "$LCT" \
    --launch-into-source-instance --no-copy-private-ip --no-copy-tags >/dev/null && echo "primary launch template $LCT: launchIntoSourceInstance=true"
else
  aws drs create-launch-configuration-template --region "$PRIMARY" --launch-into-source-instance --no-copy-private-ip --no-copy-tags \
    --launch-disposition STARTED --target-instance-type-right-sizing-method NONE --query launchConfigurationTemplateID --output text | sed 's/^/created primary launch template: /'
fi

echo "== [2] wait for app EC2 + SSM registration =="
for i in $(seq 1 40); do
  IID=$(aws cloudformation describe-stacks --region "$PRIMARY" --stack-name "${PROJECT}-app-primary" \
    --query "Stacks[0].Outputs[?OutputKey=='AppInstanceId'].OutputValue" --output text 2>/dev/null || echo "")
  [[ -n "$IID" && "$IID" != "None" ]] && break
  echo "  app stack not ready yet ($i)"; sleep 30
done
[[ -z "${IID:-}" || "$IID" == "None" ]] && { echo "ERROR: app EC2 not found"; exit 1; }
echo "app instance: $IID"
for i in $(seq 1 30); do
  PING=$(aws ssm describe-instance-information --region "$PRIMARY" \
    --filters "Key=InstanceIds,Values=$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo "")
  [[ "$PING" == "Online" ]] && break
  echo "  waiting for SSM Online ($i): ${PING:-none}"; sleep 20
done
[[ "${PING:-}" == "Online" ]] || { echo "ERROR: $IID is not SSM Online after 10 min (last: ${PING:-none}); the agent install and the app refresh both run through SSM"; exit 1; }
echo "SSM ping: $PING"

# A CloudFormation instance REPLACEMENT (UserData or AMI change) leaves the old instance's source
# server behind, still tagged ${PROJECT}:role=app. The plan's Lambdas select the source server by
# that tag and must never see two candidates, so retire any forward-replication server that does
# not belong to the current app instance before (re)installing the agent.
for STALE in $(aws drs describe-source-servers --region "$SECONDARY" \
    --query "items[?replicationDirection!='FAILBACK' && sourceProperties.identificationHints.awsInstanceID!='$IID' && tags.\"${PROJECT}:role\"=='app'].sourceServerID" \
    --output text 2>/dev/null); do
  [[ -z "$STALE" || "$STALE" == "None" ]] && continue
  echo "== [2b] retiring stale source server $STALE (its instance is not $IID) =="
  aws drs disconnect-source-server --region "$SECONDARY" --source-server-id "$STALE" >/dev/null 2>&1 || true
  aws drs delete-source-server --region "$SECONDARY" --source-server-id "$STALE" >/dev/null
done

# Idempotency: if THIS instance already has a source server that is replicating, skip the
# install (re-running the installer on a protected host re-registers and forces a full resync).
EXISTING=$(aws drs describe-source-servers --region "$SECONDARY" \
  --query "items[?sourceProperties.identificationHints.awsInstanceID=='$IID'] | [0].[sourceServerID,dataReplicationInfo.dataReplicationState]" \
  --output text 2>/dev/null || echo "None")
if [[ "$EXISTING" != "None" && -n "$EXISTING" && "$EXISTING" != *"DISCONNECTED"* && "$EXISTING" != *"STOPPED"* ]]; then
  echo "== [3] agent already installed: source server ${EXISTING%%	*} (${EXISTING##*	}) -- skipping install =="
  SKIP_INSTALL=1
fi

echo "== [3] install DRS agent via SSM Send-Command =="
if [[ -z "${SKIP_INSTALL:-}" ]]; then
  # The agent installer registers a source server into DRS in the secondary region. It needs
  # the region + AK/SK OR an instance-role; the app instance role has the DRS agent policy.
  # One JSON list element PER LINE. Feeding the whole heredoc as a single element made SSM run
  # it as one line ("set -eux cd /tmp curl ..." -> "set: -c: invalid option"). AL2023 /tmp is a
  # ~457MB tmpfs; the installer extracts under TMPDIR, so point it at the root volume.
  CMDS=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' \
    "set -eux" \
    "mkdir -p /opt/drs/tmp && export TMPDIR=/opt/drs/tmp && cd /opt/drs/tmp" \
    "curl -fsS -o aws-replication-installer-init https://aws-elastic-disaster-recovery-${SECONDARY}.s3.${SECONDARY}.amazonaws.com/latest/linux/aws-replication-installer-init" \
    "chmod +x aws-replication-installer-init" \
    "./aws-replication-installer-init --region ${SECONDARY} --no-prompt; rc=\$?; echo INSTALLER_EXIT=\$rc; exit \$rc")
  CMDID=$(aws ssm send-command --region "$PRIMARY" --instance-ids "$IID" \
    --document-name "AWS-RunShellScript" \
    --comment "drs-ec2 DRS agent install" \
    --parameters "{\"commands\":$CMDS,\"executionTimeout\":[\"1200\"]}" \
    --timeout-seconds 1200 --query 'Command.CommandId' --output text)
  echo "send-command id: $CMDID"
  for i in $(seq 1 40); do
    ST=$(aws ssm get-command-invocation --region "$PRIMARY" --command-id "$CMDID" --instance-id "$IID" \
      --query 'Status' --output text 2>/dev/null || echo "Pending")
    echo "  agent install status ($i): $ST"
    [[ "$ST" == "Success" ]] && break
    [[ "$ST" == "Failed" || "$ST" == "Cancelled" || "$ST" == "TimedOut" ]] && {
      echo "--- stderr ---"; aws ssm get-command-invocation --region "$PRIMARY" --command-id "$CMDID" --instance-id "$IID" --query 'StandardErrorContent' --output text | tail -30; exit 1; }
    sleep 30
  done
fi

echo "== [4] wait for DRS source server registration =="
for i in $(seq 1 30); do
  # Match THIS app instance (identificationHints.awsInstanceID); after a stateful fail-back or a
  # redeploy there can be several source servers, and items[0] is not necessarily ours.
  SS=$(aws drs describe-source-servers --region "$SECONDARY" \
    --query "items[?sourceProperties.identificationHints.awsInstanceID=='$IID'].sourceServerID | [0]" --output text 2>/dev/null || echo "None")
  [[ -n "$SS" && "$SS" != "None" ]] && { echo "source server registered: $SS"; break; }
  echo "  no source server yet ($i)"; sleep 30
done
# Everything after this point (launch template, replication config, the tag the plan selects by,
# the wait for CONTINUOUS) needs the source server. Without it `make deploy` used to print
# "DRS setup done" and exit 0 with nothing protected.
[[ -n "${SS:-}" && "$SS" != "None" ]] || { echo "ERROR: no DRS source server registered for $IID within 15 min; the agent install reported success but DRS never saw the server"; exit 1; }
# [5] Configure the DRS launch template. DRS auto-creates one per source server with NO
#     subnet/SG/instance-profile -- a recovery launch then FAILS silently (job log shows
#     SNAPSHOT_END -> JOB_END with no error; launchStatus=FAILED). Proven live 2026-09-10.
if [[ -n "${SS:-}" && "$SS" != "None" ]]; then
  echo "== [5] configure DRS launch template for $SS =="
  LT=$(aws drs get-launch-configuration --region "$SECONDARY" --source-server-id "$SS" --query ec2LaunchTemplateID --output text)
  APP_SG=$(aws cloudformation describe-stacks --region "$SECONDARY" --stack-name "${PROJECT}-alb-secondary" \
    --query "Stacks[0].Outputs[?OutputKey=='RecoveredAppSecurityGroupId'].OutputValue" --output text)
  PROFILE_ARN=$(aws iam get-instance-profile --instance-profile-name "${PROJECT}-app-instance-profile" --query InstanceProfile.Arn --output text)
  V=$(aws ec2 create-launch-template-version --region "$SECONDARY" --launch-template-id "$LT" --source-version '$Default' \
    --version-description "${PROJECT}: recovery subnet+sg+profile" \
    --launch-template-data "{\"InstanceType\":\"t2.small\",\"IamInstanceProfile\":{\"Arn\":\"$PROFILE_ARN\"},\"NetworkInterfaces\":[{\"DeviceIndex\":0,\"SubnetId\":\"$STAGING_SUBNET\",\"Groups\":[\"$APP_SG\"],\"AssociatePublicIpAddress\":false}]}" \
    --query LaunchTemplateVersion.VersionNumber --output text)
  aws ec2 modify-launch-template --region "$SECONDARY" --launch-template-id "$LT" --default-version "$V" >/dev/null
  # BASIC right-sizing overrides the template instance type (picked c5.large); pin to the template.
  aws drs update-launch-configuration --region "$SECONDARY" --source-server-id "$SS" --target-instance-type-right-sizing-method NONE >/dev/null
  echo "launch template $LT default v$V: subnet=$STAGING_SUBNET sg=$APP_SG profile=$PROFILE_ARN type=t2.small"

  echo "== [6] reconcile replication config for $SS and un-stall if needed =="
  # A source server registered while the account-level template still named the old staging
  # subnet inherits that subnet and stalls (FAILED_TO_CREATE_SECURITY_GROUP). Point it at the
  # current subnet and ask DRS to retry; harmless when already correct.
  SS_SUBNET=$(aws drs get-replication-configuration --region "$SECONDARY" --source-server-id "$SS" --query stagingAreaSubnetId --output text)
  if [[ "$SS_SUBNET" != "$STAGING_SUBNET" ]]; then
    aws drs update-replication-configuration --region "$SECONDARY" --source-server-id "$SS" \
      --staging-area-subnet-id "$STAGING_SUBNET" --replication-servers-security-groups-ids '[]' --associate-default-security-group >/dev/null
    echo "source server staging subnet: $SS_SUBNET -> $STAGING_SUBNET"
  fi
  ST=$(aws drs describe-source-servers --region "$SECONDARY" --filters sourceServerIDs="$SS" --query 'items[0].dataReplicationInfo.dataReplicationState' --output text)
  if [[ "$ST" == STALLED ]]; then
    aws drs retry-data-replication --region "$SECONDARY" --source-server-id "$SS" >/dev/null && echo "replication was STALLED -> retry requested"
  fi
fi
echo "=== DRS setup done. Tag the source server so the recover Lambda finds it: ==="
if [[ -n "${SS:-}" && "$SS" != "None" ]]; then
  # The tag is the contract between this script and the plan: common.tagged_source_server() fails
  # the execution unless exactly one FAILOVER server carries it. So the write must not be
  # best-effort, and the read-back proves it landed.
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  aws drs tag-resource --region "$SECONDARY" \
    --resource-arn "arn:aws:drs:${SECONDARY}:${ACCOUNT_ID}:source-server/${SS}" \
    --tags "${PROJECT}:role=app"
  TAGGED=$(aws drs describe-source-servers --region "$SECONDARY" --filters sourceServerIDs="$SS" \
    --query "items[0].tags.\"${PROJECT}:role\"" --output text)
  [[ "$TAGGED" == "app" ]] || { echo "ERROR: ${PROJECT}:role=app is not on $SS after tag-resource (read back: ${TAGGED:-none})"; exit 1; }
  echo "tagged $SS with ${PROJECT}:role=app"

  # [7] `make deploy` ends at the resting state, which requires forward replication CONTINUOUS.
  # Initial sync of the 8 GB root volume takes 15 to 25 minutes from agent registration (e2e
  # 2026-09-24: registered 18:03Z, CREATING_SNAPSHOT at 18:16Z). The rehearsal's baseline
  # invariant gives the state 5 minutes to settle, which is right after a fail-back and wrong
  # for a fresh install: run 36028055691 started `rehearse-cycle` 78 s after registration and
  # failed at "forward replication is INITIAL_SYNC" without ever executing the plan. Wait here,
  # bounded at 45 min, and fail loud on a state that will not progress on its own.
  echo "== [7] wait for forward replication CONTINUOUS on $SS =="
  for i in $(seq 1 90); do
    ST=$(aws drs describe-source-servers --region "$SECONDARY" --filters sourceServerIDs="$SS" \
      --query 'items[0].dataReplicationInfo.dataReplicationState' --output text 2>/dev/null || echo UNKNOWN)
    case "$ST" in
      CONTINUOUS) echo "replication CONTINUOUS after $((i * 30 / 60)) min"; break;;
      STALLED|DISCONNECTED|STOPPED|PAUSED)
        echo "ERROR: replication is $ST and will not progress on its own:"
        aws drs describe-source-servers --region "$SECONDARY" --filters sourceServerIDs="$SS" \
          --query 'items[0].dataReplicationInfo.[dataReplicationError,dataReplicationInitiation.steps[?status!=`SUCCEEDED`]]' --output json
        exit 1;;
      *) echo "  replication is $ST ($i/90); recheck in 30s"; sleep 30;;
    esac
    (( i == 90 )) && { echo "ERROR: replication did not reach CONTINUOUS within 45 min (last state: $ST)"; exit 1; }
  done
fi
echo "Check replication state at any time with:"
echo "  aws drs describe-source-servers --region $SECONDARY --query 'items[].dataReplicationInfo.dataReplicationState'"
