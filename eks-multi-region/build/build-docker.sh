#!/usr/bin/env sh
#
# Build every DockerImageAsset listed in dist/container-plan.tsv with
# Kaniko and save each one to assets/containers/<hash>.tar.gz.
#
# Kaniko is used instead of `docker build` because our CI runner fleet
# (the original CI) doesn't allow Docker-in-Docker and
# blocks the CLONE_NEWUSER syscall that rootless podman/buildah need.
# Kaniko builds OCI images in a chroot — no daemon, no user namespaces.
#
# This script is written for the kaniko `:debug` image, which is
# distroless + busybox — so no python, no apk, no bash. Everything here
# is POSIX sh + busybox coreutils. The JSON-heavy work (enumerating CDK
# assets, writing manifest.json, computing regions) lives in
# build/container-plan.sh, which runs on the plain node image and
# produces dist/container-plan.tsv for this script to consume.
#
# Output layout (relative to repo root):
#
#   assets/containers/<hash>.tar.gz
#
# Container_Manifest (assets/containers/manifest.json) is produced by
# build/container-plan.sh, not here. The package:content task zips
# assets/, so the containers ride along in dist/content.zip.
#
# Invocation paths:
#   1. Native kaniko (CI job running on the kaniko image):
#        /kaniko/executor --no-push --tarPath=<file>
#   2. Docker-wrapped kaniko (local dev with docker daemon):
#        docker run --rm $KANIKO_IMAGE ...
# Both produce identical OCI tarballs.
#
# Optional env:
#   KANIKO_IMAGE         Defaults to gcr.io/kaniko-project/executor:v1.23.2-debug.
#   CONTAINER_PLAN_FILE  Defaults to dist/container-plan.tsv.
#   CONTAINERS_DIR       Defaults to assets/containers.
#   CDK_OUT_DIR          Defaults to cdk.out (the staged asset directories
#                        referenced by relative paths in the plan file).

set -eu

KANIKO_IMAGE="${KANIKO_IMAGE:-gcr.io/kaniko-project/executor:v1.23.2-debug}"
CONTAINER_PLAN_FILE="${CONTAINER_PLAN_FILE:-dist/container-plan.tsv}"
CONTAINERS_DIR="${CONTAINERS_DIR:-assets/containers}"
CDK_OUT_DIR="${CDK_OUT_DIR:-cdk.out}"

mkdir -p "$CONTAINERS_DIR"

# ---- preflight ------------------------------------------------------------

if [ ! -f "$CONTAINER_PLAN_FILE" ]; then
  echo "ERROR: container plan file not found: $CONTAINER_PLAN_FILE" >&2
  echo "  (did build:container-plan / yarn ci:build:container-plan run?)" >&2
  exit 1
fi

# Count non-empty lines — gives us "0 images" detection without any jq/python.
COUNT=$(grep -cv '^[[:space:]]*$' "$CONTAINER_PLAN_FILE" || true)
if [ "$COUNT" = "0" ]; then
  echo "Container plan is empty — nothing to build."
  exit 0
fi

# ---- pick a kaniko invocation ---------------------------------------------

# Native kaniko (CI): the job image IS kaniko, the executor binary is
# at /kaniko/executor. No container wrapping needed.
if [ -x /kaniko/executor ]; then
  echo "Using native kaniko at /kaniko/executor"
  kaniko_mode="native"
# Docker-wrapped kaniko (local dev): the host has docker, so launch
# the kaniko container with the build context bind-mounted.
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Using docker-wrapped kaniko: $KANIKO_IMAGE"
  kaniko_mode="docker"
else
  echo "Neither /kaniko/executor nor docker are available — cannot build images." >&2
  echo "  (on CI, build:docker runs on the kaniko image; locally, install Docker)" >&2
  exit 1
fi

echo "Building $COUNT image(s) from $CONTAINER_PLAN_FILE into $CONTAINERS_DIR"

REPO_ROOT="$(pwd)"

# ---- host architecture vs requested platform ------------------------------
#
# KANIKO CANNOT CROSS-BUILD. `--custom-platform` only rewrites the platform recorded in
# the image config; the build itself always produces host-architecture binaries
# (GoogleContainerTools/kaniko#1587, #2127). Building an arm64-labelled image on an
# x86_64 host therefore yields an image that fails at runtime with
#   exec format error
# either inside kaniko itself (as it does here, when the base image pulled for the
# requested platform cannot run) or later, in the pod, as a CrashLoopBackOff with no
# useful diagnostic.
#
# The demo targets arm64 because the CI runner fleet is arm64. A builder on an
# x86_64 desktop therefore cannot produce this image, and `npx projen build` should not
# fail for that reason — the CDK synth, the tests and the packaging are all still valid.
# So a mismatch SKIPS with a loud warning by default.
#
# In CI that silence would be dangerous: a skipped build produces no tarball, and the
# failure would surface much later as an ECR push with nothing to push. Set
# REQUIRE_CONTAINER_BUILD=true (the CI job does) to turn the skip into a hard failure.
REQUIRE_CONTAINER_BUILD="${REQUIRE_CONTAINER_BUILD:-false}"
case "$(uname -m)" in
  x86_64 | amd64) HOST_ARCH=amd64 ;;
  aarch64 | arm64) HOST_ARCH=arm64 ;;
  *) HOST_ARCH="$(uname -m)" ;;
esac

# ---- build loop -----------------------------------------------------------

# Read tab-separated plan file line by line. Busybox `read -r` splits on
# IFS; we set IFS to tab explicitly so hashes containing no tabs are
# safe and the third field captures the platform unchanged.
while IFS="$(printf '\t')" read -r IMAGE_HASH DIRECTORY PLATFORM; do
  # Skip blank lines defensively — they shouldn't exist but grep -v handled
  # counting and we'd rather survive stray whitespace than fail loudly here.
  [ -z "${IMAGE_HASH:-}" ] && continue

  STAGED_DIR="$CDK_OUT_DIR/$DIRECTORY"
  if [ ! -d "$STAGED_DIR" ]; then
    echo "ERROR: staged directory not found: $STAGED_DIR" >&2
    exit 1
  fi

  # Architecture gate — see the long note above.
  TARGET_ARCH="${PLATFORM#linux/}"
  if [ "$TARGET_ARCH" != "$HOST_ARCH" ]; then
    echo
    echo "=== $IMAGE_HASH ==="
    echo "  SKIPPING: image targets $PLATFORM but this host is $HOST_ARCH."
    echo "  kaniko cannot cross-build, so building here would produce an image that"
    echo "  fails at runtime with 'exec format error'. Build on a $TARGET_ARCH host"
    echo "  (which the CI runner fleet is)."
    if [ "$REQUIRE_CONTAINER_BUILD" = "true" ]; then
      echo "  REQUIRE_CONTAINER_BUILD=true — treating this as a failure." >&2
      exit 1
    fi
    continue
  fi

  TAR_PATH="$CONTAINERS_DIR/${IMAGE_HASH}.tar"

  echo
  echo "=== $IMAGE_HASH ==="
  echo "  source:   $STAGED_DIR"
  echo "  platform: $PLATFORM"
  echo "  tar:      ${TAR_PATH}.gz"

  # --no-push: we're just producing a tarball, not touching a registry
  # --tarPath: emit docker-archive format for crane/skopeo/docker-load consumption
  # --destination: required even with --no-push, used as the image's
  #                canonical reference inside the tarball
  # --custom-platform: honor the platform from the CDK asset (arm64
  #                    for our Locust container).
  # --cleanup: NOT optional. Kaniko's executor is SINGLE-USE by design -- it
  #            builds by mutating the container's own root filesystem. This loop
  #            runs it once per image in ONE container, and without --cleanup the
  #            second run starts from the first run's leftover filesystem and can
  #            export layers missing files that existed during the build. That is
  #            exactly how attempt 10/11 shipped an app image WITHOUT urllib3
  #            while the in-image import smoke test PASSED (the file existed at
  #            build time, and was lost at layer export). --cleanup purges the
  #            filesystem between runs.
  if [ "$kaniko_mode" = "native" ]; then
    /kaniko/executor \
      --dockerfile="$REPO_ROOT/$STAGED_DIR/Dockerfile" \
      --context="$REPO_ROOT/$STAGED_DIR" \
      --destination="cdk-asset:$IMAGE_HASH" \
      --tarPath="$REPO_ROOT/$TAR_PATH" \
      --custom-platform="$PLATFORM" \
      --cleanup \
      --no-push
  else
    # Docker-wrapped: each docker run is a FRESH container, so the single-use
    # problem does not arise here -- kept flag-identical anyway.
    docker run --rm \
      -v "$REPO_ROOT:/workspace" \
      "$KANIKO_IMAGE" \
      --dockerfile="/workspace/$STAGED_DIR/Dockerfile" \
      --context="/workspace/$STAGED_DIR" \
      --destination="cdk-asset:$IMAGE_HASH" \
      --tarPath="/workspace/$TAR_PATH" \
      --custom-platform="$PLATFORM" \
      --cleanup \
      --no-push
  fi

  # VERIFY THE ARTIFACT THAT SHIPS, not the filesystem that built it. The
  # Dockerfile's import smoke test runs during the build; the urllib3 loss
  # happened AFTER it, at layer export. So the check that matters is against
  # the exported tarball's layers: every ==-pinned package in the context's
  # requirements.txt must appear as a site-packages path inside some layer.
  # tar -tf on each layer is enough -- we need existence, not content.
  REQS="$STAGED_DIR/requirements.txt"
  if [ -f "$REQS" ]; then
    MISSING=""
    for PKG in $(grep -oE '^[A-Za-z0-9_.-]+==' "$REQS" | tr -d '=' ); do
      # pip normalizes dashes to underscores in dist-info names; lowercase and
      # normalize both the pattern and the listing so python-dateutil matches
      # python_dateutil-2.9.0.dist-info.
      PAT=$(echo "$PKG" | tr 'A-Z-' 'a-z_')
      FOUND=no
      for LAYER in $(tar -tf "$TAR_PATH" | grep -E '\.tar(\.gz)?$'); do
        case "$LAYER" in
          *.gz) LIST=$(tar -xOf "$TAR_PATH" "$LAYER" | tar -tz 2>/dev/null) ;;
          *)    LIST=$(tar -xOf "$TAR_PATH" "$LAYER" | tar -t 2>/dev/null) ;;
        esac
        if echo "$LIST" | tr 'A-Z-' 'a-z_' | grep -q "site_packages/$PAT"; then
          FOUND=yes; break
        fi
      done
      if [ "$FOUND" = no ]; then MISSING="$MISSING $PKG"; fi
    done
    if [ -n "$MISSING" ]; then
      echo "ERROR: exported image $IMAGE_HASH is MISSING pinned package(s):$MISSING" >&2
      echo "  The build filesystem had them (or pip would have failed); the layer" >&2
      echo "  export lost them. This is the kaniko single-use/export defect that" >&2
      echo "  shipped an app image without urllib3 on 2026-08-26. Failing loudly." >&2
      exit 1
    fi
    echo "  verified: all $(grep -cE '^[A-Za-z0-9_.-]+==' "$REQS") pinned packages present in exported layers"
  fi

  # Kaniko emits an uncompressed tar; compress to match the .tar.gz
  # convention the manifest advertises.
  gzip -f "$TAR_PATH"
done < "$CONTAINER_PLAN_FILE"

echo
echo "Built $COUNT image(s)."
