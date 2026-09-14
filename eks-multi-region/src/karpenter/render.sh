#!/usr/bin/env bash
#
# Regenerate src/karpenter/karpenter.yaml from the upstream Helm chart.
#
# WHY THE OUTPUT IS COMMITTED RATHER THAN RENDERED AT BUILD TIME.
# Rendering during `npx projen build` would make the gate require internet egress and a
# helm binary, so a builder on a restricted network could no longer run it. The gate has to
# stay hermetic. So this script is an occasional MAINTENANCE task -- run it when a version
# moves -- and its output is reviewed like any other source. A test asserts the committed
# manifest still agrees with the pinned versions, which is what catches a version bump that
# forgot to re-render.
#
# WHY HELM AT ALL, RATHER THAN VENDORING THE CHART AND TEMPLATING IT OURSELVES.
# The chart composes its image reference through a helper that switches on whether a digest
# is set, and its default affinity already carries the rule that keeps Karpenter off the
# nodes it manages. Re-implementing that by hand is how a subtle difference from upstream
# gets introduced and then debugged on a cluster.
#
# WHY IN-CLUSTER OBJECTS ARE NOT HELM-INSTALLED AT DEPLOY TIME.
# The installer runs CodeBuild inside isolated subnets with no egress. It cannot reach an
# OCI registry to pull a chart, and giving it one would mean either a NAT gateway (an
# explicit earlier decision against) or ECR-as-OCI (rejected in step 10 over its 12-hour
# token expiry). Rendering here and applying plain YAML there needs neither.
#
# Usage:  bash src/karpenter/render.sh
#
# Requires network egress. Downloads a pinned helm into temporary/ if absent, the same
# shape as the CI job's crane download.

set -euo pipefail

# Pinned. An unpinned `helm` would let the rendered output change because the RENDERER
# moved, which is indistinguishable in the diff from the chart moving.
HELM_VERSION="${HELM_VERSION:-v4.2.4}"

# These two are the contract with src/mirror/images.json. The test asserts they agree, so
# bumping the mirror without re-rendering fails the build rather than shipping a manifest
# that points at an image tag the mirror never pushed.
CHART_VERSION="${CHART_VERSION:-1.14.1}"
IMAGE_TAG="${IMAGE_TAG:-1.14.1}"

# The ARM64 CHILD digest, not the index digest.
#
# This is the trap. The chart's own default is the multi-platform INDEX digest
# (sha256:445bae...), and build/mirror-images.sh copies only linux/arm64 by default, so the
# index digest DOES NOT EXIST in our ECR mirror. Left at the chart default, every pod fails
# to pull with "manifest unknown" -- which reads as a mirror that did not run rather than a
# digest that does not match. Must equal arm64Digest for karpenter-controller in
# src/mirror/images.json.
IMAGE_DIGEST="${IMAGE_DIGEST:-sha256:bb2b42014fef4b89eaff7b16289652e9fa8073cbd05819d9922795748e937726}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$REPO_ROOT/temporary/helm"
OUT="$REPO_ROOT/src/karpenter/karpenter.yaml"

mkdir -p "$WORK"

# ---- helm ------------------------------------------------------------------

HELM="$WORK/helm"
if [ ! -x "$HELM" ]; then
  arch="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
  echo "Downloading helm $HELM_VERSION ($arch)..."
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" \
    | tar -xz -C "$WORK" --strip-components=1 "linux-${arch}/helm"
fi
"$HELM" version --short

# ---- chart -----------------------------------------------------------------

rm -rf "$WORK/karpenter"
echo "Pulling karpenter chart $CHART_VERSION..."
# Unauthenticated pull against ECR Public. No `helm registry login` is performed on
# purpose: a stale credential in the helm config would turn an anonymous-capable pull into
# an auth failure.
"$HELM" pull "oci://public.ecr.aws/karpenter/karpenter" \
  --version "$CHART_VERSION" --untar --untardir "$WORK"

# ---- render ----------------------------------------------------------------
#
# Deploy-time values are left as ${UPPER_SNAKE} placeholders for
# build/render-manifest.py, which FAILS on any placeholder the environment does not supply.
# They cannot be baked in: the cluster name, the ECR registry host and the controller role
# ARN all differ per region and per account.
#
# --include-crds is required. `helm template` omits crds/ by default because `helm install`
# handles them separately; we apply plain YAML with kubectl, so leaving it off produces a
# manifest that applies cleanly and then fails on the first EC2NodeClass with "no matches
# for kind" -- and nothing in the apply reports a problem.
echo "Rendering..."
"$HELM" template karpenter "$WORK/karpenter" \
  --namespace kube-system \
  --include-crds \
  --set "settings.clusterName=\${KARPENTER_CLUSTER_NAME}" \
  --set "settings.interruptionQueue=" \
  --set "controller.image.repository=\${KARPENTER_IMAGE_REPO}" \
  --set "controller.image.tag=${IMAGE_TAG}" \
  --set "controller.image.digest=${IMAGE_DIGEST}" \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=\${KARPENTER_CONTROLLER_ROLE_ARN}" \
  > "$OUT.tmp"

{
  echo "# GENERATED by src/karpenter/render.sh -- DO NOT EDIT BY HAND."
  echo "#"
  echo "#   chart:  oci://public.ecr.aws/karpenter/karpenter  $CHART_VERSION"
  echo "#   image:  \${KARPENTER_IMAGE_REPO}:$IMAGE_TAG@$IMAGE_DIGEST"
  echo "#   helm:   $HELM_VERSION"
  echo "#"
  echo "# The image digest is the ARM64 CHILD digest, not the chart's default index digest:"
  echo "# build/mirror-images.sh copies only linux/arm64, so the index digest is absent from"
  echo "# our ECR mirror and pods would fail to pull with 'manifest unknown'."
  echo "#"
  echo "# Placeholders are substituted by build/render-manifest.py, which fails loudly on any"
  echo "# it cannot resolve:"
  echo "#   KARPENTER_CLUSTER_NAME  KARPENTER_IMAGE_REPO  KARPENTER_CONTROLLER_ROLE_ARN"
  echo "#"
  echo "# Regenerate:  bash src/karpenter/render.sh"
  cat "$OUT.tmp"
} > "$OUT"
rm -f "$OUT.tmp"

echo
echo "Wrote $OUT ($(wc -l < "$OUT") lines, $(wc -c < "$OUT") bytes)"
grep -c "^kind:" "$OUT" | xargs echo "  top-level kinds:"
