#!/usr/bin/env bash
# Restore = inject 0. Param name is parameterized (read it from the
# FailureInjectionParameter `ErrorRateParamName` CfnOutput).
# Generalized from the predecessor project scripts/restore.sh:12-17.
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "Usage: $0 <region> <param-name>"
  echo "  region:     AWS region (e.g., us-east-1)"
  echo "  param-name: SSM param (from the ErrorRateParamName CfnOutput)"
  exit 1
fi
REGION="$1"; PARAM="$2"
aws ssm put-parameter --name "$PARAM" --value "0" \
  --type String --overwrite --region "$REGION"
echo "Restored ${PARAM} to 0% in ${REGION}"
