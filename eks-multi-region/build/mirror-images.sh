#!/usr/bin/env bash
#
# Mirror the pinned third-party images in src/mirror/images.json into PRIVATE
# ECR, in every target region, using crane.
#
# WHY REGISTRY-TO-REGISTRY AND NOT A TARBALL ROUND-TRIP.
# The sibling script build/deploy-docker.sh pushes tarballs that the build stage
# produced, because those images are BUILT from CDK assets. These images are not
# built — they already exist upstream — so the tarball detour would only add
# several hundred MB of third-party layers to dist/content.zip and to S3 for no
# gain. `crane copy` moves them registry-to-registry.
#
# The deploy stage is the right home for this, and that is not an assumption:
# its before_script already curls the crane release from github.com, which proves
# the stage has internet egress, and it holds the AWS credentials ECR needs.
#
# WHAT "MIRRORED" HAS TO MEAN HERE. Pods in the isolated subnets can only pull
# from private ECR over the step-3a interface endpoints. public.ecr.aws is a
# separate internet-facing service and is NOT reachable through them, so Argo
# CD's own redis reference has to be mirrored too — see the note in images.json.
#
# INTEGRITY. Every image is pulled by DIGEST (tags upstream are mutable) and the
# pushed result is read back from ECR to confirm the expected digest arrived. A
# silent digest change would mean the cluster runs something other than what was
# reviewed.
#
# ARM64-ONLY BY DEFAULT, AND THAT IS MEASURED. Copying the full multi-platform
# index moves 1500 MB per region for these five images against 309 MB for
# linux/arm64 alone -- 4.8x, all of it platforms the AL2023_ARM_64_STANDARD / m7g
# node group cannot run. Verification is NOT sacrificed for the saving: the arm64
# child-manifest digest is pinned separately in images.json and checked after the
# push, so both modes are verifiable.
#
# Optional env:
#   MIRROR_REGIONS     CSV of target regions. Falls back to $AWS_REGION.
#   MIRROR_MANIFEST    Defaults to src/mirror/images.json.
#   MIRROR_FULL_INDEX  "true" copies the whole multi-platform index and verifies
#                      the INDEX digest. Costs ~4.8x the transfer and pulls in the
#                      attestation manifests that redis, dex and nginx carry.
#   MIRROR_PLATFORM    Defaults to linux/arm64, matching the node group. Any other
#                      value still copies, but strict digest verification is
#                      SKIPPED because only the arm64 child digest is pinned.
#   DRY_RUN            "true" to print planned actions and exit without writing.

set -euo pipefail

MIRROR_MANIFEST="${MIRROR_MANIFEST:-src/mirror/images.json}"
MIRROR_REGIONS="${MIRROR_REGIONS:-${AWS_REGION:-}}"
MIRROR_FULL_INDEX="${MIRROR_FULL_INDEX:-false}"
MIRROR_PLATFORM="${MIRROR_PLATFORM:-linux/arm64}"
DRY_RUN="${DRY_RUN:-false}"

# Full-index mode is expressed by clearing the platform, so crane copies the index.
if [ "$MIRROR_FULL_INDEX" = "true" ]; then
  MIRROR_PLATFORM=""
fi

# ---- preflight ------------------------------------------------------------

if [ ! -f "$MIRROR_MANIFEST" ]; then
  echo "ERROR: mirror manifest not found: $MIRROR_MANIFEST" >&2
  exit 1
fi

if [ -z "$MIRROR_REGIONS" ]; then
  echo "ERROR: no target regions. Set MIRROR_REGIONS (CSV) or AWS_REGION." >&2
  exit 1
fi

if ! command -v crane >/dev/null 2>&1; then
  echo "ERROR: crane not found on PATH" >&2
  echo "  The deploy job installs it in before_script; install locally from" >&2
  echo "  https://github.com/google/go-containerregistry/releases" >&2
  exit 1
fi

# Fail before touching a registry if the manifest is malformed or a digest is
# missing. A tag-only entry would mirror something unpinned, which is exactly
# what this file exists to prevent.
python3 - "$MIRROR_MANIFEST" <<'PY'
import json, re, sys
doc = json.load(open(sys.argv[1]))
prefix = doc.get("ecrRepositoryPrefix")
if not prefix:
    sys.exit("ERROR: ecrRepositoryPrefix missing from mirror manifest")
images = doc.get("images") or []
if not images:
    sys.exit("ERROR: mirror manifest lists no images")
seen = set()
for img in images:
    for field in ("name", "upstream", "tag", "digest", "arm64Digest"):
        if not img.get(field):
            sys.exit(f"ERROR: image {img.get('name', '<unnamed>')} missing '{field}'")
    for field in ("digest", "arm64Digest"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", img[field]):
            sys.exit(f"ERROR: image {img['name']} {field} is not a sha256 digest: {img[field]}")
    if img["digest"] == img["arm64Digest"]:
        # The arm64 child manifest is a DIFFERENT object from the index that
        # references it. Equal values mean one was copy-pasted, and the flattened
        # mode would then verify against the wrong digest and fail every push.
        sys.exit(f"ERROR: image {img['name']} has digest == arm64Digest")
    if img["name"] in seen:
        sys.exit(f"ERROR: duplicate image name {img['name']}")
    seen.add(img["name"])
print(f"Mirror manifest OK: {len(images)} image(s), prefix {prefix}")
PY

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "Deploying account: $ACCOUNT_ID"
echo "Target regions:    $MIRROR_REGIONS"
if [ -n "$MIRROR_PLATFORM" ]; then
  echo "Platform:          $MIRROR_PLATFORM (single platform)"
else
  echo "Platform:          full multi-platform index (MIRROR_FULL_INDEX)"
fi

# ---- helpers --------------------------------------------------------------

# Run a `crane copy` with bounded exponential backoff on registry rate limits.
# Retries ONLY on the throttling signatures (HTTP 429 / TOOMANYREQUESTS / "Rate
# exceeded" / "rate limit"); any other failure surfaces immediately, because a
# wrong digest or a denied push must not be retried into a pass.
copy_with_retry() {
  local attempt=1 max=5 delay=10 out
  while :; do
    if out=$("$@" 2>&1); then
      printf '%s\n' "$out"
      return 0
    fi
    printf '%s\n' "$out"
    if [ "$attempt" -ge "$max" ] \
       || ! printf '%s' "$out" | grep -qiE 'TOOMANYREQUESTS|rate exceeded|rate limit|status 429|: 429'; then
      return 1
    fi
    echo "    rate-limited by upstream (attempt $attempt/$max); retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1)); delay=$((delay * 2))
  done
}

# Authenticate to ECR Public once. Anonymous pulls from public.ecr.aws are
# rate-limited per source IP, and a CI runner shares its egress IP with many other
# jobs -- five of the eight mirrored images come from there. An authenticated
# session gets a far higher limit. BEST-EFFORT: the token needs
# ecr-public:GetAuthorizationToken, which a local operator's identity may lack; in
# that case say so and continue anonymously (the retry above still applies).
# ECR Public tokens are issued only from us-east-1.
login_ecr_public() {
  if [ "$DRY_RUN" = "true" ]; then return 0; fi
  if aws ecr-public get-login-password --region us-east-1 2>/dev/null \
       | crane auth login --username AWS --password-stdin public.ecr.aws >/dev/null 2>&1; then
    echo "Authenticated to public.ecr.aws (lifts the anonymous pull rate limit)"
  else
    echo "WARNING: could not authenticate to public.ecr.aws (needs ecr-public:GetAuthorizationToken);"
    echo "         pulling anonymously -- rate limits are lower, retries will cover transient 429s"
  fi
}
login_ecr_public

ensure_repo() {
  local region="$1" repo="$2"
  if aws ecr describe-repositories --region "$region" --repository-names "$repo" >/dev/null 2>&1; then
    echo "    repo exists"
    return
  fi
  if [ "$DRY_RUN" = "true" ]; then
    echo "    (dry-run: would create repo $repo)"
    return
  fi
  aws ecr create-repository \
    --region "$region" \
    --repository-name "$repo" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 \
    >/dev/null
  echo "    repo created"
}

# Idempotency is checked by DIGEST, not by tag. A tag can be moved; asking
# whether this exact digest is already present is the question that matters, and
# it also means a re-pin to a new digest is never mistaken for "already done".
digest_present() {
  local region="$1" repo="$2" digest="$3"
  aws ecr describe-images \
    --region "$region" \
    --repository-name "$repo" \
    --image-ids "imageDigest=$digest" \
    >/dev/null 2>&1
}

# ---- mirror loop ----------------------------------------------------------

# Emit one tab-separated row per image: name, upstream, tag, index digest,
# arm64 child digest, repo path.
python3 - "$MIRROR_MANIFEST" <<'PY' > /tmp/mirror-plan.tsv
import json, sys
doc = json.load(open(sys.argv[1]))
prefix = doc["ecrRepositoryPrefix"].strip("/")
for img in doc["images"]:
    print("\t".join([
        img["name"], img["upstream"], img["tag"], img["digest"], img["arm64Digest"],
        f"{prefix}/{img['name']}",
    ]))
PY

IFS=',' read -ra REGIONS <<< "$MIRROR_REGIONS"
MIRRORED=0
SKIPPED=0

while IFS="$(printf '\t')" read -r NAME UPSTREAM TAG DIGEST ARM64_DIGEST REPO; do
  [ -z "${NAME:-}" ] && continue

  # What SHOULD be in ECR after the copy, and therefore what idempotency and the
  # read-back both compare against. Flattening to linux/arm64 pushes the child
  # manifest, so the expected digest is the child's, not the index's. Any other
  # platform has no pinned digest, so strict checking is disabled rather than
  # compared against a value that cannot match.
  if [ -z "$MIRROR_PLATFORM" ]; then
    EXPECTED_DIGEST="$DIGEST"
    VERIFY=true
  elif [ "$MIRROR_PLATFORM" = "linux/arm64" ]; then
    EXPECTED_DIGEST="$ARM64_DIGEST"
    VERIFY=true
  else
    EXPECTED_DIGEST=""
    VERIFY=false
  fi

  echo
  echo "=== $NAME ($UPSTREAM:$TAG)"
  echo "  index digest:    $DIGEST"
  echo "  arm64 digest:    $ARM64_DIGEST"
  if [ "$VERIFY" = "true" ]; then
    echo "  expecting in ECR: $EXPECTED_DIGEST"
  else
    echo "  expecting in ECR: <unpinned for $MIRROR_PLATFORM — verification skipped>"
  fi

  for REGION in "${REGIONS[@]}"; do
    REGION="$(echo "$REGION" | xargs)"
    [ -z "$REGION" ] && continue
    REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
    DEST="$REGISTRY/$REPO:$TAG"

    echo "  --- $REGION: $REPO:$TAG"
    ensure_repo "$REGION" "$REPO"

    if [ "$DRY_RUN" != "true" ] && [ "$VERIFY" = "true" ] \
       && digest_present "$REGION" "$REPO" "$EXPECTED_DIGEST"; then
      echo "    expected digest already present — skipping copy"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    if [ "$DRY_RUN" = "true" ]; then
      echo "    (dry-run: would crane copy ${UPSTREAM} at ${DIGEST} -> $DEST)"
      continue
    fi

    aws ecr get-login-password --region "$REGION" \
      | crane auth login --username AWS --password-stdin "$REGISTRY"

    # Pull by DIGEST, push under the readable tag. The tag is a convenience for
    # humans reading `kubectl describe`; the digest is what was reviewed.
    #
    # ATTESTATION MANIFESTS. The redis, dex and nginx OCI indexes each carry
    # attestation entries (platform architecture "unknown") alongside the real
    # platforms — 8, 5 and 8 of them respectively. Flattening to one platform, the
    # default, never touches them. MIRROR_FULL_INDEX=true does, and if ECR rejects
    # them the copy fails LOUDLY here in CI rather than at demo time.
    #
    # BOUNDED RETRY. Every upstream here (public.ecr.aws, quay.io, ghcr.io,
    # registry.k8s.io) rate-limits anonymous pulls, and a CI runner shares its egress
    # IP with many others: e2e iteration 2 died on the SECOND image with
    # "TOOMANYREQUESTS: Rate exceeded" from public.ecr.aws. A 429 is transient by
    # definition, so retry with backoff (5 attempts, 10s..160s) instead of failing a
    # 90-minute deploy on it. Any other error still fails on the first attempt.
    if [ -n "$MIRROR_PLATFORM" ]; then
      copy_with_retry crane copy --platform "$MIRROR_PLATFORM" "${UPSTREAM}@${DIGEST}" "$DEST"
    else
      copy_with_retry crane copy "${UPSTREAM}@${DIGEST}" "$DEST"
    fi

    # Read back. Whatever mode was used, the digest that landed must be the one
    # pinned for that mode — otherwise the cluster runs something unreviewed.
    if [ "$VERIFY" = "true" ]; then
      if digest_present "$REGION" "$REPO" "$EXPECTED_DIGEST"; then
        echo "    pushed and digest verified: $DEST"
      else
        echo "    ERROR: $DEST does not carry the pinned digest $EXPECTED_DIGEST after copy." >&2
        echo "    The cluster would run something other than what was reviewed." >&2
        exit 1
      fi
    else
      echo "    pushed (no pinned digest for $MIRROR_PLATFORM; verification skipped)"
    fi
    MIRRORED=$((MIRRORED + 1))
  done
done < /tmp/mirror-plan.tsv

rm -f /tmp/mirror-plan.tsv

echo
if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run complete — no images were copied."
else
  echo "Mirror complete: $MIRRORED copied, $SKIPPED already present."
fi
