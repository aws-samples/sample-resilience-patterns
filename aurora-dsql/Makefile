PROJECT ?= aurora-dsql
PRIMARY_REGION ?= us-east-1
SECONDARY_REGION ?= us-west-2
ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text)
CDK = npx cdk
CDK_COMMON = -c project=$(PROJECT) -c primaryRegion=$(PRIMARY_REGION) -c secondaryRegion=$(SECONDARY_REGION) -c accountId=$(ACCOUNT_ID)
GLOBAL_CLUSTER_ID = $(PROJECT)-global-cluster

.DEFAULT_GOAL := deploy

# Shell helper: get stack output
define so
$$(aws cloudformation describe-stacks --stack-name $(1) --region $(2) --query "Stacks[0].Outputs[?OutputKey=='$(3)'].OutputValue" --output text)
endef

# Shell helper: get VPC context args for a region
# Usage: $(call vpc_ctx,stack-name,region) -> -c vpcId=... -c subnetIds=... -c azs=... -c dbSgId=... -c lambdaSgId=... -c albSgId=... -c syntheticsSgId=...
define vpc_ctx
-c vpcId=$(call so,$(1),$(2),VpcId) \
-c subnetIds=$(call so,$(1),$(2),IsolatedSubnetIds) \
-c azs=$(call so,$(1),$(2),AvailabilityZones) \
-c dbSgId=$(call so,$(1),$(2),DatabaseSgId) \
-c lambdaSgId=$(call so,$(1),$(2),LambdaSgId) \
-c albSgId=$(call so,$(1),$(2),AlbSgId) \
-c syntheticsSgId=$(call so,$(1),$(2),SyntheticsSgId)
endef

deploy: deploy-vpc deploy-vpc-peering deploy-database deploy-schema \
	deploy-aurora-app-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
	deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos
	@echo "✅ All stacks deployed"

deploy-vpc:
	@echo "═══ Deploying VPCs ═══"
	@$(CDK) deploy $(PROJECT)-vpc-primary $(CDK_COMMON) -c stack=vpc-primary -o cdk.out.vpc-p --require-approval never & \
	$(CDK) deploy $(PROJECT)-vpc-secondary $(CDK_COMMON) -c stack=vpc-secondary -o cdk.out.vpc-s --require-approval never & \
	wait

deploy-vpc-peering: deploy-vpc
	@echo "═══ Deploying VPC peering ═══"
	@PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	$(CDK) deploy $(PROJECT)-vpc-peering $(CDK_COMMON) -c stack=vpc-peering \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c secondaryVpcId=$$SECONDARY_VPC_ID \
		--require-approval never && \
	PEERING_ID=$(call so,$(PROJECT)-vpc-peering,$(PRIMARY_REGION),PeeringConnectionId) && \
	aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id $$PEERING_ID --region $(SECONDARY_REGION) 2>/dev/null || true && \
	SEC_RT_IDS=$$(aws ec2 describe-route-tables --filters Name=vpc-id,Values=$$SECONDARY_VPC_ID --region $(SECONDARY_REGION) --query "RouteTables[].RouteTableId" --output text) && \
	for rt in $$SEC_RT_IDS; do \
		aws ec2 create-route --route-table-id $$rt --destination-cidr-block 10.0.0.0/23 --vpc-peering-connection-id $$PEERING_ID --region $(SECONDARY_REGION) 2>/dev/null || true; \
	done

deploy-database: deploy-vpc
	@echo "═══ Deploying Aurora Global Database ═══"
	@$(CDK) deploy $(PROJECT)-db-primary $(CDK_COMMON) -c stack=db-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		--require-approval never && \
	$(CDK) deploy $(PROJECT)-db-secondary $(CDK_COMMON) -c stack=db-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		--require-approval never -o cdk.out.db-s



deploy-synthetics: deploy-dns-with-hc
	@echo "═══ Deploying Synthetics canaries ═══"
	@P_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	S_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-synthetics-primary $(CDK_COMMON) -c stack=synthetics-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		--require-approval never -o cdk.out.synth-p && \
	$(CDK) deploy $(PROJECT)-synthetics-secondary $(CDK_COMMON) -c stack=synthetics-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		--require-approval never -o cdk.out.synth-s

deploy-reconciliation: deploy-database
	@echo "═══ Deploying reconciliation stacks ═══"
	@P_SECRET=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	P_KEY=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	S_KEY=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-reconciliation-primary $(CDK_COMMON) -c stack=reconciliation-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c secretArn=$$P_SECRET -c encryptionKeyArn=$$P_KEY \
		--require-approval never -o cdk.out.recon-p && \
	$(CDK) deploy $(PROJECT)-reconciliation-secondary $(CDK_COMMON) -c stack=reconciliation-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c secretArn=$$P_SECRET -c encryptionKeyArn=$$S_KEY \
		--require-approval never -o cdk.out.recon-s

deploy-loadgen: deploy-aurora-app-app
	@echo "═══ Deploying load generation ═══"
	@P_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-loadgen $(CDK_COMMON) -c stack=loadgen \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		--require-approval never

clean:
	./cleanup.sh

.PHONY: deploy deploy-vpc deploy-vpc-peering deploy-database deploy-schema deploy-aurora-app deploy-dns deploy-failover-plan deploy-dns-with-hc deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos clean
	deploy-aurora-app deploy-dns deploy-monitoring deploy-chaos clean
