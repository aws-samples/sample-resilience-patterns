#!/usr/bin/env bash
# Open a local port to a workload region's INTERNAL operator-access ALB THROUGH the
# observer bastion (us-east-1), using Systems Manager port forwarding. No inbound ports,
# no public IP, no SSH keys: the bastion sits in a third region peered to both workload
# VPCs, so the tunnel follows the same private path an in-VPC client would. What you see
# at http://localhost:<port>/ is the Argo CD UI; /cockpit (us-west-2 only) is the cockpit.
#
# Usage: tunnel.sh <aws-profile> [local-port] [region]
#   tunnel.sh my-profile                    # http://localhost:8080 -> us-east-2 access ALB:80
#   tunnel.sh my-profile 8081 us-west-2     # pin the standby region (also serves /cockpit)
#
# Needs: aws cli + session-manager-plugin on the machine running the browser. Run this on
# the laptop (or ssh -L 8080:localhost:8080 to wherever you run it).
set -euo pipefail

PROFILE="${1:?usage: tunnel.sh <aws-profile> [local-port] [region us-east-2|us-west-2]}"
LPORT="${2:-8080}"
REGION="${3:-us-east-2}"
OBSERVER_REGION="${OBSERVER_REGION:-us-east-1}"
PROJECT="${PROJECT_NAME:-eks-multi-region}"

# The bastion lives in the observer stack (observer region). Its instance id is a stack output.
BASTION=$(aws --profile "$PROFILE" cloudformation describe-stacks \
  --region "$OBSERVER_REGION" --stack-name "${PROJECT}-observer" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
if [[ -z "$BASTION" || "$BASTION" == "None" ]]; then
  echo "observer stack ${PROJECT}-observer not found in $OBSERVER_REGION (or no BastionInstanceId output)" >&2
  exit 1
fi

# The target is the internal ALB in the chosen workload region. Its DNS name is the
# access-door stack's AlbDnsName output; the bastion resolves + reaches it over the peering.
ALB_DNS=$(aws --profile "$PROFILE" cloudformation describe-stacks \
  --region "$REGION" --stack-name "${PROJECT}-access-${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)
if [[ -z "$ALB_DNS" || "$ALB_DNS" == "None" ]]; then
  echo "access-door stack ${PROJECT}-access-${REGION} not found in $REGION (or no AlbDnsName output)" >&2
  exit 1
fi

echo "tunnel: http://localhost:${LPORT}/  ->  ${ALB_DNS}:80  (${REGION}) via ${BASTION} (${OBSERVER_REGION})."
echo "  Argo CD:  http://localhost:${LPORT}/"
if [[ "$REGION" == "us-west-2" ]]; then
  echo "  Cockpit:  http://localhost:${LPORT}/cockpit   (standby only)"
fi
echo "  Ctrl-C to close."

exec aws --profile "$PROFILE" ssm start-session --region "$OBSERVER_REGION" --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$ALB_DNS\"],\"portNumber\":[\"80\"],\"localPortNumber\":[\"$LPORT\"]}"
