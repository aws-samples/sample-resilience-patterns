#!/usr/bin/env bash
#
# Push the pre-built image tarballs to ECR in every target region.
#
# Expects the build stage to have produced:
#   <CONTENT_DIR>/containers/manifest.json
#   <CONTENT_DIR>/containers/<hash>.tar.gz
#
# Uses `crane` (https://github.com/google/go-containerregistry) — a
# single static Go binary that speaks the OCI registry protocol
# directly. No docker daemon, no user namespaces needed, so it works
# on restricted CI runners where dind/podman/buildah all failed.
#
# Idempotent: skips ECR repos that already exist, skips pushes when the
# exact content-hashed tag is already present.
#
# Target regions are a per-image property. Each entry in Container_Manifest
# carries a `regions` array listing the AWS regions that image needs to be
# pushed to. This script iterates over that per-entry list, so different
# images can target different regions without any env gymnastics.
#
# Optional env:
#   CONTENT_DIR            Where deploy-upload.sh unpacked content.zip.
#                          Defaults to dist/content.
#   DOCKER_IMAGE_REGIONS   CSV fallback for entries whose manifest record
#                          predates the `regions` field (mid-transition
#                          compatibility). If both the entry's `regions`
#                          field is missing and this env var is unset,
#                          the script falls back to [$AWS_REGION].
#   DRY_RUN                "true" to print actions and exit.

set -euo pipefail

CONTENT_DIR="${CONTENT_DIR:-dist/content}"
DRY_RUN="${DRY_RUN:-false}"
MANIFEST="$CONTENT_DIR/containers/manifest.json"

# Fallback regions list used only when a manifest entry lacks a `regions`
# field. New manifests produced by build/build-docker.sh always include the
# field, so this fallback matters only for pipelines that built with an
# older build:docker step. Exported so the python snippet below sees it.
export DOCKER_IMAGE_REGIONS_FALLBACK="${DOCKER_IMAGE_REGIONS:-${AWS_REGION:-}}"

# ---- helpers --------------------------------------------------------------

ensure_repo() {
  local region="$1"
  local repo="$2"
  if aws ecr describe-repositories --region "$region" --repository-names "$repo" >/dev/null 2>&1; then
    echo "  repo exists"
    return
  fi
  if [ "$DRY_RUN" = "true" ]; then
    echo "  (dry-run: would create repo $repo)"
    return
  fi
  aws ecr create-repository \
    --region "$region" \
    --repository-name "$repo" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 \
    >/dev/null
  echo "  repo created"
}

image_exists() {
  local region="$1"
  local repo="$2"
  local tag="$3"
  aws ecr describe-images \
    --region "$region" \
    --repository-name "$repo" \
    --image-ids "imageTag=$tag" \
    >/dev/null 2>&1
}

# ---- preflight ------------------------------------------------------------

if [ ! -f "$MANIFEST" ]; then
  echo "Missing container manifest at $MANIFEST. Did build:docker run?" >&2
  exit 1
fi

COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$MANIFEST")
if [ "$COUNT" -eq 0 ]; then
  echo "Manifest has zero images — nothing to push."
  exit 0
fi

if ! command -v crane >/dev/null 2>&1; then
  echo "ERROR: crane not found on PATH" >&2
  echo "Install from https://github.com/google/go-containerregistry/releases" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "Deploying account: $ACCOUNT_ID"
echo "Pushing $COUNT image(s) from $CONTENT_DIR/containers/ via crane"

# ---- push loop ------------------------------------------------------------

# Emit one row per image with tab-separated fields:
#   hash, repository_template, tag_template, comma-separated regions.
# The regions come from the entry's `regions` field when present, otherwise
# from DOCKER_IMAGE_REGIONS_FALLBACK (mid-transition compatibility).
python3 -c '
import json, os, sys
fallback = os.environ.get("DOCKER_IMAGE_REGIONS_FALLBACK", "").strip()
for img in json.load(open(sys.argv[1])):
    regions = img.get("regions") or (
        [r.strip() for r in fallback.split(",") if r.strip()]
    )
    if not regions:
        h = img["hash"]
        sys.stderr.write(
            f"ERROR: image {h} has no regions and no fallback set\n"
        )
        sys.exit(1)
    print("\t".join([img["hash"], img["repository"], img["tag"], ",".join(regions)]))
' "$MANIFEST" | while IFS=$'\t' read -r IMAGE_HASH REPO_TEMPLATE TAG_TEMPLATE REGIONS_CSV; do
  TAR_PATH="$CONTENT_DIR/containers/${IMAGE_HASH}.tar.gz"
  if [ ! -f "$TAR_PATH" ]; then
    echo "ERROR: image tar not found: $TAR_PATH (manifest referenced $IMAGE_HASH)" >&2
    exit 1
  fi

  echo
  echo "=== $IMAGE_HASH ==="
  echo "  regions: $REGIONS_CSV"

  # crane push reads uncompressed tarballs, so decompress once and
  # reuse across regions. The gunzipped copy is cleaned up after the
  # region loop.
  UNCOMPRESSED="${TAR_PATH%.gz}"
  if [ ! -f "$UNCOMPRESSED" ]; then
    gunzip -k "$TAR_PATH"
  fi

  IFS=',' read -ra REGIONS <<< "$REGIONS_CSV"
  for REGION in "${REGIONS[@]}"; do
    REGION="$(echo "$REGION" | xargs)"
    REPO_NAME="${REPO_TEMPLATE//\$\{AWS::AccountId\}/$ACCOUNT_ID}"
    REPO_NAME="${REPO_NAME//\$\{AWS::Region\}/$REGION}"
    IMAGE_TAG="${TAG_TEMPLATE//\$\{AWS::AccountId\}/$ACCOUNT_ID}"
    IMAGE_TAG="${IMAGE_TAG//\$\{AWS::Region\}/$REGION}"
    REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
    FULL_IMAGE="$REGISTRY/$REPO_NAME:$IMAGE_TAG"

    echo
    echo "--- $REGION: $REPO_NAME:$IMAGE_TAG ---"

    ensure_repo "$REGION" "$REPO_NAME"

    if image_exists "$REGION" "$REPO_NAME" "$IMAGE_TAG"; then
      echo "  image tag $IMAGE_TAG already present — skipping push"
      continue
    fi

    if [ "$DRY_RUN" = "true" ]; then
      echo "  (dry-run: would crane push to $FULL_IMAGE)"
      continue
    fi

    # Log in to the region's ECR registry. crane stashes creds in
    # ~/.docker/config.json (same as docker), scoped to the registry
    # host, so subsequent pushes pick them up automatically. Token is
    # valid for 12 hours — plenty for a single deploy pipeline.
    aws ecr get-login-password --region "$REGION" \
      | crane auth login --username AWS --password-stdin "$REGISTRY"
    crane push "$UNCOMPRESSED" "$FULL_IMAGE"
    echo "  pushed $FULL_IMAGE"
  done

  rm -f "$UNCOMPRESSED"
done

echo
echo "All docker image assets pushed."
