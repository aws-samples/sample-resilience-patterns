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
#
# Argo CD's install.yaml names its cache as public.ecr.aws/docker/library/redis:<tag>.
# The mirror serves that reference with VALKEY (see the valkey entry in images.json for
# the license reason and the compatibility evidence), so the redis tag Argo pins is
# irrelevant here: the rewrite matches the redis reference by repository, whatever its
# tag, and repoints it at the valkey tag + digest the lockfile pins.

read -r ARGOCD_DIGEST VALKEY_TAG VALKEY_DIGEST DEX_TAG DEX_DIGEST MS_DIGEST <<EOF
$(python3 - "$REPO_ROOT/src/mirror/images.json" <<'PY'
import json, sys
imgs = {i["name"]: i for i in json.load(open(sys.argv[1]))["images"]}
need = ["argocd", "valkey", "dex", "metrics-server"]
missing = [n for n in need if n not in imgs]
if missing:
    sys.exit(f"ERROR: images.json is missing {missing}")
print(imgs["argocd"]["arm64Digest"],
      imgs["valkey"]["tag"], imgs["valkey"]["arm64Digest"],
      imgs["dex"]["tag"], imgs["dex"]["arm64Digest"],
      imgs["metrics-server"]["arm64Digest"])
PY
)
EOF

echo "Digests from src/mirror/images.json:"
echo "  argocd         $ARGOCD_VERSION @ $ARGOCD_DIGEST"
echo "  valkey         $VALKEY_TAG @ $VALKEY_DIGEST   (serves Argo CD's redis reference)"
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
#
# NAMESPACES ARE INJECTED INTO THE DOCUMENTS. Upstream install.yaml assumes
# `kubectl apply -n argocd` and carries no metadata.namespace on its namespaced docs, while
# our in-VPC installer applies one concatenated file with no -n. Without this step an
# entire Argo CD instance lands in `default` and the Service + config override sit in
# `argocd` selecting nothing (docs/lessons.md). A test asserts every namespaced doc in
# every manifest names its namespace, so a regenerate that dropped this would fail the
# build -- but the generator must produce the file the tests pass against, not rely on a
# hand-edit after the fact.
# The heredoc is QUOTED so the shell performs no expansion — an unquoted one tries to expand
# the Python f-strings and `${{...}}` and dies with "bad substitution". Values arrive through
# the environment instead.
ARGOCD_VERSION="$ARGOCD_VERSION" \
METRICS_SERVER_VERSION="$METRICS_SERVER_VERSION" \
ARGOCD_DIGEST="$ARGOCD_DIGEST" \
VALKEY_TAG="$VALKEY_TAG" VALKEY_DIGEST="$VALKEY_DIGEST" \
DEX_TAG="$DEX_TAG" DEX_DIGEST="$DEX_DIGEST" \
MS_DIGEST="$MS_DIGEST" \
WORK_DIR="$WORK" OUT_DIR="$OUT_DIR" \
python3 - <<'PY'
import os, pathlib, re, sys

work = pathlib.Path(os.environ["WORK_DIR"])
out = pathlib.Path(os.environ["OUT_DIR"])
E = os.environ
M = "${MIRROR_REGISTRY}"

# (pattern, replacement). Patterns are regexes so the redis reference matches whatever tag
# upstream pins -- the mirror serves it with valkey at the lockfile's tag, so Argo's redis
# tag never appears in the output and a bump of it upstream cannot zero-match this rewrite.
REWRITES = {
    "argocd-install.yaml": [
        (re.escape(f"quay.io/argoproj/argocd:{E['ARGOCD_VERSION']}"),
         f"{M}/argocd:{E['ARGOCD_VERSION']}@{E['ARGOCD_DIGEST']}"),
        (r"public\.ecr\.aws/docker/library/redis:[^\s@]+",
         f"{M}/valkey:{E['VALKEY_TAG']}@{E['VALKEY_DIGEST']}"),
        (re.escape(f"ghcr.io/dexidp/dex:{E['DEX_TAG']}"),
         f"{M}/dex:{E['DEX_TAG']}@{E['DEX_DIGEST']}"),
    ],
    "metrics-server.yaml": [
        (re.escape(f"registry.k8s.io/metrics-server/metrics-server:{E['METRICS_SERVER_VERSION']}"),
         f"{M}/metrics-server:{E['METRICS_SERVER_VERSION']}@{E['MS_DIGEST']}"),
    ],
}

# Which namespace each manifest's namespaced docs belong to. metrics-server's upstream
# already names kube-system on every doc, so injection is a no-op there -- kept in the table
# so the same invariant is asserted for both files.
NAMESPACE = {"argocd-install.yaml": "argocd", "metrics-server.yaml": "kube-system"}

# Mirrors the CLUSTER_SCOPED set in test/topology.test.ts.
CLUSTER_SCOPED = {
    "ClusterRole", "ClusterRoleBinding", "CustomResourceDefinition", "Namespace",
    "APIService", "PriorityClass", "StorageClass", "EC2NodeClass", "NodePool",
}


def inject_namespace(text, namespace):
    """Insert `  namespace: <ns>` under the TOP-LEVEL metadata of every namespaced doc that
    lacks one. Byte-preserving otherwise: docs are split on their own separators and
    rejoined with them."""
    parts = re.split(r"(?m)^(---[ \t]*)$", text)
    injected = 0
    for i in range(0, len(parts), 2):  # even indexes are docs, odd are separators
        doc = parts[i]
        kind = re.search(r"(?m)^kind:\s*(\S+)", doc)
        if not kind or kind.group(1) in CLUSTER_SCOPED:
            continue
        # The top-level metadata block: from a column-0 `metadata:` to the next column-0 key.
        m = re.search(r"(?m)^metadata:\n((?:[ \t].*\n|\n)*)", doc)
        if not m:
            sys.exit(f"ERROR: {kind.group(1)} doc has no top-level metadata block")
        if re.search(r"(?m)^ {2}namespace:\s*\S+", m.group(1)):
            continue
        parts[i] = doc[: m.end(0) - len(m.group(1))] + f"  namespace: {namespace}\n" + m.group(1) + doc[m.end(0):]
        injected += 1
    return "".join(parts), injected


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
    for pattern, new in pairs:
        text, n = re.subn(pattern, new, text)
        if n == 0:
            sys.exit(
                f"ERROR: {name} contains no reference matching {pattern!r}. The upstream "
                f"manifest changed its image reference, and rewriting nothing would leave pods "
                f"pulling from the internet inside an isolated subnet."
            )
        total += n
    # Nothing may still point at a public registry.
    for host in ("quay.io/", "ghcr.io/", "registry.k8s.io/", "public.ecr.aws/"):
        if f"image: {host}" in text:
            sys.exit(f"ERROR: {name} still references {host}")
    text, injected = inject_namespace(text, NAMESPACE[name])
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
    print(f"  {name}: {total} image reference(s) rewritten, {injected} namespace(s) injected, "
          f"{len((header + text).splitlines())} lines")
PY

echo
echo "Wrote $OUT_DIR/argocd-install.yaml and $OUT_DIR/metrics-server.yaml"
