# Demo application image.
#
# BUILD 2026-08-27: this comment is a DELIBERATE cache-bust, not noise. The kaniko
# --cleanup fix lives in build/build-docker.sh, which is OUTSIDE this build context,
# so without a context change the CDK asset hash -- and the image TAG -- would not
# move. The pods run imagePullPolicy: IfNotPresent, so a same-tag push leaves every
# node serving its cached copy of the broken image. Changing this file changes the
# hash, the tag, and forces a real pull.
#
# No apt packages and no build toolchain: both Python dependencies (pg8000, boto3) are
# pure Python, so there is nothing to compile. That is what keeps this image buildable by
# kaniko on the CI runner without a Docker daemon.
#
# ARCHITECTURE. This image is built on the arm64 CI runner fleet and MUST run on arm64
# nodes. kaniko cannot cross-build: its --custom-platform flag only rewrites the platform
# recorded in the image config, it does not change what the build actually produces
# (GoogleContainerTools/kaniko#1587, #2127). An image built here and labelled linux/amd64
# would still contain arm64 binaries and would fail on an x86_64 node with
# `exec format error` — a CrashLoopBackOff with no clue as to why. The CDK asset declares
# Platform.LINUX_ARM64 and the node group uses AL2023_ARM_64_STANDARD on Graviton so all
# three agree.
#
# BASE PINNED BY DIGEST. The region stacks name this image by fingerprinting src/app, so it is
# rebuilt only when a file here changes. With a bare tag the base was whatever python:3.12-slim
# pointed at on the day of the last source change: base-image security fixes never arrived on
# their own, and two builds of one commit could differ. With the digest, a base bump is this one
# reviewed line, and because the line is in the fingerprint the next deploy rebuilds the image
# and rolls the pods. The tag stays for readers; the digest is what resolves. To re-pin, take
# the multi-platform index digest (kaniko selects linux/arm64 from it):
#   crane digest index.docker.io/library/python:3.12-slim
# Resolved 2026-10-06; its linux/arm64 child is
# sha256:16bf2b5c59a08523519d3c8589deca849285dee1d62a3653e124c3dba340f15e.
FROM python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first so the layer caches independently of application edits.
COPY requirements.txt ./
# Plain install, no hash flag: --require-hashes is a BOOLEAN pip flag (on only) and
# `--require-hashes=false` is a syntax error pip rejects with exit 2 — which failed the
# FIRST-EVER execution of this line, in CI kaniko, because container builds never run in
# the local `npx projen build` gate. Requirements are exact-pinned but unhashed; not
# requiring hashes is pip's default, expressed by omitting the flag.
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY common.py server.py schema.py error_rate.py ./

# IMPORT SMOKE TEST — prove the ENTIRE runtime import graph at build time.
#
# The attempt-10 image reached both clusters missing urllib3: botocore requires it
# unconditionally and s3transfer WAS present, a state no single pip run can produce
# (most plausibly the kaniko snapshotter dropping files between layers). The pods then
# crashed at import — at runtime, in both regions, 81 restarts — while every build and
# deploy stayed green. This line moves that failure to the build, where it is loud.
#
# The env values are fakes: common.py reads them at module scope and creates a boto3
# client, but nothing makes a network call at import.
RUN AWS_REGION=smoke DB_SECRET_NAME=smoke DB_READ_HOST=smoke DB_WRITE_HOST=smoke \
    ERROR_RATE_PARAM=smoke python -c "import server, schema"

# Run unprivileged. The pod also sets runAsNonRoot, and the two must agree or the
# kubelet refuses to start the container.
RUN useradd --create-home --uid 10001 appuser
USER 10001

EXPOSE 8080

CMD ["python", "server.py"]
