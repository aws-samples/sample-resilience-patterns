# drs-ec2 -- Amazon EC2 disaster recovery with AWS Elastic Disaster Recovery (AWS DRS), Amazon Aurora
# Global Database and an Amazon Application Recovery Controller (ARC) Region switch plan, three regions.
#
#   make deploy            # all stacks (3 regions), app code, DRS agent + launch template, wait for CONTINUOUS (~60 min)
#   make status            # resting-state check (writer, ARC health checks + evaluation, DRS, targets)
#   make rehearse          # one graceful round trip (MODE=ungraceful for a forced Aurora failover out)
#   make rehearse-cycle    # LEGS=N alternating legs; resting-state invariant asserted after each fail-back
#   make tunnel            # http://localhost:8080/ui through the observer bastion (SSM port-forward)
#   make clean             # delete all stacks and DRS resources in all three regions, unattended (./cleanup.sh)
#
# Credentials: PROFILE=<name>, else $AWS_PROFILE, else the CLI's default identity. Every target
# prints the account it is about to act on; set ACCOUNT=<12 digits> to refuse any other account.
# Knobs: STATEFUL_EC2=true (stateful fail-back path), DEMO_CLIENT_CIDR, OBSERVER_REGION.
#
# Structure note: GNU make expands $(shell ...) for a whole recipe before its first line runs, so a
# stack's outputs can only be read in a LATER target than the one that deploys it. Hence one target
# per deploy step, chained as prerequisites, exactly like the aurora pattern.

SHELL := /bin/bash
.SHELLFLAGS := -eo pipefail -c
.DEFAULT_GOAL := help

PROJECT          ?= drsdemo
PRIMARY_REGION   ?= us-east-2
SECONDARY_REGION ?= us-west-2
OBSERVER_REGION  ?= us-east-1
STATEFUL_EC2     ?= false
MODE             ?= graceful
LEGS             ?= 4
LOCAL_PORT       ?= 8080
PROFILE          ?= $(AWS_PROFILE)
ACCOUNT          ?=

export AWS_PAGER :=
export PROJECT PRIMARY_REGION SECONDARY_REGION OBSERVER_REGION STATEFUL_EC2
PROFILE_FLAG := $(if $(PROFILE),--profile $(PROFILE),)
PROFILE_ARG  := $(or $(PROFILE),-)
AWS  := aws $(PROFILE_FLAG)
CDK  := npx cdk $(PROFILE_FLAG) --require-approval never
ACCOUNT_ID = $(shell $(AWS) sts get-caller-identity --query Account --output text 2>/dev/null)
APP_BUCKET = $(PROJECT)-app-code-$(ACCOUNT_ID)-$(PRIMARY_REGION)
CTX  = -c project=$(PROJECT) -c primaryRegion=$(PRIMARY_REGION) -c secondaryRegion=$(SECONDARY_REGION) \
       -c observerRegion=$(OBSERVER_REGION) -c accountId=$(ACCOUNT_ID) -c statefulEc2=$(STATEFUL_EC2)
comma := ,

# so <region> <stack-suffix> <OutputKey> -> value (read at recipe-expansion time of the CALLING target)
so = $(shell $(AWS) cloudformation describe-stacks --region $(1) --stack-name $(PROJECT)-$(2) \
       --query "Stacks[0].Outputs[?OutputKey=='$(3)'].OutputValue" --output text 2>/dev/null)
# deploy <stack-suffix> <extra context>
define deploy
	$(CDK) deploy $(PROJECT)-$(1) $(CTX) -c stack=$(1) $(2) -o cdk.out.$(1)
endef

# Frequently re-read outputs
PRI_VPC   = $(call so,$(PRIMARY_REGION),net-primary,VpcId)
SEC_VPC   = $(call so,$(SECONDARY_REGION),net-secondary,VpcId)
PRI_SUBS  = $(call so,$(PRIMARY_REGION),net-primary,PrivateSubnets)
SEC_SUBS  = $(call so,$(SECONDARY_REGION),net-secondary,PrivateSubnets)
PCX       = $(call so,$(PRIMARY_REGION),net-primary,PeeringConnectionId)
HZ_ID     = $(call so,$(PRIMARY_REGION),app-primary,HostedZoneId)
OBS_VPC   = $(call so,$(OBSERVER_REGION),observer,VpcId)
OBS_CIDR  = $(call so,$(OBSERVER_REGION),observer,VpcCidr)
PCX_OBS_P = $(call so,$(OBSERVER_REGION),observer,PeeringToPrimaryId)
PCX_OBS_S = $(call so,$(OBSERVER_REGION),observer,PeeringToSecondaryId)
PLAN_ARN  = $(call so,$(PRIMARY_REGION),plan,SwitchoverPlanArn)
HC_PRI    = $(shell $(AWS) arc-region-switch list-route53-health-checks --region $(PRIMARY_REGION) --arn $(PLAN_ARN) --query "healthChecks[?region=='$(PRIMARY_REGION)'].healthCheckId|[0]" --output text 2>/dev/null)
HC_SEC    = $(shell $(AWS) arc-region-switch list-route53-health-checks --region $(PRIMARY_REGION) --arn $(PLAN_ARN) --query "healthChecks[?region=='$(SECONDARY_REGION)'].healthCheckId|[0]" --output text 2>/dev/null)
CLIENT_CIDR = $(or $(DEMO_CLIENT_CIDR),$(OBS_CIDR))

APP_CTX = -c primaryVpcId=$(PRI_VPC) -c primaryPrivateSubnetIds=$(PRI_SUBS) \
  -c primaryWriterEndpoint=$(call so,$(PRIMARY_REGION),db-primary,PrimaryWriterEndpoint) \
  -c appInstanceRoleArn=$(call so,$(PRIMARY_REGION),iam,AppInstanceRoleArn) -c appCodeBucket=$(APP_BUCKET)
ALB_CTX = -c secondaryVpcId=$(SEC_VPC) -c secondaryPrivateSubnetIds=$(SEC_SUBS) -c hostedZoneId=$(HZ_ID)
DRS_CTX = -c primaryTargetGroupArn=$(call so,$(PRIMARY_REGION),app-primary,PrimaryTargetGroupArn) \
  -c secondaryTargetGroupArn=$(call so,$(SECONDARY_REGION),alb-secondary,SecondaryTargetGroupArn) \
  -c appInstanceProfileArn=$(call so,$(PRIMARY_REGION),iam,AppInstanceProfileArn) \
  -c appInstanceRoleArn=$(call so,$(PRIMARY_REGION),iam,AppInstanceRoleArn) \
  -c secondaryWriterEndpoint=$(call so,$(SECONDARY_REGION),db-secondary,SecondaryWriterEndpoint) \
  -c primaryPrivateSubnetIds=$(PRI_SUBS) -c primaryAppSgId=$(call so,$(PRIMARY_REGION),app-primary,AppSecurityGroupId) \
  -c secondaryStagingSubnetId=$(firstword $(subst $(comma), ,$(SEC_SUBS))) \
  -c secondaryRecoveredAppSgId=$(call so,$(SECONDARY_REGION),alb-secondary,RecoveredAppSecurityGroupId)

.PHONY: help check-account lint test synth deploy stacks app-code drs-setup status rehearse rehearse-cycle rehearse-ungraceful tunnel clean \
        net-1 net-2 net-2b iam db-primary db-secondary app-primary alb-secondary drs-steps plan observer observer-accept net-3 app-final accept-peering

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

check-account:
	@ACCT=$$($(AWS) sts get-caller-identity --query Account --output text 2>/dev/null) \
	  || { echo "no valid AWS credentials (PROFILE=$(PROFILE)); refresh them and retry"; exit 1; }; \
	if [ -n "$(ACCOUNT)" ] && [ "$$ACCT" != "$(ACCOUNT)" ]; then echo "credentials resolve to $$ACCT but ACCOUNT=$(ACCOUNT) is pinned; refusing"; exit 1; fi; \
	echo "account: $$ACCT (profile: $(or $(PROFILE),default credential chain))"

lint: ## cdk-nag synth + Lambda lint + script syntax
	@npx cdk synth --all -c nag=true -c accountId=000000000000 --quiet >/dev/null && echo "cdk-nag: ok"
	@cd lambda && (command -v ruff >/dev/null && ruff check . || python3 -m ruff check .)
	@bash -n scripts/*.sh cleanup.sh && echo "scripts: ok"

test: ## CDK assertion tests + Lambda unit tests
	@npx projen test
	@cd lambda && python3 -m pytest -q

synth: ## Synthesize every stack with placeholder context (CI build)
	@npx cdk synth --all -c accountId=000000000000 --quiet && ls cdk.out/*.template.json | xargs -n1 basename

# ---------------------------------------------------------------------------------------------
# deploy -- deployment order, one target per step so each can read the previous step's outputs
# ---------------------------------------------------------------------------------------------
deploy: check-account stacks app-code drs-setup status ## Deploy all 11 stacks (3 regions), upload app code, set up DRS, run the resting-state check (~60 min)

stacks: net-1 net-2 iam db-primary db-secondary app-primary alb-secondary drs-steps plan observer net-3 app-final ## Deploy the 11 stacks in dependency order (~50 min from an empty account)
	@echo "observer bastion: $(call so,$(OBSERVER_REGION),observer,BastionInstanceId) in $(OBSERVER_REGION) -- make tunnel"

net-1:  ## 1. both VPCs
	$(call deploy,net-primary)
	$(call deploy,net-secondary)
net-2:  ## 2. peering: primary requests, CLI accepts, secondary routes back
	$(call deploy,net-primary,-c secondaryVpcId=$(SEC_VPC))
	$(MAKE) net-2b   # separate expansion: PCX exists only after the line above
net-2b:
	$(MAKE) accept-peering REGION=$(SECONDARY_REGION) PCX_ID=$(PCX)
	$(call deploy,net-secondary,-c primaryVpcId=$(PRI_VPC) -c peeringConnectionId=$(PCX))
iam:    ## 3. app instance role/profile
	$(call deploy,iam)
db-primary: ## 4a. Aurora Global + primary cluster
	$(call deploy,db-primary,-c primaryVpcId=$(PRI_VPC) -c primaryPrivateSubnetIds=$(PRI_SUBS))
db-secondary: ## 4b. secondary cluster joins
	$(call deploy,db-secondary,-c secondaryVpcId=$(SEC_VPC) -c secondaryPrivateSubnetIds=$(SEC_SUBS))
app-primary: app-code ## 5. private zone, internal ALB, protected EC2
	$(call deploy,app-primary,$(APP_CTX))
alb-secondary: ## 6. internal ALB + empty TG in the secondary
	$(call deploy,alb-secondary,$(ALB_CTX))
drs-steps: ## 7. DRS step functions in BOTH regions
	$(call deploy,drs-steps-primary,$(DRS_CTX))
	$(call deploy,drs-steps-secondary,$(DRS_CTX))
plan:   ## 8. the ARC Region Switch plan
	$(call deploy,plan,$(DRS_CTX) -c primaryClusterArn=$(call so,$(PRIMARY_REGION),db-primary,PrimaryClusterArn) \
	  -c secondaryClusterArn=$(call so,$(SECONDARY_REGION),db-secondary,SecondaryClusterArn) -c hostedZoneId=$(HZ_ID))
observer: ## 9. observer VPC + bastion (third region); accept its peerings
	$(call deploy,observer,-c primaryVpcId=$(PRI_VPC) -c secondaryVpcId=$(SEC_VPC))
	$(MAKE) observer-accept   # separate expansion: peering ids exist only after the line above
observer-accept:
	$(MAKE) accept-peering REGION=$(PRIMARY_REGION)   PCX_ID=$(PCX_OBS_P)
	$(MAKE) accept-peering REGION=$(SECONDARY_REGION) PCX_ID=$(PCX_OBS_S)
net-3:  ## 9b. return routes to the observer
	$(call deploy,net-primary,-c secondaryVpcId=$(SEC_VPC) -c observerCidr=$(OBS_CIDR) -c observerPeeringId=$(PCX_OBS_P))
	$(call deploy,net-secondary,-c primaryVpcId=$(PRI_VPC) -c peeringConnectionId=$(PCX) -c observerCidr=$(OBS_CIDR) -c observerPeeringId=$(PCX_OBS_S))
app-final: ## 10. bind ARC health checks, associate the zone with all VPCs, open ALBs to the observer
	$(call deploy,app-primary,$(APP_CTX) -c arcHealthCheckId=$(HC_PRI) -c secondaryVpcId=$(SEC_VPC) -c observerVpcId=$(OBS_VPC) -c demoClientCidr=$(CLIENT_CIDR))
	$(call deploy,alb-secondary,$(ALB_CTX) -c arcHealthCheckId=$(HC_SEC) -c demoClientCidr=$(CLIENT_CIDR))

accept-peering:  # internal: REGION= PCX_ID=
	@[ -n "$(PCX_ID)" ] && $(AWS) ec2 accept-vpc-peering-connection --region $(REGION) --vpc-peering-connection-id $(PCX_ID) >/dev/null || true

app-code: check-account ## Upload app/app.py + app/ui.html; refresh a running instance in place (no replacement)
	@scripts/app-code.sh $(PROFILE_ARG) $(APP_BUCKET)

drs-setup: check-account ## Initialize DRS in both regions, configure templates, install the agent via SSM, tag the source server, wait for CONTINUOUS (~12 min)
	@scripts/drs-setup.sh $(PROFILE_ARG)

status: check-account ## Resting-state check
	@scripts/status.sh $(PROFILE_ARG)

rehearse: check-account ## One graceful round trip via the plan (MODE=ungraceful for a forced Aurora failover on the way out)
	@if [ "$(origin LEGS)" = "command line" ]; then echo "error: 'rehearse' is a fixed 2-leg round trip. Use: make rehearse-cycle LEGS=$(LEGS)"; exit 2; fi
	@scripts/rehearse-switchover.sh $(PROFILE_ARG) $(MODE)

rehearse-ungraceful: ## Shortcut for MODE=ungraceful
	@$(MAKE) rehearse MODE=ungraceful PROFILE="$(PROFILE)"

rehearse-cycle: check-account ## N alternating legs (LEGS=4); invariant asserted after every fail-back; stateful mode round-trips a disk marker
	@scripts/rehearse-cycle.sh $(PROFILE_ARG) $(LEGS) $(MODE)

tunnel: check-account ## SSM port-forward: http://localhost:$(LOCAL_PORT)/ui via the observer bastion
	@scripts/tunnel.sh $(PROFILE_ARG) $(LOCAL_PORT)

clean: check-account ## Delete all stacks, DRS resources and the app-code bucket in all three regions (unattended, ~30 min)
	@./cleanup.sh $(PROFILE_ARG)
