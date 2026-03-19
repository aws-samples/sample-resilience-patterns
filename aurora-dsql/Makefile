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

deploy: deploy-vpc deploy-vpc-peering deploy-database deploy-dsql deploy-schema \
	deploy-aurora-app deploy-dsql-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
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

deploy-dsql: deploy-vpc
	@echo "═══ Deploying DSQL clusters ═══"
	@EXISTING_P=$$(aws cloudformation describe-stacks --stack-name $(PROJECT)-dsql-primary --region $(PRIMARY_REGION) --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NONE") && \
	if echo "$$EXISTING_P" | grep -q "COMPLETE"; then \
		echo "DSQL stacks already exist — skipping"; \
	else \
		$(CDK) deploy $(PROJECT)-dsql-primary $(CDK_COMMON) -c stack=dsql-primary --require-approval never -o cdk.out.dsql-p && \
		$(CDK) deploy $(PROJECT)-dsql-secondary $(CDK_COMMON) -c stack=dsql-secondary --require-approval never -o cdk.out.dsql-s && \
		DSQL_P_ARN=$(call so,$(PROJECT)-dsql-primary,$(PRIMARY_REGION),ClusterArn) && \
		DSQL_S_ARN=$(call so,$(PROJECT)-dsql-secondary,$(SECONDARY_REGION),ClusterArn) && \
		echo "Linking DSQL clusters..." && \
		$(CDK) deploy $(PROJECT)-dsql-primary $(CDK_COMMON) -c stack=dsql-primary -c "dsqlPeerArns=$$DSQL_P_ARN,$$DSQL_S_ARN" --require-approval never -o cdk.out.dsql-p2 && \
		$(CDK) deploy $(PROJECT)-dsql-secondary $(CDK_COMMON) -c stack=dsql-secondary -c "dsqlPeerArns=$$DSQL_P_ARN,$$DSQL_S_ARN" --require-approval never -o cdk.out.dsql-s2; \
	fi

deploy-dsql-app: deploy-dsql deploy-schema
	@echo "═══ Deploying DSQL app stacks ═══"
	@DSQL_P_ENDPOINT=$(call so,$(PROJECT)-dsql-primary,$(PRIMARY_REGION),Endpoint) && \
	DSQL_S_ENDPOINT=$(call so,$(PROJECT)-dsql-secondary,$(SECONDARY_REGION),Endpoint) && \
	$(CDK) deploy $(PROJECT)-dsql-app-primary $(CDK_COMMON) -c stack=dsql-app-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c dsqlEndpoint=$$DSQL_P_ENDPOINT \
		--require-approval never -o cdk.out.dapp-p && \
	$(CDK) deploy $(PROJECT)-dsql-app-secondary $(CDK_COMMON) -c stack=dsql-app-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c dsqlEndpoint=$$DSQL_S_ENDPOINT \
		--require-approval never -o cdk.out.dapp-s

deploy-schema: deploy-database
	@echo "═══ Deploying schema migration ═══"
	@SECRET_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	ENC_KEY_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-schema $(CDK_COMMON) -c stack=schema \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never

deploy-aurora-app: deploy-schema
	@echo "═══ Deploying Aurora app stacks ═══"
	@SECRET_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	ENC_KEY_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-aurora-app-primary $(CDK_COMMON) -c stack=aurora-app-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never -o cdk.out.aapp-p && \
	$(CDK) deploy $(PROJECT)-aurora-app-secondary $(CDK_COMMON) -c stack=aurora-app-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never -o cdk.out.aapp-s

deploy-dns: deploy-aurora-app deploy-dsql-app
	@echo "═══ Deploying DNS ═══"
	@PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	P_AURORA_ALB_DNS=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	P_AURORA_ALB_HZ=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbHostedZoneId) && \
	S_AURORA_ALB_DNS=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	S_AURORA_ALB_HZ=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbHostedZoneId) && \
	P_DSQL_ALB_DNS=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	P_DSQL_ALB_HZ=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbHostedZoneId) && \
	S_DSQL_ALB_DNS=$(call so,$(PROJECT)-dsql-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	S_DSQL_ALB_HZ=$(call so,$(PROJECT)-dsql-app-secondary,$(SECONDARY_REGION),AlbHostedZoneId) && \
	$(CDK) deploy $(PROJECT)-dns $(CDK_COMMON) -c stack=dns \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c secondaryVpcId=$$SECONDARY_VPC_ID \
		-c primaryAuroraAlbDns=$$P_AURORA_ALB_DNS -c primaryAuroraAlbHostedZoneId=$$P_AURORA_ALB_HZ \
		-c secondaryAuroraAlbDns=$$S_AURORA_ALB_DNS -c secondaryAuroraAlbHostedZoneId=$$S_AURORA_ALB_HZ \
		-c primaryDsqlAlbDns=$$P_DSQL_ALB_DNS -c primaryDsqlAlbHostedZoneId=$$P_DSQL_ALB_HZ \
		-c secondaryDsqlAlbDns=$$S_DSQL_ALB_DNS -c secondaryDsqlAlbHostedZoneId=$$S_DSQL_ALB_HZ \
		--require-approval never

deploy-monitoring: deploy-database
	@echo "═══ Deploying monitoring stacks ═══"
	@export P_SECRET=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	export P_KEY=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	export S_KEY=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),EncryptionKeyArn) && \
	export P_CLUSTER_ID=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),ClusterIdentifier) && \
	export S_CLUSTER_ID=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),ClusterIdentifier) && \
	$(CDK) deploy $(PROJECT)-monitoring-primary $(CDK_COMMON) -c stack=monitoring-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c dbClusterIdentifier=$$P_CLUSTER_ID -c secretArn=$$P_SECRET -c encryptionKeyArn=$$P_KEY \
		-c remoteSecretArn=$$P_SECRET -c remoteEncryptionKeyArn=$$S_KEY \
		--require-approval never -o cdk.out.mon-p && \
	$(CDK) deploy $(PROJECT)-monitoring-secondary $(CDK_COMMON) -c stack=monitoring-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c dbClusterIdentifier=$$S_CLUSTER_ID -c secretArn=$$P_SECRET -c encryptionKeyArn=$$S_KEY \
		-c remoteSecretArn=$$P_SECRET -c remoteEncryptionKeyArn=$$P_KEY \
		--require-approval never -o cdk.out.mon-s

deploy-chaos: deploy-vpc deploy-database
	@echo "═══ Deploying chaos stacks ═══"
	@$(CDK) deploy $(PROJECT)-chaos-primary $(CDK_COMMON) -c stack=chaos-primary \
		--require-approval never -o cdk.out.chaos-p & \
	$(CDK) deploy $(PROJECT)-chaos-secondary $(CDK_COMMON) -c stack=chaos-secondary \
		--require-approval never -o cdk.out.chaos-s & \
	wait

deploy-failover-plan: deploy-dns
	@echo "═══ Deploying ARC Region Switch Plan ═══"
	@HZ_ID=$(call so,$(PROJECT)-dns,$(PRIMARY_REGION),HostedZoneIdOutput) && \
	P_CLUSTER_ARN=$$(aws rds describe-db-clusters --region $(PRIMARY_REGION) --query "DBClusters[?GlobalClusterIdentifier=='$(GLOBAL_CLUSTER_ID)'].DBClusterArn" --output text) && \
	S_CLUSTER_ARN=$$(aws rds describe-db-clusters --region $(SECONDARY_REGION) --query "DBClusters[?GlobalClusterIdentifier=='$(GLOBAL_CLUSTER_ID)'].DBClusterArn" --output text) && \
	$(CDK) deploy $(PROJECT)-failover-plan $(CDK_COMMON) -c stack=failover-plan \
		-c hostedZoneId=$$HZ_ID \
		-c primaryClusterArn=$$P_CLUSTER_ARN -c secondaryClusterArn=$$S_CLUSTER_ARN \
		--require-approval never

deploy-dns-with-hc: deploy-failover-plan
	@echo "═══ Re-deploying DNS with ARC health check IDs ═══"
	@PLAN_ARN=$(call so,$(PROJECT)-failover-plan,$(PRIMARY_REGION),PlanArn) && \
	P_HC_ID=$$(aws arc-region-switch list-route53-health-checks --arn $$PLAN_ARN --region $(PRIMARY_REGION) --output json 2>/dev/null | jq -r '.healthChecks[] | select(.region == "$(PRIMARY_REGION)") | .healthCheckId' 2>/dev/null || echo "") && \
	S_HC_ID=$$(aws arc-region-switch list-route53-health-checks --arn $$PLAN_ARN --region $(PRIMARY_REGION) --output json 2>/dev/null | jq -r '.healthChecks[] | select(.region == "$(SECONDARY_REGION)") | .healthCheckId' 2>/dev/null || echo "") && \
	if [ -n "$$P_HC_ID" ] && [ -n "$$S_HC_ID" ]; then \
		PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
		SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
		P_AURORA_ALB_DNS=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
		P_AURORA_ALB_HZ=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbHostedZoneId) && \
		S_AURORA_ALB_DNS=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
		S_AURORA_ALB_HZ=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbHostedZoneId) && \
		P_DSQL_ALB_DNS=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
		P_DSQL_ALB_HZ=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbHostedZoneId) && \
		S_DSQL_ALB_DNS=$(call so,$(PROJECT)-dsql-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
		S_DSQL_ALB_HZ=$(call so,$(PROJECT)-dsql-app-secondary,$(SECONDARY_REGION),AlbHostedZoneId) && \
		$(CDK) deploy $(PROJECT)-dns $(CDK_COMMON) -c stack=dns \
			-c primaryVpcId=$$PRIMARY_VPC_ID -c secondaryVpcId=$$SECONDARY_VPC_ID \
			-c primaryAuroraAlbDns=$$P_AURORA_ALB_DNS -c primaryAuroraAlbHostedZoneId=$$P_AURORA_ALB_HZ \
			-c secondaryAuroraAlbDns=$$S_AURORA_ALB_DNS -c secondaryAuroraAlbHostedZoneId=$$S_AURORA_ALB_HZ \
			-c primaryDsqlAlbDns=$$P_DSQL_ALB_DNS -c primaryDsqlAlbHostedZoneId=$$P_DSQL_ALB_HZ \
			-c secondaryDsqlAlbDns=$$S_DSQL_ALB_DNS -c secondaryDsqlAlbHostedZoneId=$$S_DSQL_ALB_HZ \
			-c primaryHealthCheckId=$$P_HC_ID -c secondaryHealthCheckId=$$S_HC_ID \
			--require-approval never; \
	else \
		echo "No ARC health checks found — skipping DNS health check wiring"; \
	fi

deploy-synthetics: deploy-dns-with-hc
	@echo "═══ Deploying Synthetics canaries ═══"
	@P_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	S_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	P_DSQL_ALB=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	S_DSQL_ALB=$(call so,$(PROJECT)-dsql-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-synthetics-primary $(CDK_COMMON) -c stack=synthetics-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c localAuroraAlbDns=$$P_AURORA_ALB -c localDsqlAlbDns=$$P_DSQL_ALB \
		--require-approval never -o cdk.out.synth-p && \
	$(CDK) deploy $(PROJECT)-synthetics-secondary $(CDK_COMMON) -c stack=synthetics-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c localAuroraAlbDns=$$S_AURORA_ALB -c localDsqlAlbDns=$$S_DSQL_ALB \
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

deploy-loadgen: deploy-aurora-app deploy-dsql-app
	@echo "═══ Deploying load generation ═══"
	@P_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	P_DSQL_ALB=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-loadgen $(CDK_COMMON) -c stack=loadgen \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c auroraAlbDns=$$P_AURORA_ALB -c dsqlAlbDns=$$P_DSQL_ALB \
		--require-approval never

clean:
	./cleanup.sh

.PHONY: deploy deploy-vpc deploy-vpc-peering deploy-database deploy-dsql deploy-dsql-app deploy-schema deploy-aurora-app deploy-dns deploy-failover-plan deploy-dns-with-hc deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos clean
	deploy-aurora-app deploy-dns deploy-monitoring deploy-chaos clean
