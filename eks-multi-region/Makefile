# eks-multi-region -- operator + CI entry points.
#
# The deploy rail itself lives in projen tasks (.projen/tasks.json, generated from
# .projenrc.ts + projenrc/tasks/). This Makefile is a thin, discoverable front on those
# tasks so `make deploy` works the way it does in the sibling samples. It adds NOTHING the
# rail does not already do; every target below shells out to `yarn <task>` or a script in
# build/.
#
# Required environment (no defaults are baked in -- see .projenrc.ts):
#   AWS_REGION            primary region (us-east-2 for the shipped topology)
#   ASSETS_BUCKET_PREFIX  prefix of the per-region assets buckets, e.g. eks-multi-region.
#                         The buckets are named $ASSETS_BUCKET_PREFIX-<region>.
# Credentials come from the ambient AWS CLI configuration (a profile, SSO, or OIDC in CI).
#
# Typical first deploy, from a machine with internet access and ECR push rights:
#   make buckets      # once per account: the two assets buckets
#   make mirror       # once per account: pinned third-party images -> your private ECR
#   make deploy       # the rail: ~90 minutes, 12 stacks across 3 regions
#   make verify       # every stack in a *_COMPLETE state
#   build/tunnel.sh <aws-profile>            # Argo UI + cockpit via the observer bastion
#   make clean        # tear everything down (cleanup.sh)

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

REGIONS ?= us-east-2 us-west-2

.PHONY: help check-env deps build buckets mirror deploy verify tunnel clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

check-env:
	@: "$${AWS_REGION:?AWS_REGION is required (primary region, e.g. us-east-2)}"
	@: "$${ASSETS_BUCKET_PREFIX:?ASSETS_BUCKET_PREFIX is required (e.g. eks-multi-region)}"

deps: ## Install Node dependencies (yarn berry via corepack)
	corepack enable && yarn install --immutable

build: deps ## Compile, synth, cfn-lint the templates, run all tests, stage assets
	CFN_LINT_REQUIRED=$${CFN_LINT_REQUIRED:-0} yarn ci:build:cdk

buckets: check-env ## Create the per-region assets buckets (idempotent)
	@for r in $(REGIONS); do \
	  b="$$ASSETS_BUCKET_PREFIX-$$r"; \
	  if aws s3api head-bucket --bucket "$$b" --region "$$r" 2>/dev/null; then \
	    echo "bucket $$b exists"; \
	  elif [ "$$r" = "us-east-1" ]; then \
	    aws s3api create-bucket --bucket "$$b" --region "$$r"; \
	  else \
	    aws s3api create-bucket --bucket "$$b" --region "$$r" \
	      --create-bucket-configuration LocationConstraint="$$r"; \
	  fi; \
	  aws s3api put-public-access-block --bucket "$$b" --region "$$r" \
	    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true; \
	done

mirror: check-env ## Mirror the pinned third-party images (src/mirror/images.json) into YOUR private ECR
	MIRROR_REGIONS="$(REGIONS)" yarn deploy:mirror

deploy: check-env build ## Run the full deploy rail (12 stacks, 3 regions, ~90 min)
	yarn deploy

verify: check-env ## Every stack the rail deploys must be in a *_COMPLETE state
	bash build/verify-stacks.sh

tunnel: ## Port-forward to a region's internal ALB via the observer bastion: make tunnel PROFILE=<p> [PORT=8080] [TARGET=us-east-2]
	bash build/tunnel.sh "$${PROFILE:?PROFILE=<aws-profile> is required}" "$${PORT:-8080}" "$${TARGET:-us-east-2}"

clean: check-env ## Tear down every stack, then the mirror ECR repos and assets buckets
	bash cleanup.sh
