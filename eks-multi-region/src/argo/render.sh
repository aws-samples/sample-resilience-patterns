#!/usr/bin/env bash
#
# Regenerate the vendored Argo CD and metrics-server install manifests (step 10b).
#
# Same shape and same reasoning as src/karpenter/render.sh: the in-VPC installer runs in
# isolated subnets with no egress, so it cannot fetch upstream manifests. Rendering here and
# applying committed YAML there needs neither egress nor helm in the cluster.
#
# WHY THE OUTPUT IS COMMITTED. Doing this during `npx projen build` would make the gate need
# internet access, so a builder on a restricted network could no longer run it. The vendored
# files are reviewed like source and a test asserts they still agree with the versions and
# digests pinned in src/mirror/images.json.
#
# IMAGE DIGESTS ARE READ FROM src/mirror/images.json, not typed here. That file is the single
# source of truth for what the mirror actually pushed, and it is the ARM64 CHILD digest that
# matters: build/mirror-images.sh copies only linux/arm64, so an index digest is absent from
# our ECR and a pod pinned to one fails with "manifest unknown" -- which reads as a mirror
# that never ran. That trap is why the digests are derived rather than transcribed.
#
# Usage:  bash src/argo/render.sh
#
# Requires network egress.

set -euo pipefail

ARGOCD_VERSION="${ARGOCD_VERSION:-v3.4.7}"
METRICS_SERVER_VERSION="${METRICS_SERVER_VERSION:-v0.9.0}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/src/argo"
WORK="$REPO_ROOT/temporary/argo"
mkdir -p "$OUT_DIR" "$WORK"

# ---- pinned digests, straight from the mirror lockfile ---------------------

read -r ARGOCD_DIGEST REDIS_TAG REDIS_DIGEST DEX_TAG DEX_DIGEST MS_DIGEST <<EOF
$(python3 - "$REPO_ROOT/src/mirror/images.json" <<'PY'
import json, sys
imgs = {i["name"]: i for i in json.load(open(sys.argv[1]))["images"]}
need = ["argocd", "redis", "dex", "metrics-server"]
missing = [n for n in need if n not in imgs]
if missing:
    sys.exit(f"ERROR: images.json is missing {missing}")
print(imgs["argocd"]["arm64Digest"],
      imgs["redis"]["tag"], imgs["redis"]["arm64Digest"],
      imgs["dex"]["tag"], imgs["dex"]["arm64Digest"],
      imgs["metrics-server"]["arm64Digest"])
PY
)
EOF

echo "Digests from src/mirror/images.json:"
echo "  argocd         $ARGOCD_VERSION @ $ARGOCD_DIGEST"
echo "  redis          $REDIS_TAG @ $REDIS_DIGEST"
echo "  dex            $DEX_TAG @ $DEX_DIGEST"
echo "  metrics-server $METRICS_SERVER_VERSION @ $MS_DIGEST"

# ---- fetch -----------------------------------------------------------------

echo "Fetching upstream manifests..."
curl -fsSL \
  "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" \
  -o "$WORK/argocd-install.yaml"
curl -fsSL \
  "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml" \
  -o "$WORK/metrics-server.yaml"

# ---- rewrite ---------------------------------------------------------------
#
# Every image reference is repointed at the private ECR mirror. ${MIRROR_REGISTRY} is
# substituted at deploy time by build/render-manifest.py, which fails loudly on any
# placeholder it cannot resolve -- so a missing value stops the deploy rather than producing
# a manifest whose pods reference an image nobody pushed.
#
# The rewrite ASSERTS its own count. A silent zero-match rewrite is the dangerous outcome:
# the manifest applies cleanly, every pod tries to pull from the internet, and the symptom is
# an image-pull timeout inside an isolated subnet that reads as a network fault.
# The heredoc is QUOTED so the shell performs no expansion — an unquoted one tries to expand
# the Python f-strings and `${{...}}` and dies with "bad substitution". Values arrive through
# the environment instead.
ARGOCD_VERSION="$ARGOCD_VERSION" \
METRICS_SERVER_VERSION="$METRICS_SERVER_VERSION" \
ARGOCD_DIGEST="$ARGOCD_DIGEST" \
REDIS_TAG="$REDIS_TAG" REDIS_DIGEST="$REDIS_DIGEST" \
DEX_TAG="$DEX_TAG" DEX_DIGEST="$DEX_DIGEST" \
MS_DIGEST="$MS_DIGEST" \
WORK_DIR="$WORK" OUT_DIR="$OUT_DIR" \
python3 - <<'PY'
import os, pathlib, sys

work = pathlib.Path(os.environ["WORK_DIR"])
out = pathlib.Path(os.environ["OUT_DIR"])
E = os.environ
M = "${MIRROR_REGISTRY}"

REWRITES = {
    "argocd-install.yaml": [
        (f"quay.io/argoproj/argocd:{E['ARGOCD_VERSION']}",
         f"{M}/argocd:{E['ARGOCD_VERSION']}@{E['ARGOCD_DIGEST']}"),
        (f"public.ecr.aws/docker/library/redis:{E['REDIS_TAG']}",
         f"{M}/redis:{E['REDIS_TAG']}@{E['REDIS_DIGEST']}"),
        (f"ghcr.io/dexidp/dex:{E['DEX_TAG']}",
         f"{M}/dex:{E['DEX_TAG']}@{E['DEX_DIGEST']}"),
    ],
    "metrics-server.yaml": [
        (f"registry.k8s.io/metrics-server/metrics-server:{E['METRICS_SERVER_VERSION']}",
         f"{M}/metrics-server:{E['METRICS_SERVER_VERSION']}@{E['MS_DIGEST']}"),
    ],
}

HEADERS = {
    "argocd-install.yaml":
        f"Argo CD {E['ARGOCD_VERSION']}, vendored from argoproj/argo-cd manifests/install.yaml",
    "metrics-server.yaml":
        f"metrics-server {E['METRICS_SERVER_VERSION']}, vendored from "
        f"kubernetes-sigs/metrics-server components.yaml",
}

for name, pairs in REWRITES.items():
    text = (work / name).read_text()
    total = 0
    for old, new in pairs:
        n = text.count(old)
        if n == 0:
            sys.exit(
                f"ERROR: {name} contains no reference to {old!r}. The upstream manifest "
                f"changed its image reference, and rewriting nothing would leave pods "
                f"pulling from the internet inside an isolated subnet."
            )
        text = text.replace(old, new)
        total += n
    # Nothing may still point at a public registry.
    for host in ("quay.io/", "ghcr.io/", "registry.k8s.io/", "public.ecr.aws/"):
        if f"image: {host}" in text:
            sys.exit(f"ERROR: {name} still references {host}")
    header = "\n".join([
        "# GENERATED by src/argo/render.sh -- DO NOT EDIT BY HAND.",
        "#",
        f"#   {HEADERS[name]}",
        f"#   {total} image reference(s) repointed at the private ECR mirror.",
        "#",
        "# Digests are the ARM64 CHILD digests from src/mirror/images.json, NOT index",
        "# digests: the mirror copies only linux/arm64, so an index digest is absent from",
        "# our ECR and the pod would fail to pull with 'manifest unknown'.",
        "#",
        "# ${MIRROR_REGISTRY} is substituted by build/render-manifest.py, which fails loudly",
        "# on any placeholder it cannot resolve.",
        "#",
        "# Regenerate:  bash src/argo/render.sh",
        "",
    ])
    (out / name).write_text(header + text)
    print(f"  {name}: {total} image reference(s) rewritten, "
          f"{len((header + text).splitlines())} lines")
PY

echo
echo "Wrote $OUT_DIR/argocd-install.yaml and $OUT_DIR/metrics-server.yaml"
