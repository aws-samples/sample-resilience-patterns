#!/usr/bin/env bash
#
# Regenerate src/lbc/lbc.yaml from the upstream AWS Load Balancer Controller Helm chart.
#
# WHY THE CONTROLLER EXISTS AT ALL. The in-tree Kubernetes service controller creates an NLB
# with `instance` targets and cannot enable cross-zone load balancing or ARC zonal shift on
# it. A zonal shift against that NLB reports ACTIVE and moves nothing measurable, which is
# the worst possible outcome for a demo whose whole claim is that the shift recovered the AZ.
# The LBC creates an NLB with `ip` targets -- pods as targets -- which is what makes a
# per-AZ drain observable.
#
# WHY THE OUTPUT IS COMMITTED RATHER THAN RENDERED AT BUILD TIME.
# Same reasoning as src/argo/render.sh and src/karpenter/render.sh: rendering during
# `npx projen build` would make the gate require internet egress and a helm binary, so a
# builder on a restricted network could no longer run it. The gate stays hermetic. This is an
# occasional MAINTENANCE task -- run it when a version moves -- and its output is reviewed
# like any other source. A test asserts the committed manifest still agrees with the pinned
# versions, which is what catches a bump that forgot to re-render.
#
# WHY THE WEBHOOK CERT IS SELF-SIGNED AT RENDER TIME AND NOT cert-manager.
# The chart generates its own CA and serving cert via Sprig `genSelfSignedCert` when
# `enableCertManager=false` (the default), with a long validity. cert-manager would mean a
# SECOND controller, with its own CRDs and its own mutating webhook, installed into an
# airgapped cluster to solve a problem the chart already solves offline -- and its images
# would need mirroring too. The cert is baked into the committed manifest.
#
# WHY IN-CLUSTER OBJECTS ARE NOT HELM-INSTALLED AT DEPLOY TIME.
# The installer runs CodeBuild inside isolated subnets with no egress. It cannot reach a
# chart repository, and giving it one would mean a NAT gateway (an explicit earlier decision
# against). Rendering here and applying plain YAML there needs neither.
#
# Usage:  bash src/lbc/render.sh
#
# Requires network egress. Downloads a pinned helm into temporary/ if absent, the same shape
# as the karpenter and argo render scripts.

set -euo pipefail

# Pinned. An unpinned `helm` would let the rendered output change because the RENDERER moved,
# which is indistinguishable in the diff from the chart moving.
HELM_VERSION="${HELM_VERSION:-v4.2.4}"

# The contract with src/mirror/images.json. A test asserts they agree, so bumping the mirror
# without re-rendering fails the build rather than shipping a manifest that points at an
# image tag the mirror never pushed.
CHART_VERSION="${CHART_VERSION:-3.5.0}"
IMAGE_TAG="${IMAGE_TAG:-v3.5.0}"

# The ARM64 CHILD digest, NOT the index digest.
#
# The same trap as karpenter (docs/lessons.md #10): build/mirror-images.sh copies only
# linux/arm64 by default, so the multi-platform INDEX digest does not exist in our ECR
# mirror. Point at the index and every controller pod fails to pull with "manifest unknown",
# which reads as a mirror that never ran rather than a digest that cannot resolve.
# Must equal arm64Digest for aws-load-balancer-controller in src/mirror/images.json.
# Resolved from the live registry on 2026-09-01; index digest was
# sha256:298acdff5a571731276aaea3d5cc450a264e4ad710a5bddf3e518f68a3f9f6cb and the image
# publishes only linux/amd64 and linux/arm64.
IMAGE_DIGEST="${IMAGE_DIGEST:-sha256:1ee3cc54fb62248bd56f2157f7be79baba2be8f0bbf2d926e2650d7ba710ee5f}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$REPO_ROOT/temporary/helm-lbc"
OUT="$REPO_ROOT/src/lbc/lbc.yaml"

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

rm -rf "$WORK/aws-load-balancer-controller"
echo "Pulling aws-load-balancer-controller chart $CHART_VERSION..."
# Classic chart repo (https), not OCI -- unlike karpenter. `helm pull` against a repo URL
# needs no `helm repo add`, so no repo state is left behind to go stale.
"$HELM" pull aws-load-balancer-controller \
  --repo https://aws.github.io/eks-charts \
  --version "$CHART_VERSION" --untar --untardir "$WORK"

# ---- render ----------------------------------------------------------------
#
# Deploy-time values are left as ${UPPER_SNAKE} placeholders for build/render-manifest.py,
# which FAILS on any placeholder the environment does not supply. They cannot be baked in:
# the cluster name, VPC id, region, ECR registry host and controller role ARN all differ per
# region and per account -- and this manifest is applied to BOTH clusters.
#
# clusterName / vpcId / region are all REQUIRED by the controller in a private cluster: with
# no IMDS-based discovery reachable it cannot infer them, and it exits at startup with a
# message about the missing flag -- which reads as a bad image rather than missing config.
# createIngressClassResource=false: this demo exposes the app with a Service of type
# LoadBalancer (an NLB), never an Ingress, so the IngressClass and IngressClassParams the
# chart creates by default are objects nothing uses. They also arrive wrapped in a
# `kind: List`, which the every-namespaced-doc-names-its-namespace test would then have to
# special-case. Shipping fewer unused objects into an airgapped cluster is the cheaper answer.
#
# NOTE ON STYLE: no comment lines inside the backslash-continued helm invocation below. A
# comment between continuations is the kind of shell subtlety that parses today and breaks on
# a later edit -- this repo has already lost a deploy to a generated-shell quoting bug.
echo "Rendering..."
"$HELM" template aws-load-balancer-controller "$WORK/aws-load-balancer-controller" \
  --namespace kube-system \
  --include-crds \
  --set "clusterName=\${LBC_CLUSTER_NAME}" \
  --set "region=\${LBC_REGION}" \
  --set "vpcId=\${LBC_VPC_ID}" \
  --set "image.repository=\${LBC_IMAGE_REPO}" \
  --set "image.tag=${IMAGE_TAG}" \
  --set "image.digest=${IMAGE_DIGEST}" \
  --set "serviceAccount.create=true" \
  --set "serviceAccount.name=aws-load-balancer-controller" \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=\${LBC_CONTROLLER_ROLE_ARN}" \
  --set "enableCertManager=false" \
  --set "enableServiceMutatorWebhook=true" \
  --set "createIngressClassResource=false" \
  > "$OUT.tmp"

# ---- STRIP THE WEBHOOK KEY MATERIAL ----------------------------------------
#
# The chart's `genSelfSignedCert` bakes a REAL private key into an
# `aws-load-balancer-tls` Secret and the matching CA into every webhook `caBundle`. Committing
# that would put a live TLS private key into git history -- a one-way door in a shared repo.
#
# The rule is explicit: no secrets in version control -- "Storing certificates and private keys in
# version control systems" as its FIRST common pitfall, and secrets-management guidance requires secrets
# live in Secrets Manager or KMS and "never hardcode in source code". The other vendored
# manifests in this repo commit only EMPTY Secret shells (argocd-secret, tls.key = 0 bytes) --
# an earlier draft of this script claimed it was "committed like every other vendored
# manifest", and that premise was simply false.
#
# So the Secret is removed and every caBundle blanked. The installer generates the CA and
# serving cert in-cluster, creates the Secret, and injects the caBundle.
#
# THE WEBHOOK IS failurePolicy: Fail. A registered webhook with a blank caBundle makes EVERY
# Service create in the cluster fail -- including the app's own. So lbc.yaml MUST be applied in
# its OWN pass, with the cert created and the caBundle injected, BEFORE the manifest that
# carries the app Service. It must NOT be concatenated with it.
echo "Stripping webhook key material..."
python3 - "$OUT.tmp" <<'STRIP'
import sys, re
p = sys.argv[1]
docs = open(p).read().split("\n---\n")
kept = []
for d in docs:
    if "kind: Secret" in d and "aws-load-balancer-tls" in d:
        continue  # dropped entirely -- the installer creates it
    # Blank any caBundle so no CA material is committed and nothing stale can be trusted.
    d = re.sub(r"(caBundle:)[ \t]*\S+", lambda m: m.group(1) + ' ""', d)
    kept.append(d)
out = "\n---\n".join(kept)
assert "aws-load-balancer-tls" not in out or "kind: Secret" not in out
open(p, "w").write(out)
print(f"  dropped {len(docs) - len(kept)} Secret doc(s); blanked caBundle fields")
STRIP

{
  echo "# GENERATED by src/lbc/render.sh -- DO NOT EDIT BY HAND."
  echo "#"
  echo "#   chart:  https://aws.github.io/eks-charts  aws-load-balancer-controller  $CHART_VERSION"
  echo "#   image:  \${LBC_IMAGE_REPO}:$IMAGE_TAG@$IMAGE_DIGEST"
  echo "#   helm:   $HELM_VERSION"
  echo "#"
  echo "# The image digest is the ARM64 CHILD digest, not the chart's default index digest:"
  echo "# build/mirror-images.sh copies only linux/arm64, so the index digest is absent from"
  echo "# our ECR mirror and pods would fail to pull with 'manifest unknown'."
  echo "#"
  echo "# enableServiceMutatorWebhook=true is REQUIRED, not cosmetic. That webhook is what"
  echo "# injects spec.loadBalancerClass on Service CREATE, and loadBalancerClass is IMMUTABLE"
  echo "# afterwards -- which is why the app Service must be deleted and recreated rather than"
  echo "# updated in place. With the webhook off, the recreated Service is silently claimed by"
  echo "# the in-tree controller again and the old instance-target NLB comes back."
  echo "#"
  echo "# The webhook serving cert is self-signed by the chart at RENDER time"
  echo "# (enableCertManager=false), so no cert-manager is installed into an airgapped"
  echo "# cluster. Re-running this script issues a NEW cert -- expected, and harmless."
  echo "#"
  echo "# Placeholders are substituted by build/render-manifest.py, which fails loudly on any"
  echo "# it cannot resolve:"
  echo "#   LBC_CLUSTER_NAME  LBC_REGION  LBC_VPC_ID  LBC_IMAGE_REPO  LBC_CONTROLLER_ROLE_ARN"
  echo "#"
  echo "# NO KEY MATERIAL IS COMMITTED. The chart's self-signed Secret was STRIPPED and every"
  echo "# caBundle blanked (the no-secrets-in-version-control rule: private keys must not live in version"
  echo "# control; secrets-management guidance: secrets belong in Secrets Manager/KMS). The installer"
  echo "# generates the CA + serving cert in-cluster, creates the aws-load-balancer-tls Secret"
  echo "# and injects the caBundle."
  echo "#"
  echo "# THE SERVICE WEBHOOK IS failurePolicy: Fail. Applied with a blank caBundle, it makes"
  echo "# EVERY Service create in the cluster fail -- including the app's own. This manifest"
  echo "# MUST therefore be applied in its OWN pass, cert first, BEFORE the manifest carrying"
  echo "# the app Service. Do NOT concatenate the two."
  echo "#"
  echo "# Regenerate:  bash src/lbc/render.sh"
  cat "$OUT.tmp"
} > "$OUT"
rm -f "$OUT.tmp"

echo
echo "Wrote $OUT ($(wc -l < "$OUT") lines, $(wc -c < "$OUT") bytes)"
grep -c "^kind:" "$OUT" | xargs echo "  top-level kinds:"
