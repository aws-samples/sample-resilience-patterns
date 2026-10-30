# regional-affinity -- each customer has a home Region for its reads and writes in an Amazon DynamoDB
# global table; a router sends region-less requests to the home Region's name; one Amazon Application
# Recovery Controller (ARC) Region switch plan drains or restores a Region at all three levels of an
# Amazon Route 53 private hosted zone.
#
#   make deploy                    # 5 stacks in 2 Regions, 300 customers, ARC health checks bound (~13 min)
#   make status                    # ARC health checks, DNS answers and sample requests, from inside a VPC
#   make call CUSTOMER=cust-001    # read, write and read one customer's item via the region-less name
#   make drain REGION=us-east-1    # run the plan's deactivate workflow for a Region (~2 min)
#   make restore REGION=us-east-1  # run the plan's activate workflow for a Region (~2 min)
#   make rehearse                  # drain and restore each Region in turn and assert the outcome (~11 min)
#   make clean                     # delete every stack in both Regions, unattended (./cleanup.sh, ~25 min)
#
# Credentials: PROFILE=<name>, else $AWS_PROFILE, else the CLI's default identity. Every target
# that deploys or operates checks the account it is about to act on and prints it; set
# ACCOUNT=<12 digits> to refuse any other account. The deploy steps and clean do it here, in
# check-account. status, call, drain, restore and rehearse leave it to scripts/demo.py (see "operate").
# Knobs: PROJECT, REGIONS (two, comma-separated), DOMAIN, APP_LABEL, FROM=<region> (status, call, drain,
# restore). REGION=<region> (drain, restore) is read from the command line only, never from the environment.
#
# Structure note: GNU make expands $(shell ...) for a whole recipe before its first line runs, so a
# stack's outputs can be read only in a LATER target than the one that deploys it. Hence one target
# per deploy step, chained as prerequisites, as in the drs-ec2 pattern. The steps must run in order,
# one at a time, so the whole file is serial even under make -j.

SHELL := /bin/bash
.SHELLFLAGS := -eo pipefail -c
.DEFAULT_GOAL := help
.NOTPARALLEL:

PROJECT   ?= regional-affinity
REGIONS   ?= us-east-1,us-east-2
DOMAIN    ?= example.com
APP_LABEL ?= ingest
PROFILE   ?= $(AWS_PROFILE)
ACCOUNT   ?=
CUSTOMER  ?= cust-001
REGION    ?=
FROM      ?=

comma := ,
R1 := $(word 1,$(subst $(comma), ,$(REGIONS)))
R2 := $(word 2,$(subst $(comma), ,$(REGIONS)))

export AWS_PAGER :=
PROFILE_FLAG := $(if $(PROFILE),--profile $(PROFILE),)
AWS  := aws $(PROFILE_FLAG)
CDK  := npx cdk $(PROFILE_FLAG) --require-approval never
CTX  := -c project=$(PROJECT) -c regions=$(REGIONS) -c domain=$(DOMAIN) -c appLabel=$(APP_LABEL)
# The settings go on the command line, not only through export: before GNU make 4.4, $(shell ...)
# does not see exported variables, and the records target calls the script inside $(shell ...).
DEMO := env PROJECT=$(PROJECT) REGIONS=$(REGIONS) DOMAIN=$(DOMAIN) APP_LABEL=$(APP_LABEL) \
        PROFILE=$(PROFILE) ACCOUNT=$(ACCOUNT) python3 scripts/demo.py

# so <region> <stack-suffix> <OutputKey> -> the output's value (read at recipe-expansion time of the
# CALLING target). Empty when the stack does not exist yet (the first deploy) or has no such output
# (a stack that rolled back has none, and the CLI prints "None" for it). Any other failure (no
# permission, expired credentials, throttling) stops make with the reason: an empty value would
# synthesize the Region stacks without their peering and a re-deploy would remove it.
# The CLI's stderr goes to a file, so a warning it prints on success cannot end up in the value.
so-query = $(AWS) cloudformation describe-stacks --region $(1) --stack-name $(PROJECT)-$(2) \
             --query "Stacks[0].Outputs[?OutputKey=='$(3)'].OutputValue" --output text
so-value = $(if $(findstring cannot read the outputs of,$(1)),$(error $(1)),$(filter-out None,$(1)))
so = $(call so-value,$(shell err=$$(mktemp "$${TMPDIR:-/tmp}/so.XXXXXX"); \
       $(call so-query,$(1),$(2),$(3)) 2>"$$err" \
       || { grep -q 'does not exist' "$$err" || echo "cannot read the outputs of $(PROJECT)-$(2) in $(1): $$(cat "$$err")"; }; \
       rm -f "$$err"))
# deploy <stack-suffix> <extra context>
define deploy
	$(CDK) deploy $(PROJECT)-$(1) $(CTX) -c stack=$(1) $(2) -o cdk.out.$(1)
endef

VPC1 = $(call so,$(R1),region-$(R1),VpcId)
VPC2 = $(call so,$(R2),region-$(R2),VpcId)
PCX  = $(call so,$(R1),region-$(R1),PeeringConnectionId)

.PHONY: help check-account lint test synth deploy base seed peering peering-return plan health-checks records verify \
        status call drain restore rehearse clean

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

check-account:
	@ACCT=$$($(AWS) sts get-caller-identity --query Account --output text 2>/dev/null) \
	  || { echo "no valid AWS credentials (PROFILE=$(PROFILE)); refresh them and retry"; exit 1; }; \
	if [ -n "$(ACCOUNT)" ] && [ "$$ACCT" != "$(ACCOUNT)" ]; then echo "credentials resolve to $$ACCT but ACCOUNT=$(ACCOUNT) is pinned; refusing"; exit 1; fi; \
	echo "account: $$ACCT (profile: $(or $(PROFILE),default credential chain)), project: $(PROJECT), Regions: $(R1) $(R2)"

lint: ## cdk-nag synth + Python lint + script syntax
	@npx cdk synth -c nag=true --quiet >/dev/null && echo "cdk-nag: ok"
	@ruff check . && echo "ruff: ok"
	@bash -n cleanup.sh && echo "scripts: ok"

test: ## CDK assertion tests + Python unit tests (no AWS access needed)
	@npx projen test
	@python3 -m pytest -q

synth: ## Synthesize every stack with placeholder context (CI build)
	@npx cdk synth --quiet && ls cdk.out/*.template.json | xargs -n1 basename

# ---------------------------------------------------------------------------------------------
# deploy -- one target per step, so each can read the outputs of the steps before it
# ---------------------------------------------------------------------------------------------
deploy: check-account base seed peering peering-return plan health-checks records verify ## Deploy everything, seed the customers, bind and verify the ARC health checks (~13 min from empty)
	@echo "deployed. next: make status"

# Each step can be run alone to resume a failed deploy, so each one checks the account itself.
# Make builds a prerequisite once per invocation: make deploy prints the account line once.
base seed peering peering-return plan health-checks records verify: check-account

# On a re-deploy both values exist, so the peering survives; on the first deploy both are empty.
base: ## 1. both Region stacks and the global table, in parallel
	$(CDK) deploy --all --concurrency 3 $(CTX) -c stack=base -c peerVpcId=$(VPC2) -c peeringConnectionId=$(PCX) -o cdk.out.base
seed: ## 2. write the 300 customer profiles and check that the table replicates
	@$(DEMO) seed
peering: ## 3. the first Region requests the peering connection (CloudFormation accepts it: one account)
	$(call deploy,region-$(R1),-c peerVpcId=$(VPC2))
peering-return: ## 4. the second Region routes back over the connection
	$(call deploy,region-$(R2),-c peeringConnectionId=$(PCX))
plan: ## 5. the private hosted zone (both VPCs) and the Region switch plan
	$(call deploy,plan,-c vpcIds=$(VPC1)$(comma)$(VPC2))
health-checks: ## 6. wait for the six health checks the plan vends (one per Region per record name)
	@$(DEMO) health-checks
records: ## 7. the three levels of records, each bound to its ARC health check
	$(call deploy,records,-c hostedZoneId=$(call so,$(R1),plan,HostedZoneId) \
	  -c albDnsNames=$(call so,$(R1),region-$(R1),AlbDnsName)$(comma)$(call so,$(R2),region-$(R2),AlbDnsName) \
	  -c albHostedZoneIds=$(call so,$(R1),region-$(R1),AlbHostedZoneId)$(comma)$(call so,$(R2),region-$(R2),AlbHostedZoneId) \
	  -c healthChecks='$(shell $(DEMO) health-checks --json)')
verify: ## 8. every record carries the right health check; the plan evaluates without warnings
	@$(DEMO) verify

# ---------------------------------------------------------------------------------------------
# operate
#
# status, call, drain, restore and rehearse do not depend on check-account. scripts/demo.py checks
# the account itself before any other call (ACCOUNT reaches it through $(DEMO)), with an STS call in
# the Region the command acts in: for drain the Region that stays, for restore the Region it restores,
# for status and call the Region they query from. check-account would call STS first with no Region,
# which goes to the profile's default Region or the global endpoint, and in a Regional impairment that
# can be the very Region a drain is about to take out of service.
# ---------------------------------------------------------------------------------------------
status: ## ARC health checks, DNS answers and sample requests (from the second Region's VPC; FROM= for the first)
	@$(DEMO) status $(if $(FROM),--from $(FROM))

call: ## Read, write and read one customer's item via the region-less name (CUSTOMER=cust-001, FROM=)
	@$(DEMO) call $(CUSTOMER) $(if $(FROM),--from $(FROM))

# REGION must be typed on the command line: a REGION left exported in the shell (make's ?= accepts the
# environment) must not pick the Region to drain.
drain: ## Run the plan's deactivate workflow for REGION (FROM=<region> picks the VPC the checks run from)
	@$(if $(and $(REGION),$(findstring command line,$(origin REGION))),,echo "pass REGION on the command line, for example: make drain REGION=$(R1) (an exported REGION is ignored)"; exit 2)
	@$(DEMO) drain $(REGION) $(if $(FROM),--from $(FROM))

restore: ## Run the plan's activate workflow for REGION (FROM=<region> picks the VPC the checks run from)
	@$(if $(and $(REGION),$(findstring command line,$(origin REGION))),,echo "pass REGION on the command line, for example: make restore REGION=$(R1) (an exported REGION is ignored)"; exit 2)
	@$(DEMO) restore $(REGION) $(if $(FROM),--from $(FROM))

rehearse: ## Drain and restore each Region in turn; assert DNS, where every request lands and the data (~11 min)
	@$(DEMO) rehearse

# clean runs cleanup.sh, which makes no scripts/demo.py call, so it keeps the check here.
clean: check-account ## Delete every stack in both Regions, unattended (./cleanup.sh, ~25 min)
	@PROJECT=$(PROJECT) REGIONS=$(REGIONS) ./cleanup.sh $(or $(PROFILE),-)
