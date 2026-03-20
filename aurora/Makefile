PROJECT ?= aurora-dsql
PRIMARY_REGION ?= us-east-1
SECONDARY_REGION ?= us-west-2
ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text)
CDK = npx cdk
CDK_COMMON = -c project=$(PROJECT) -c primaryRegion=$(PRIMARY_REGION) -c secondaryRegion=$(SECONDARY_REGION) -c accountId=$(ACCOUNT_ID)
GLOBAL_CLUSTER_ID = $(PROJECT)-global-cluster

.DEFAULT_GOAL := deploy

define so
$$(aws cloudformation describe-stacks --stack-name $(1) --region $(2) --query "Stacks[0].Outputs[?OutputKey=='$(3)'].OutputValue" --output text)
endef

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
	deploy-aurora-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
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
	S_READER_ENDPOINT=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),ClusterReaderEndpoint) && \
	ENC_KEY_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-aurora-app-primary $(CDK_COMMON) -c stack=aurora-app-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never -o cdk.out.aapp-p && \
	$(CDK) deploy $(PROJECT)-aurora-app-secondary $(CDK_COMMON) -c stack=aurora-app-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN -c dbHostOverride=$$S_READER_ENDPOINT \
		--require-approval never -o cdk.out.aapp-s

deploy-dns: deploy-aurora-app
	@echo "═══ Deploying DNS ═══"
	@PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	P_ALB_DNS=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	P_ALB_HZ=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbHostedZoneId) && \
	S_ALB_DNS=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	S_ALB_HZ=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbHostedZoneId) && \
	$(CDK) deploy $(PROJECT)-dns $(CDK_COMMON) -c stack=dns \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c secondaryVpcId=$$SECONDARY_VPC_ID \
		-c primaryAuroraAlbDns=$$P_ALB_DNS -c primaryAuroraAlbHostedZoneId=$$P_ALB_HZ \
		-c secondaryAuroraAlbDns=$$S_ALB_DNS -c secondaryAuroraAlbHostedZoneId=$$S_ALB_HZ \
		--require-approval never

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
		P_ALB_DNS=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
		P_ALB_HZ=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbHostedZoneId) && \
		S_ALB_DNS=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
		S_ALB_HZ=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbHostedZoneId) && \
		$(CDK) deploy $(PROJECT)-dns $(CDK_COMMON) -c stack=dns \
			-c primaryVpcId=$$PRIMARY_VPC_ID -c secondaryVpcId=$$SECONDARY_VPC_ID \
			-c primaryAuroraAlbDns=$$P_ALB_DNS -c primaryAuroraAlbHostedZoneId=$$P_ALB_HZ \
			-c secondaryAuroraAlbDns=$$S_ALB_DNS -c secondaryAuroraAlbHostedZoneId=$$S_ALB_HZ \
			-c primaryHealthCheckId=$$P_HC_ID -c secondaryHealthCheckId=$$S_HC_ID \
			--require-approval never; \
	else \
		echo "No ARC health checks found — skipping"; \
	fi

deploy-synthetics: deploy-dns-with-hc
	@echo "═══ Deploying Synthetics canaries ═══"
	@P_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	S_ALB=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-synthetics-primary $(CDK_COMMON) -c stack=synthetics-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c localRecordName=aurora-app-use1.demo.internal \
		-c remoteRecordName=aurora-app-usw2.demo.internal \
		-c dnsRecordName=aurora-app.demo.internal \
		--require-approval never -o cdk.out.synth-p && \
	$(CDK) deploy $(PROJECT)-synthetics-secondary $(CDK_COMMON) -c stack=synthetics-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c localRecordName=aurora-app-usw2.demo.internal \
		-c remoteRecordName=aurora-app-use1.demo.internal \
		-c dnsRecordName=aurora-app.demo.internal \
		--require-approval never -o cdk.out.synth-s

deploy-monitoring: deploy-database
	@echo "═══ Deploying monitoring stacks ═══"
	@P_SECRET=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	P_KEY=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	S_KEY=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),EncryptionKeyArn) && \
	P_CLUSTER_ID=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),ClusterIdentifier) && \
	S_CLUSTER_ID=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),ClusterIdentifier) && \
	$(CDK) deploy $(PROJECT)-monitoring-primary $(CDK_COMMON) -c stack=monitoring-primary \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c dbClusterIdentifier=$$P_CLUSTER_ID -c globalClusterIdentifier=$(GLOBAL_CLUSTER_ID) -c secretArn=$$P_SECRET -c encryptionKeyArn=$$P_KEY \
		-c remoteSecretArn=$$P_SECRET -c remoteEncryptionKeyArn=$$S_KEY \
		--require-approval never -o cdk.out.mon-p && \
	$(CDK) deploy $(PROJECT)-monitoring-secondary $(CDK_COMMON) -c stack=monitoring-secondary \
		$(call vpc_ctx,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION)) \
		-c dbClusterIdentifier=$$S_CLUSTER_ID -c globalClusterIdentifier=$(GLOBAL_CLUSTER_ID) -c secretArn=$$P_SECRET -c encryptionKeyArn=$$S_KEY \
		-c remoteSecretArn=$$P_SECRET -c remoteEncryptionKeyArn=$$P_KEY \
		--require-approval never -o cdk.out.mon-s

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

deploy-loadgen: deploy-aurora-app
	@echo "═══ Deploying load generation ═══"
	@P_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-loadgen $(CDK_COMMON) -c stack=loadgen \
		$(call vpc_ctx,$(PROJECT)-vpc-primary,$(PRIMARY_REGION)) \
		-c auroraAlbDns=$$P_ALB \
		--require-approval never

deploy-chaos: deploy-vpc deploy-database
	@echo "═══ Deploying chaos stacks ═══"
	@$(CDK) deploy $(PROJECT)-chaos-primary $(CDK_COMMON) -c stack=chaos-primary \
		--require-approval never -o cdk.out.chaos-p & \
	$(CDK) deploy $(PROJECT)-chaos-secondary $(CDK_COMMON) -c stack=chaos-secondary \
		--require-approval never -o cdk.out.chaos-s & \
	wait

clean:
	./cleanup.sh

.PHONY: deploy deploy-vpc deploy-vpc-peering deploy-database deploy-schema deploy-aurora-app \
	deploy-dns deploy-failover-plan deploy-dns-with-hc deploy-synthetics deploy-monitoring \
	deploy-reconciliation deploy-loadgen deploy-chaos clean
