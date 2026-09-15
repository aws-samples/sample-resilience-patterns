# Generic Locust base container for the LoadGenerator construct (changeset §3b).
#
# NO `--platform` here on purpose: the platform is set by the DockerImageAsset
# (kaniko `--custom-platform` in CI, `docker build --platform` via cdk-assets on
# GitHub), both derived from the construct's single `architecture` prop. Pinning it in
# the Dockerfile would let the image and the Fargate runtimePlatform drift.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Copy the whole build context so a demo overlay (extra .py modules + its own
# locustfile.py) rides along unchanged (changeset §3d).
COPY . .
EXPOSE 8089
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
