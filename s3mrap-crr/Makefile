PROJECT ?= s3mrap
PRIMARY_REGION ?= us-east-1
SECONDARY_REGION ?= us-west-2
ACCOUNT_ID ?= $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "UNKNOWN")

CDK = npx cdk
CDK_CONTEXT = -c project=$(PROJECT) -c primaryRegion=$(PRIMARY_REGION) -c secondaryRegion=$(SECONDARY_REGION) -c accountId=$(ACCOUNT_ID)

.PHONY: help
help:
	@echo "Targets:"
	@echo "  bootstrap       - Deploy CodeBuild stack, upload source, and trigger build"
	@echo "  deploy          - Deploy all stacks in order (run from CodeBuild)"
	@echo "  deploy-buckets  - Deploy S3 buckets in both regions"
	@echo "  deploy-routing  - Deploy MRAP + CRR"
	@echo "  deploy-failover - Deploy ARC plan + routing Lambda + load test"
	@echo "  deploy-monitoring - Deploy CloudWatch alarms + dashboards"
	@echo "  cdk-bootstrap   - Bootstrap CDK in both regions"
	@echo "  synth           - Synthesize all stacks"
	@echo "  clean           - Destroy all stacks"

.PHONY: cdk-bootstrap
cdk-bootstrap:
	$(CDK) bootstrap aws://$(ACCOUNT_ID)/$(PRIMARY_REGION)
	$(CDK) bootstrap aws://$(ACCOUNT_ID)/$(SECONDARY_REGION)

.PHONY: synth
synth:
	$(CDK) synth $(CDK_CONTEXT)

.PHONY: bootstrap
bootstrap:
	rm -rf cdk.out cdk.out.*
	$(CDK) deploy $(PROJECT)-bootstrap $(CDK_CONTEXT) --require-approval never

.PHONY: deploy-buckets
deploy-buckets:
	$(CDK) deploy $(PROJECT)-bucket-primary $(CDK_CONTEXT) -c stack=bucket-primary --require-approval never -o cdk.out.bp & p1=$$!; \
	$(CDK) deploy $(PROJECT)-bucket-secondary $(CDK_CONTEXT) -c stack=bucket-secondary --require-approval never -o cdk.out.bs & p2=$$!; \
	wait $$p1 && wait $$p2

.PHONY: deploy-routing
deploy-routing:
	$(CDK) deploy $(PROJECT)-global-routing $(CDK_CONTEXT) -c stack=global-routing --require-approval never
	$(eval MRAP_ALIAS := $(shell aws cloudformation describe-stacks --stack-name $(PROJECT)-global-routing --region $(PRIMARY_REGION) --query "Stacks[0].Outputs[?OutputKey=='MrapAlias'].OutputValue" --output text))

.PHONY: deploy-routing-lambdas
deploy-routing-lambdas:
	$(CDK) deploy $(PROJECT)-routing-primary $(CDK_CONTEXT) -c stack=routing-primary -c mrapAlias=$(MRAP_ALIAS) --require-approval never -o cdk.out.rp & p1=$$!; \
	$(CDK) deploy $(PROJECT)-routing-secondary $(CDK_CONTEXT) -c stack=routing-secondary -c mrapAlias=$(MRAP_ALIAS) --require-approval never -o cdk.out.rs & p2=$$!; \
	wait $$p1 && wait $$p2

.PHONY: deploy-failover
deploy-failover:
	$(CDK) deploy $(PROJECT)-failover $(CDK_CONTEXT) -c stack=failover --require-approval never

.PHONY: deploy-monitoring
deploy-monitoring:
	$(CDK) deploy $(PROJECT)-monitoring-primary $(CDK_CONTEXT) -c stack=monitoring-primary --require-approval never &
	$(CDK) deploy $(PROJECT)-monitoring-secondary $(CDK_CONTEXT) -c stack=monitoring-secondary --require-approval never &
	wait

.PHONY: deploy
deploy: deploy-buckets deploy-routing deploy-routing-lambdas deploy-failover-and-monitoring
	@echo "OK: All stacks deployed"

.PHONY: deploy-failover-and-monitoring
deploy-failover-and-monitoring:
	$(CDK) deploy $(PROJECT)-failover $(CDK_CONTEXT) -c stack=failover --require-approval never -o cdk.out.fo & p1=$$!; \
	$(CDK) deploy $(PROJECT)-monitoring-primary $(CDK_CONTEXT) -c stack=monitoring-primary -c mrapAlias=$(MRAP_ALIAS) --require-approval never -o cdk.out.mp & p2=$$!; \
	$(CDK) deploy $(PROJECT)-monitoring-secondary $(CDK_CONTEXT) -c stack=monitoring-secondary -c mrapAlias=$(MRAP_ALIAS) --require-approval never -o cdk.out.ms & p3=$$!; \
	wait $$p1 && wait $$p2 && wait $$p3

.PHONY: clean
clean:
	@# Delete any stacks stuck in ROLLBACK_COMPLETE first
	@for stack in $(PROJECT)-failover $(PROJECT)-routing-secondary $(PROJECT)-routing-primary $(PROJECT)-monitoring-secondary $(PROJECT)-monitoring-primary $(PROJECT)-global-routing $(PROJECT)-bucket-secondary $(PROJECT)-bucket-primary; do \
		status=$$(aws cloudformation describe-stacks --stack-name $$stack --region $(PRIMARY_REGION) --query 'Stacks[0].StackStatus' --output text 2>/dev/null || \
		         aws cloudformation describe-stacks --stack-name $$stack --region $(SECONDARY_REGION) --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "GONE"); \
		if [ "$$status" = "ROLLBACK_COMPLETE" ] || [ "$$status" = "ROLLBACK_FAILED" ]; then \
			echo "Deleting stuck stack $$stack ($$status)"; \
			aws cloudformation delete-stack --stack-name $$stack --region $(PRIMARY_REGION) 2>/dev/null || \
			aws cloudformation delete-stack --stack-name $$stack --region $(SECONDARY_REGION) 2>/dev/null || true; \
			aws cloudformation wait stack-delete-complete --stack-name $$stack --region $(PRIMARY_REGION) 2>/dev/null || \
			aws cloudformation wait stack-delete-complete --stack-name $$stack --region $(SECONDARY_REGION) 2>/dev/null || true; \
		fi; \
	done
	-$(CDK) destroy $(PROJECT)-monitoring-secondary $(CDK_CONTEXT) -c stack=monitoring-secondary --force -o cdk.out.ms &
	-$(CDK) destroy $(PROJECT)-monitoring-primary $(CDK_CONTEXT) -c stack=monitoring-primary --force -o cdk.out.mp &
	-$(CDK) destroy $(PROJECT)-failover $(CDK_CONTEXT) -c stack=failover --force -o cdk.out.fo &
	wait
	-$(CDK) destroy $(PROJECT)-routing-secondary $(CDK_CONTEXT) -c stack=routing-secondary --force -o cdk.out.rs &
	-$(CDK) destroy $(PROJECT)-routing-primary $(CDK_CONTEXT) -c stack=routing-primary --force -o cdk.out.rp &
	wait
	-$(CDK) destroy $(PROJECT)-global-routing $(CDK_CONTEXT) -c stack=global-routing --force
	-$(CDK) destroy $(PROJECT)-bucket-secondary $(CDK_CONTEXT) -c stack=bucket-secondary --force -o cdk.out.bs &
	-$(CDK) destroy $(PROJECT)-bucket-primary $(CDK_CONTEXT) -c stack=bucket-primary --force -o cdk.out.bp &
	wait
	@echo "✓ All stacks destroyed"
