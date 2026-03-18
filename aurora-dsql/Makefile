PROJECT ?= aurora-dsql
PRIMARY_REGION ?= us-east-1
SECONDARY_REGION ?= us-west-2
ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text)
CDK = npx cdk
CDK_COMMON = -c project=$(PROJECT) -c primaryRegion=$(PRIMARY_REGION) -c secondaryRegion=$(SECONDARY_REGION) -c accountId=$(ACCOUNT_ID)
GLOBAL_CLUSTER_ID = $(PROJECT)-global-cluster

.DEFAULT_GOAL := deploy

# Shell helper to get stack output
# Usage: $(call so,stack-name,region,OutputKey)
define so
$$(aws cloudformation describe-stacks --stack-name $(1) --region $(2) --query "Stacks[0].Outputs[?OutputKey=='$(3)'].OutputValue" --output text)
endef

# Shell helper to get stack resource physical ID
define sr
$$(aws cloudformation describe-stack-resources --stack-name $(1) --region $(2) --query "StackResources[?LogicalResourceId=='$(3)'].PhysicalResourceId" --output text)
endef

deploy: deploy-vpc deploy-vpc-peering deploy-database deploy-dsql deploy-schema \
	deploy-aurora-app deploy-dsql-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
	deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos
	@echo "✅ All stacks deployed"

deploy-vpc:
	@echo "═══ Deploying VPCs ═══"
	$(CDK) deploy $(PROJECT)-vpc-primary $(CDK_COMMON) -c stack=vpc-primary -o cdk.out.vpc-p --require-approval never &
	$(CDK) deploy $(PROJECT)-vpc-secondary $(CDK_COMMON) -c stack=vpc-secondary -o cdk.out.vpc-s --require-approval never &
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
	@PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	PRIMARY_DB_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),DatabaseSg) && \
	$(CDK) deploy $(PROJECT)-db-primary $(CDK_COMMON) -c stack=db-primary \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryDbSgId=$$PRIMARY_DB_SG \
		--require-approval never && \
	SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	SECONDARY_DB_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),DatabaseSg) && \
	$(CDK) deploy $(PROJECT)-db-secondary $(CDK_COMMON) -c stack=db-secondary \
		-c secondaryVpcId=$$SECONDARY_VPC_ID -c secondaryDbSgId=$$SECONDARY_DB_SG \
		--require-approval never -o cdk.out.db-s

deploy-dsql: deploy-vpc
	@echo "═══ Deploying DSQL clusters ═══"
	@$(CDK) deploy $(PROJECT)-dsql-primary $(CDK_COMMON) -c stack=dsql-primary --require-approval never -o cdk.out.dsql-p && \
	$(CDK) deploy $(PROJECT)-dsql-secondary $(CDK_COMMON) -c stack=dsql-secondary --require-approval never -o cdk.out.dsql-s && \
	echo "Linking DSQL clusters..." && \
	DSQL_P_ARN=$(call so,$(PROJECT)-dsql-primary,$(PRIMARY_REGION),ClusterArn) && \
	DSQL_S_ARN=$(call so,$(PROJECT)-dsql-secondary,$(SECONDARY_REGION),ClusterArn) && \
	$(CDK) deploy $(PROJECT)-dsql-primary $(CDK_COMMON) -c stack=dsql-primary -c "dsqlPeerArns=$$DSQL_P_ARN,$$DSQL_S_ARN" --require-approval never -o cdk.out.dsql-p2 && \
	$(CDK) deploy $(PROJECT)-dsql-secondary $(CDK_COMMON) -c stack=dsql-secondary -c "dsqlPeerArns=$$DSQL_P_ARN,$$DSQL_S_ARN" --require-approval never -o cdk.out.dsql-s2

deploy-schema: deploy-database
	@echo "═══ Deploying schema migration ═══"
	@PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	PRIMARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),LambdaSg) && \
	SECRET_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	ENC_KEY_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-schema $(CDK_COMMON) -c stack=schema \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryLambdaSgId=$$PRIMARY_LAMBDA_SG \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never

deploy-aurora-app: deploy-schema
	@echo "═══ Deploying Aurora app stacks ═══"
	@export PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	export SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	export PRIMARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),LambdaSg) && \
	export SECONDARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),LambdaSg) && \
	export PRIMARY_ALB_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),AlbSg) && \
	export SECONDARY_ALB_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),AlbSg) && \
	export SECRET_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	export ENC_KEY_ARN=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-aurora-app-primary $(CDK_COMMON) -c stack=aurora-app-primary \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryLambdaSgId=$$PRIMARY_LAMBDA_SG -c primaryAlbSgId=$$PRIMARY_ALB_SG \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never -o cdk.out.aapp-p & \
	$(CDK) deploy $(PROJECT)-aurora-app-secondary $(CDK_COMMON) -c stack=aurora-app-secondary \
		-c secondaryVpcId=$$SECONDARY_VPC_ID -c secondaryLambdaSgId=$$SECONDARY_LAMBDA_SG -c secondaryAlbSgId=$$SECONDARY_ALB_SG \
		-c secretArn=$$SECRET_ARN -c encryptionKeyArn=$$ENC_KEY_ARN \
		--require-approval never -o cdk.out.aapp-s & \
	wait

deploy-dsql-app: deploy-dsql
	@echo "═══ Deploying DSQL app stacks ═══"
	@export PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	export SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	export PRIMARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),LambdaSg) && \
	export SECONDARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),LambdaSg) && \
	export PRIMARY_ALB_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),AlbSg) && \
	export SECONDARY_ALB_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),AlbSg) && \
	export DSQL_P_ENDPOINT=$(call so,$(PROJECT)-dsql-primary,$(PRIMARY_REGION),Endpoint) && \
	export DSQL_S_ENDPOINT=$(call so,$(PROJECT)-dsql-secondary,$(SECONDARY_REGION),Endpoint) && \
	$(CDK) deploy $(PROJECT)-dsql-app-primary $(CDK_COMMON) -c stack=dsql-app-primary \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryLambdaSgId=$$PRIMARY_LAMBDA_SG -c primaryAlbSgId=$$PRIMARY_ALB_SG \
		-c dsqlEndpoint=$$DSQL_P_ENDPOINT \
		--require-approval never -o cdk.out.dapp-p & \
	$(CDK) deploy $(PROJECT)-dsql-app-secondary $(CDK_COMMON) -c stack=dsql-app-secondary \
		-c secondaryVpcId=$$SECONDARY_VPC_ID -c secondaryLambdaSgId=$$SECONDARY_LAMBDA_SG -c secondaryAlbSgId=$$SECONDARY_ALB_SG \
		-c dsqlEndpoint=$$DSQL_S_ENDPOINT \
		--require-approval never -o cdk.out.dapp-s & \
	wait

deploy-dns: deploy-aurora-app deploy-dsql-app
	@echo "═══ Deploying DNS (phase 1 — no health checks) ═══"
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
	P_HC_ID=$$(aws arc-region-switch list-route53-health-checks --arn $$PLAN_ARN --region $(PRIMARY_REGION) --output json | jq -r '.healthChecks[] | select(.region == "$(PRIMARY_REGION)") | .healthCheckId') && \
	S_HC_ID=$$(aws arc-region-switch list-route53-health-checks --arn $$PLAN_ARN --region $(PRIMARY_REGION) --output json | jq -r '.healthChecks[] | select(.region == "$(SECONDARY_REGION)") | .healthCheckId') && \
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
		--require-approval never

deploy-synthetics: deploy-dns-with-hc
	@echo "═══ Deploying Synthetics canaries ═══"
	@export P_SYNTH_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),SyntheticsSg) && \
	export S_SYNTH_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),SyntheticsSg) && \
	export PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	export SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	export P_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	export S_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	export P_DSQL_ALB=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	export S_DSQL_ALB=$(call so,$(PROJECT)-dsql-app-secondary,$(SECONDARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-synthetics-primary $(CDK_COMMON) -c stack=synthetics-primary \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c syntheticsSgId=$$P_SYNTH_SG \
		-c localAuroraAlbDns=$$P_AURORA_ALB -c localDsqlAlbDns=$$P_DSQL_ALB \
		-c crossRegionAuroraUrl=aurora-app.demo.internal -c crossRegionDsqlUrl=dsql-app.demo.internal \
		--require-approval never -o cdk.out.synth-p & \
	$(CDK) deploy $(PROJECT)-synthetics-secondary $(CDK_COMMON) -c stack=synthetics-secondary \
		-c secondaryVpcId=$$SECONDARY_VPC_ID -c syntheticsSgId=$$S_SYNTH_SG \
		-c localAuroraAlbDns=$$S_AURORA_ALB -c localDsqlAlbDns=$$S_DSQL_ALB \
		-c crossRegionAuroraUrl=aurora-app.demo.internal -c crossRegionDsqlUrl=dsql-app.demo.internal \
		--require-approval never -o cdk.out.synth-s & \
	wait

deploy-monitoring: deploy-database
	@echo "═══ Deploying monitoring stacks ═══"
	@export PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	export SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	export PRIMARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),LambdaSg) && \
	export SECONDARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),LambdaSg) && \
	export P_SECRET=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	export P_KEY=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	export S_KEY=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),EncryptionKeyArn) && \
	export P_CLUSTER_ID=$(call sr,$(PROJECT)-db-primary,$(PRIMARY_REGION),PrimaryCluster) && \
	export S_CLUSTER_ID=$(call sr,$(PROJECT)-db-secondary,$(SECONDARY_REGION),SecondaryCluster) && \
	$(CDK) deploy $(PROJECT)-monitoring-primary $(CDK_COMMON) -c stack=monitoring-primary \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryLambdaSgId=$$PRIMARY_LAMBDA_SG \
		-c dbClusterIdentifier=$$P_CLUSTER_ID -c secretArn=$$P_SECRET -c encryptionKeyArn=$$P_KEY \
		-c remoteSecretArn=$$P_SECRET -c remoteEncryptionKeyArn=$$S_KEY \
		--require-approval never -o cdk.out.mon-p & \
	$(CDK) deploy $(PROJECT)-monitoring-secondary $(CDK_COMMON) -c stack=monitoring-secondary \
		-c secondaryVpcId=$$SECONDARY_VPC_ID -c secondaryLambdaSgId=$$SECONDARY_LAMBDA_SG \
		-c dbClusterIdentifier=$$S_CLUSTER_ID -c secretArn=$$P_SECRET -c encryptionKeyArn=$$S_KEY \
		-c remoteSecretArn=$$P_SECRET -c remoteEncryptionKeyArn=$$P_KEY \
		--require-approval never -o cdk.out.mon-s & \
	wait

deploy-reconciliation: deploy-database
	@echo "═══ Deploying reconciliation stacks ═══"
	@export PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	export SECONDARY_VPC_ID=$(call so,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),VpcId) && \
	export PRIMARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),LambdaSg) && \
	export SECONDARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-secondary,$(SECONDARY_REGION),LambdaSg) && \
	export P_SECRET=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),SecretArn) && \
	export P_KEY=$(call so,$(PROJECT)-db-primary,$(PRIMARY_REGION),EncryptionKeyArn) && \
	export S_KEY=$(call so,$(PROJECT)-db-secondary,$(SECONDARY_REGION),EncryptionKeyArn) && \
	$(CDK) deploy $(PROJECT)-reconciliation-primary $(CDK_COMMON) -c stack=reconciliation-primary \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryLambdaSgId=$$PRIMARY_LAMBDA_SG \
		-c secretArn=$$P_SECRET -c encryptionKeyArn=$$P_KEY \
		--require-approval never -o cdk.out.recon-p & \
	$(CDK) deploy $(PROJECT)-reconciliation-secondary $(CDK_COMMON) -c stack=reconciliation-secondary \
		-c secondaryVpcId=$$SECONDARY_VPC_ID -c secondaryLambdaSgId=$$SECONDARY_LAMBDA_SG \
		-c secretArn=$$P_SECRET -c encryptionKeyArn=$$S_KEY \
		--require-approval never -o cdk.out.recon-s & \
	wait

deploy-loadgen: deploy-aurora-app deploy-dsql-app
	@echo "═══ Deploying load generation ═══"
	@PRIMARY_VPC_ID=$(call so,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),VpcId) && \
	PRIMARY_LAMBDA_SG=$(call sr,$(PROJECT)-vpc-primary,$(PRIMARY_REGION),LambdaSg) && \
	P_AURORA_ALB=$(call so,$(PROJECT)-aurora-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	P_DSQL_ALB=$(call so,$(PROJECT)-dsql-app-primary,$(PRIMARY_REGION),AlbDnsName) && \
	$(CDK) deploy $(PROJECT)-loadgen $(CDK_COMMON) -c stack=loadgen \
		-c primaryVpcId=$$PRIMARY_VPC_ID -c primaryLambdaSgId=$$PRIMARY_LAMBDA_SG \
		-c auroraAlbDns=$$P_AURORA_ALB -c dsqlAlbDns=$$P_DSQL_ALB \
		--require-approval never

deploy-chaos: deploy-vpc deploy-database
	@echo "═══ Deploying chaos stacks ═══"
	@$(CDK) deploy $(PROJECT)-chaos-primary $(CDK_COMMON) -c stack=chaos-primary \
		-c targetRegion=$(SECONDARY_REGION) \
		--require-approval never -o cdk.out.chaos-p & \
	$(CDK) deploy $(PROJECT)-chaos-secondary $(CDK_COMMON) -c stack=chaos-secondary \
		-c targetRegion=$(PRIMARY_REGION) \
		--require-approval never -o cdk.out.chaos-s & \
	wait

clean:
	./cleanup.sh

.PHONY: deploy deploy-vpc deploy-vpc-peering deploy-database deploy-dsql deploy-schema \
	deploy-aurora-app deploy-dsql-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
	deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos clean
