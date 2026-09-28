#!/usr/bin/env bash
# Upload app/app.py + app/ui.html to the app-code bucket and, if the primary EC2 exists and is
# SSM-online, refresh it in place (re-fetch + restart drsapp). Uploading new code does NOT change
# the stack, and replacing the instance would cost a full DRS re-protect (~12 min) and, in
# stateful mode, the launch-into target identity -- so we never replace, we refresh.
#
# Usage: app-code.sh [aws-profile|-] <bucket>
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""
BUCKET="${2:?usage: app-code.sh [aws-profile|-] <bucket>}"
PRIMARY="${PRIMARY_REGION:-us-east-2}"; PROJECT="${PROJECT:-drsdemo}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }

if ! aws s3api head-bucket --bucket "$BUCKET" --region "$PRIMARY" >/dev/null 2>&1; then
  if [[ "$PRIMARY" == "us-east-1" ]]; then aws s3api create-bucket --bucket "$BUCKET" --region "$PRIMARY" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --region "$PRIMARY" --create-bucket-configuration LocationConstraint="$PRIMARY" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$BUCKET" --region "$PRIMARY" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "created s3://$BUCKET"
fi
aws s3 cp "$ROOT/app/app.py"  "s3://$BUCKET/app/app.py"  --region "$PRIMARY" --only-show-errors
aws s3 cp "$ROOT/app/ui.html" "s3://$BUCKET/app/ui.html" --region "$PRIMARY" --only-show-errors
echo "uploaded app code -> s3://$BUCKET/app/"

IID=$(aws cloudformation describe-stacks --region "$PRIMARY" --stack-name "${PROJECT}-app-primary" \
  --query "Stacks[0].Outputs[?OutputKey=='AppInstanceId'].OutputValue" --output text 2>/dev/null || true)
[[ -z "$IID" || "$IID" == None ]] && exit 0
PING=$(aws ssm describe-instance-information --region "$PRIMARY" --filters "Key=InstanceIds,Values=$IID" \
  --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo None)
[[ "$PING" != Online ]] && { echo "app EC2 $IID not SSM Online ($PING); it will fetch the code at next boot"; exit 0; }

echo "== refreshing app code on $IID via SSM =="
CID=$(aws ssm send-command --region "$PRIMARY" --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters "commands=[\"aws s3 cp s3://$BUCKET/app/app.py /opt/app/app.py --region $PRIMARY\",\"aws s3 cp s3://$BUCKET/app/ui.html /opt/app/ui.html --region $PRIMARY\",\"systemctl restart drsapp\",\"sleep 2; systemctl is-active drsapp\"]" \
  --query Command.CommandId --output text)
for _ in $(seq 1 20); do
  ST=$(aws ssm get-command-invocation --region "$PRIMARY" --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in
    Success) echo "   app restarted: $(aws ssm get-command-invocation --region "$PRIMARY" --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text | tail -1)"; exit 0;;
    Failed|Cancelled|TimedOut) echo "   WARNING: refresh $ST"; aws ssm get-command-invocation --region "$PRIMARY" --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text | tail -3; exit 0;;
  esac
  sleep 3
done
echo "   WARNING: app code refresh did not finish in 60s"
