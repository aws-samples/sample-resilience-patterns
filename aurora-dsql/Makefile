PROJECT ?= aurora-dsql
PRIMARY_REGION ?= us-east-1
SECONDARY_REGION ?= us-west-2
ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text)
CDK = npx cdk
CDK_COMMON = -c project=$(PROJECT) -c primaryRegion=$(PRIMARY_REGION) -c secondaryRegion=$(SECONDARY_REGION) -c accountId=$(ACCOUNT_ID)

.DEFAULT_GOAL := deploy

deploy: deploy-vpc deploy-vpc-peering deploy-database deploy-dsql deploy-schema \
	deploy-aurora-app deploy-dsql-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
	deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos
	@echo "✅ All stacks deployed"

deploy-vpc:
	@echo "Deploying VPCs..."
	$(CDK) deploy $(PROJECT)-vpc-primary $(CDK_COMMON) -c stack=vpc-primary -o cdk.out.vpc-p --require-approval never &
	$(CDK) deploy $(PROJECT)-vpc-secondary $(CDK_COMMON) -c stack=vpc-secondary -o cdk.out.vpc-s --require-approval never &
	wait
	$(eval PRIMARY_VPC_ID := $(shell aws cloudformation describe-stacks --stack-name $(PROJECT)-vpc-primary --region $(PRIMARY_REGION) --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text))
	$(eval SECONDARY_VPC_ID := $(shell aws cloudformation describe-stacks --stack-name $(PROJECT)-vpc-secondary --region $(SECONDARY_REGION) --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text))
	$(eval PRIMARY_DB_SG := $(shell aws cloudformation describe-stack-resources --stack-name $(PROJECT)-vpc-primary --region $(PRIMARY_REGION) --query "StackResources[?LogicalResourceId=='DatabaseSg'].PhysicalResourceId" --output text))
	$(eval SECONDARY_DB_SG := $(shell aws cloudformation describe-stack-resources --stack-name $(PROJECT)-vpc-secondary --region $(SECONDARY_REGION) --query "StackResources[?LogicalResourceId=='DatabaseSg'].PhysicalResourceId" --output text))

deploy-vpc-peering: deploy-vpc
	@echo "Deploying VPC peering..."
	$(CDK) deploy $(PROJECT)-vpc-peering $(CDK_COMMON) -c stack=vpc-peering \
		-c primaryVpcId=$(PRIMARY_VPC_ID) -c secondaryVpcId=$(SECONDARY_VPC_ID) \
		--require-approval never
	@echo "Accepting peering and adding routes via CLI..."
	$(eval PEERING_ID := $(shell aws cloudformation describe-stacks --stack-name $(PROJECT)-vpc-peering --region $(PRIMARY_REGION) --query "Stacks[0].Outputs[?OutputKey=='PeeringConnectionId'].OutputValue" --output text))
	aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id $(PEERING_ID) --region $(SECONDARY_REGION) || true
	@# Add routes in secondary VPC
	$(eval SEC_RT_IDS := $(shell aws ec2 describe-route-tables --filters Name=vpc-id,Values=$(SECONDARY_VPC_ID) --region $(SECONDARY_REGION) --query "RouteTables[].RouteTableId" --output text))
	@for rt in $(SEC_RT_IDS); do \
		aws ec2 create-route --route-table-id $$rt --destination-cidr-block 10.0.0.0/23 --vpc-peering-connection-id $(PEERING_ID) --region $(SECONDARY_REGION) 2>/dev/null || true; \
	done

deploy-database: deploy-vpc
	@echo "Deploying Aurora Global Database primary..."
	$(CDK) deploy $(PROJECT)-db-primary $(CDK_COMMON) -c stack=db-primary \
		-c primaryVpcId=$(PRIMARY_VPC_ID) -c primaryDbSgId=$(PRIMARY_DB_SG) \
		--require-approval never
	@echo "Deploying Aurora Global Database secondary..."
	$(CDK) deploy $(PROJECT)-db-secondary $(CDK_COMMON) -c stack=db-secondary \
		-c secondaryVpcId=$(SECONDARY_VPC_ID) -c secondaryDbSgId=$(SECONDARY_DB_SG) \
		--require-approval never -o cdk.out.db-s

deploy-dsql: deploy-vpc
	@echo "Deploying DSQL clusters..."
	$(CDK) deploy $(PROJECT)-dsql-primary $(CDK_COMMON) -c stack=dsql-primary --require-approval never -o cdk.out.dsql-p
	$(CDK) deploy $(PROJECT)-dsql-secondary $(CDK_COMMON) -c stack=dsql-secondary --require-approval never -o cdk.out.dsql-s
	@echo "Linking DSQL clusters..."
	$(eval DSQL_PRIMARY_ARN := $(shell aws cloudformation describe-stacks --stack-name $(PROJECT)-dsql-primary --region $(PRIMARY_REGION) --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text))
	$(eval DSQL_SECONDARY_ARN := $(shell aws cloudformation describe-stacks --stack-name $(PROJECT)-dsql-secondary --region $(SECONDARY_REGION) --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text))
	$(CDK) deploy $(PROJECT)-dsql-primary $(CDK_COMMON) -c stack=dsql-primary -c "dsqlPeerArns=$(DSQL_PRIMARY_ARN),$(DSQL_SECONDARY_ARN)" --require-approval never -o cdk.out.dsql-p2
	$(CDK) deploy $(PROJECT)-dsql-secondary $(CDK_COMMON) -c stack=dsql-secondary -c "dsqlPeerArns=$(DSQL_PRIMARY_ARN),$(DSQL_SECONDARY_ARN)" --require-approval never -o cdk.out.dsql-s2

deploy-schema: deploy-database
	@echo "Deploying schema migration..."
	@echo "TODO: Wire SchemaStack with runtime DB endpoint values"

deploy-aurora-app: deploy-schema
	@echo "Deploying Aurora app stacks..."
	@echo "TODO: Wire AuroraAppStack with runtime values"

deploy-dsql-app: deploy-dsql
	@echo "Deploying DSQL app stacks..."
	@echo "TODO: Wire DsqlAppStack with runtime values"

deploy-dns: deploy-aurora-app deploy-dsql-app
	@echo "Deploying DNS (without health checks)..."
	@echo "TODO: Wire DnsStack with ALB outputs"

deploy-failover-plan: deploy-dns
	@echo "Deploying ARC Region Switch Plan..."
	@echo "TODO: Wire FailoverPlanStack with hosted zone + cluster ARNs"

deploy-dns-with-hc: deploy-failover-plan
	@echo "Re-deploying DNS with ARC health check IDs..."
	@echo "TODO: Capture health check IDs from ARC plan and re-deploy DNS"

deploy-synthetics: deploy-dns-with-hc
	@echo "Deploying Synthetics canaries..."
	@echo "TODO: Wire SyntheticsStack with ALB DNS names"

deploy-monitoring: deploy-database
	@echo "Deploying monitoring stacks..."
	@echo "TODO: Wire MonitoringStack with cluster identifiers + secrets"

deploy-reconciliation: deploy-database
	@echo "Deploying reconciliation stacks..."
	@echo "TODO: Wire ReconciliationStack"

deploy-loadgen: deploy-aurora-app deploy-dsql-app
	@echo "Deploying load generation..."
	@echo "TODO: Wire LoadGenStack with ALB DNS names"

deploy-chaos: deploy-vpc deploy-database
	@echo "Deploying chaos stacks..."
	@echo "TODO: Wire ChaosStack"

clean:
	./cleanup.sh

.PHONY: deploy deploy-vpc deploy-vpc-peering deploy-database deploy-dsql deploy-schema \
	deploy-aurora-app deploy-dsql-app deploy-dns deploy-failover-plan deploy-dns-with-hc \
	deploy-synthetics deploy-monitoring deploy-reconciliation deploy-loadgen deploy-chaos clean
