#!/usr/bin/env bash
# Open a local port to app.drsdemo.internal THROUGH the observer bastion (us-east-1), using
# Systems Manager port forwarding. No inbound ports, no public IP, no SSH keys: the bastion
# resolves the private-zone name itself, so the tunnel follows the Route 53 failover record --
# what you see at http://localhost:8080 is exactly what a client in the observer VPC sees.
#
# Usage: tunnel.sh [aws-profile|-] [local-port] [host] [remote-port]   (- or empty = default credential chain)
#   tunnel.sh my-admin-profile                          # http://localhost:8080 -> app.drsdemo.internal:80
#   tunnel.sh - 8081 <primary-alb-dns>                  # default creds; pin a specific ALB instead of the record
# Needs: aws cli + session-manager-plugin on the machine that runs the browser.
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""
LPORT="${2:-8080}"; HOST="${3:-app.drsdemo.internal}"; RPORT="${4:-80}"
REGION="${OBSERVER_REGION:-us-east-1}"; PROJECT=drsdemo
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }

BASTION=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "${PROJECT}-observer" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
[[ -z "$BASTION" || "$BASTION" == None ]] && { echo "observer stack not found in $REGION"; exit 1; }

echo "tunnel: http://localhost:${LPORT}  ->  ${HOST}:${RPORT}  via ${BASTION} (${REGION}).  Ctrl-C to close."
SSM_DOC=AWS-StartPortForwardingSessionToRemoteHost
exec command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} ssm start-session --region "$REGION" --target "$BASTION" \
  --document-name "$SSM_DOC" \
  --parameters "{\"host\":[\"$HOST\"],\"portNumber\":[\"$RPORT\"],\"localPortNumber\":[\"$LPORT\"]}"
