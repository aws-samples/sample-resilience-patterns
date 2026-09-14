#!/usr/bin/env bash
#
# Container build plan generator.
#
# Reads every `cdk.out/*.assets.json`, enumerates unique DockerImageAssets,
# and emits two artifacts:
#
#   1. assets/containers/manifest.json  — Container_Manifest consumed by
#      build/deploy-docker.sh. Exact schema the design specifies:
#
#          [
#            {
#              "hash": "<content-hash>",
#              "platform": "linux/arm64",
#              "repository": "cdk-…-${AWS::AccountId}-${AWS::Region}",
#              "tag": "<content-hash>",
#              "regions": ["ca-central-1", …]
#            }
#          ]
#
#   2. dist/container-plan.tsv  — a tab-separated file consumed by
#      build/build-docker.sh on the kaniko image. Each line is:
#
#          <image-hash>\t<staged-directory>\t<platform>
#
#      The build script walks the file, runs /kaniko/executor once per
#      row, and is dependency-free (busybox sh + kaniko only — no python,
#      no apk). The kaniko `:debug` image is distroless + busybox, so a
#      python-free consumer is the only way to make build:docker run on
#      it out-of-the-box.
#
# This script runs on the plain node image (Build_Container_Plan_Job),
# where python3 is available. `build:container-plan` is registered as a
# granular projen task; `ci:build:container-plan` is the composite name
# the CI job invokes.
#
# Optional env:
#   CDK_OUT_DIR          Defaults to cdk.out.
#   DOCKER_IMAGE_REGIONS Comma-separated AWS regions that each image will
#                        be pushed to, recorded in Container_Manifest.
#                        Falls back to $AWS_REGION, then us-east-1.

set -euo pipefail

CDK_OUT_DIR="${CDK_OUT_DIR:-cdk.out}"
CONTAINERS_DIR="assets/containers"
PLAN_FILE="dist/container-plan.tsv"

# Mirror build-docker.sh's fallback chain so a caller invoking either
# script directly ends up with the same resolved region list.
DOCKER_IMAGE_REGIONS="${DOCKER_IMAGE_REGIONS:-${AWS_REGION:-us-east-1}}"

mkdir -p "$CONTAINERS_DIR" "$(dirname "$PLAN_FILE")"

if [ ! -d "$CDK_OUT_DIR" ]; then
  echo "ERROR: CDK_OUT_DIR not found: $CDK_OUT_DIR" >&2
  exit 1
fi

# ---- enumerate + write artifacts ------------------------------------------

# Single python invocation writes both files so the parse happens once.
# Reads every cdk.out/*.assets.json, dedups by image hash, outputs the
# manifest JSON and the TSV plan file side-by-side.
CDK_OUT_DIR="$CDK_OUT_DIR" \
DOCKER_IMAGE_REGIONS="$DOCKER_IMAGE_REGIONS" \
MANIFEST_PATH="$CONTAINERS_DIR/manifest.json" \
PLAN_PATH="$PLAN_FILE" \
python3 - <<'PY'
import json
import os
import pathlib
import sys

cdk_out = pathlib.Path(os.environ["CDK_OUT_DIR"])
manifest_path = pathlib.Path(os.environ["MANIFEST_PATH"])
plan_path = pathlib.Path(os.environ["PLAN_PATH"])
regions = [r.strip() for r in os.environ["DOCKER_IMAGE_REGIONS"].split(",") if r.strip()]

seen = set()
build_entries = []   # one per unique image hash — what gets BUILT
push_entries = []    # one per (hash, destination) — what gets PUSHED
for assets_json in sorted(cdk_out.glob("*.assets.json")):
    with assets_json.open() as fh:
        manifest = json.load(fh)
    for image_hash, entry in (manifest.get("dockerImages") or {}).items():
        src = entry["source"]
        platform = src.get("platform", "linux/amd64")

        # BUILD side: dedup by content hash. The same image referenced by stacks in
        # several regions is byte-identical and must only be built once.
        if image_hash not in seen:
            seen.add(image_hash)
            build_entries.append({
                "hash": image_hash,
                "directory": src["directory"],
                "platform": platform,
            })

        # PUSH side: one entry PER DESTINATION, deliberately NOT deduped.
        #
        # This used to take only the first destination per hash, and that was wrong for
        # any multi-region demo. CDK RESOLVES the region into the repository name — the
        # destination reads `cdk-...-container-assets-${AWS::AccountId}-us-east-2`, with
        # the account left as a placeholder but the region a literal. So keeping one
        # destination per image discards every other region's repository NAME, and
        # deploy-docker.sh's ${AWS::Region} substitution has nothing to substitute. The
        # image then gets pushed into the second region under the FIRST region's
        # repository name, while pods there pull the name that matches their own region
        # and get ImagePullBackOff. Build green, deploy green, workload dead.
        #
        # Each destination also carries its own `region`, which is more trustworthy than
        # a global DOCKER_IMAGE_REGIONS list: a region appears here precisely because a
        # stack deployed there references the image.
        for dest in entry["destinations"].values():
            push_entries.append({
                "hash": image_hash,
                "platform": platform,
                "repository": dest["repositoryName"],
                "tag": dest["imageTag"],
                "regions": [dest["region"]] if dest.get("region") else regions,
            })

# manifest.json (deploy-side) — one record per image PER TARGET REGION.
manifest_path.write_text(json.dumps(push_entries, indent=2) + "\n")

# container-plan.tsv (build-side) — exactly what build-docker.sh needs, deduped by hash.
# Tabs as separators; one line per image. Trailing newline for sanity.
with plan_path.open("w") as fh:
    for e in build_entries:
        fh.write(f"{e['hash']}\t{e['directory']}\t{e['platform']}\n")

print(
    f"Wrote {len(push_entries)} push target(s) for {len(build_entries)} image(s) "
    f"to {manifest_path} and {plan_path}"
)
if not build_entries:
    print("ERROR: no DockerImageAssets found in cdk.out — check build:cdk artifacts", file=sys.stderr)
    sys.exit(1)
PY
