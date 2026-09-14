#!/usr/bin/env bash
#
# Restore steady state after a failover round trip — the operator-run cleanup.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
#
# A failover deliberately leaves two things behind and NOTHING reverts them on its own:
#
#   1. ARC patches the HPA with {"spec":{"behavior":{"scaleDown":{"selectPolicy":
#      "Disabled"}}}} and the developer guide is explicit that this persists "during or
#      after the execution". ARC's EKS block only ever scales UP, so scale-down stays off.
#   2. The scaled-up replica count therefore never comes back down, and the 24-hour
#      replica sample ratchets with every failover (live 2026-08-27: 10 pods after two
#      round trips).
#
# The cleanup is two kubectl verbs per region:
#
#   * patch the HPA back to selectPolicy: Min — the EXACT reverse of ARC's patch (NOT
#     minReplicas, which ARC never touched). The re-enabled HPA then rightsizes each
#     region on its own: the idle region drifts to its minReplicas floor, the active
#     region sizes to real load. No explicit `kubectl scale` — cleanup by convergence.
#   * rolling restart — fresh pods, fresh DB connection pools. After a writer move this
#     is standard hygiene, and in this demo it is PRECISELY the remediation for the
#     planted write defect. Run this only when the parked-at-75% diagnosis story is over.
#
# ── WHY A SCRIPT AND NOT AN ARC postRecovery WORKFLOW ───────────────────────────────────
#
# An ARC-native version was built, deployed and executed live (2026-08-27, plan v4) and
# then deliberately REMOVED. It worked, but the operator judgment went the other way:
# cleanup should not be coupled to ARC's execution model (its region-role semantics, its
# both-regions-healthy posture, its retry cadence) when the action itself is two kubectl
# verbs. What the ARC version validated survives here: the buildspec, the per-run
# KUBECTL_S3_URI override, and the selectPolicy-not-minReplicas contract.
#
# ── HOW IT REACHES THE CLUSTERS ─────────────────────────────────────────────────────────
#
# The cluster API endpoints are private. Each region's in-VPC installer CodeBuild project
# is the proven path in, so this script starts one build per region with a cleanup
# buildspec override. The installer bakes in only CLUSTER_NAME + the namespace vars;
# KUBECTL_S3_URI is a per-run override every out-of-pipeline StartBuild must supply, so
# the script discovers the newest staged kubectl in the region's assets bucket first.
#
# Regions run SERIALLY and the script fails loudly on the first failure — a cleanup that
# half-ran and said so beats one that parallelized into ambiguity.
#
# ── Usage ───────────────────────────────────────────────────────────────────────────────
#
#   bash build/restore-steady-state.sh [--execute [--no-wait]]
#
# Prints the derived per-region calls and EXITS WITHOUT RUNNING unless --execute is
# passed — same contract as arc-switch.sh. Requires credentials that can
# codebuild:StartBuild / BatchGetBuilds and s3:ListBucket in both regions.
#
# --no-wait starts BOTH regions' builds and exits without polling, printing the build
# ids and the exact batch-get-builds commands to check them. Added 2026-09-08 for
# agent/automation callers: the default serial poll-until-terminal loop runs ~5-10 min
# per region, which chat-tool watchdogs kill mid-poll — the first casualty had already
# started the east build, so the kill orphaned a RUNNING build the caller then had to
# rediscover by listing the project's builds. Without --no-wait the contract is
# unchanged: serial, fail-loud, poll until terminal.
#
# Optional env:
#   RSS_REGIONS         CSV of regions to clean. Default: the demo pair.
#   RSS_PROJECT_NAME    Stack/bucket name prefix. Default: eks-mr-demo.
#   RSS_APP_NAMESPACE   Kubernetes namespace.      Default: demo        (k8s.ts)
#   RSS_DEPLOYMENT      Deployment to restart.     Default: orders-api  (k8s.ts)
#   RSS_HPA             HPA to un-patch.           Default: orders-api  (k8s.ts)

set -euo pipefail

RSS_REGIONS="${RSS_REGIONS:-us-east-2,us-west-2}"
RSS_PROJECT_NAME="${RSS_PROJECT_NAME:-eks-mr-demo}"
# Defaults mirror src/cdk/k8s.ts (APP_NAMESPACE / APP_DEPLOYMENT_NAME / APP_HPA_NAME);
# a test pins the agreement so the script cannot drift from the manifests.
RSS_APP_NAMESPACE="${RSS_APP_NAMESPACE:-demo}"
RSS_DEPLOYMENT="${RSS_DEPLOYMENT:-orders-api}"
RSS_HPA="${RSS_HPA:-orders-api}"

EXECUTE="${1:-}"
NO_WAIT="${2:-}"

# The buildspec, as JSON (valid buildspec YAML, and JSON sidesteps the quoting hazards
# around the embedded patch). The patch is the EXACT reverse of ARC's documented one.
buildspec() {
  cat <<EOF
{
  "version": "0.2",
  "phases": {
    "install": {
      "commands": [
        "aws s3 cp \"\$KUBECTL_S3_URI\" /usr/local/bin/kubectl",
        "chmod +x /usr/local/bin/kubectl"
      ]
    },
    "build": {
      "commands": [
        "aws eks update-kubeconfig --name \"\$CLUSTER_NAME\" --region \"\$AWS_REGION\"",
        "kubectl -n ${RSS_APP_NAMESPACE} patch hpa ${RSS_HPA} --type merge -p '{\"spec\":{\"behavior\":{\"scaleDown\":{\"selectPolicy\":\"Min\"}}}}'",
        "kubectl -n ${RSS_APP_NAMESPACE} rollout restart deployment ${RSS_DEPLOYMENT}",
        "kubectl -n ${RSS_APP_NAMESPACE} rollout status deployment ${RSS_DEPLOYMENT} --timeout=600s"
      ]
    }
  }
}
EOF
}

latest_kubectl_uri() {
  local bucket="$1"
  # Newest */k8s/kubectl object — each pipeline run stages one under a fresh prefix.
  #
  # PAGINATION TRAP, hit live 2026-09-08: the CLI applies --query PER PAGE, so once the
  # bucket exceeds 1,000 objects `sort_by(...)[-1]` returns one key per page and the
  # concatenated output is a malformed multi-line "URI" — the cleanup build then fails
  # at INSTALL on `aws s3 cp`. Emit [LastModified, Key] per page and pick the global
  # newest client-side (ISO-8601 sorts lexicographically).
  local key
  key=$(aws s3api list-objects-v2 --bucket "$bucket" \
    --query "sort_by(Contents[?ends_with(Key, 'k8s/kubectl')], &LastModified)[-1].[LastModified,Key]" \
    --output text | sort | tail -n 1 | cut -f2)
  if [ -z "$key" ] || [ "$key" = "None" ]; then
    echo "ERROR: no staged kubectl under s3://$bucket — has the pipeline ever deployed?" >&2
    exit 1
  fi
  echo "s3://$bucket/$key"
}

IFS=',' read -ra REGION_LIST <<< "$RSS_REGIONS"

echo "restore-steady-state: HPA selectPolicy Disabled->Min + rollout restart of" \
     "${RSS_APP_NAMESPACE}/${RSS_DEPLOYMENT}, in: ${RSS_REGIONS}"
echo

if [ "$EXECUTE" != "--execute" ]; then
  for region in "${REGION_LIST[@]}"; do
    echo "WOULD run in $region: start-build on ${RSS_PROJECT_NAME}-${region}-installer" \
         "(buildspec override: patch hpa ${RSS_HPA} selectPolicy=Min; rollout restart" \
         "${RSS_DEPLOYMENT}; rollout status --timeout=600s)"
  done
  echo
  echo "DRY RUN. Re-run with --execute to start the cleanup builds."
  exit 0
fi

for region in "${REGION_LIST[@]}"; do
  project="${RSS_PROJECT_NAME}-${region}-installer"
  bucket="${RSS_PROJECT_NAME}-${region}"
  echo "== $region: discovering staged kubectl in s3://$bucket"
  kubectl_uri=$(latest_kubectl_uri "$bucket")
  echo "== $region: starting cleanup build on $project (kubectl: $kubectl_uri)"
  build_id=$(aws codebuild start-build \
    --project-name "$project" \
    --region "$region" \
    --buildspec-override "$(buildspec)" \
    --environment-variables-override "name=KUBECTL_S3_URI,value=${kubectl_uri},type=PLAINTEXT" \
    --query 'build.id' --output text)
  if [ "$NO_WAIT" = "--no-wait" ]; then
    # Fire-and-report: hand the poll to the caller. The build itself is unchanged —
    # its own `rollout status --timeout=600s` still gates success inside CodeBuild.
    echo "== $region: build $build_id STARTED (not polling — --no-wait)"
    echo "   check: aws codebuild batch-get-builds --ids \"$build_id\" --region $region --query 'builds[0].buildStatus' --output text"
    echo
    continue
  fi
  echo "== $region: build $build_id running; polling until terminal"
  while :; do
    sleep 15
    status=$(aws codebuild batch-get-builds --ids "$build_id" --region "$region" \
      --query 'builds[0].buildStatus' --output text)
    [ "$status" = "IN_PROGRESS" ] && continue
    break
  done
  if [ "$status" != "SUCCEEDED" ]; then
    echo "ERROR: cleanup build $build_id in $region ended $status — stopping (regions are serial, fail-loud)" >&2
    exit 1
  fi
  echo "== $region: SUCCEEDED — HPA un-patched, fresh pods rolling; the HPA rightsizes from here"
  echo
done

if [ "$NO_WAIT" = "--no-wait" ]; then
  echo "Builds started in: ${RSS_REGIONS}. NOT verified — poll the ids above; a build can" \
       "still fail (e.g. rollout status timeout). The 24-hour replica sample ages out on its own."
  exit 0
fi

echo "Steady state restored in: ${RSS_REGIONS}. The 24-hour replica sample ages out on its own."
