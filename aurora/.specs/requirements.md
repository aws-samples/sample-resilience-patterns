# Requirements: Aurora Global Database — Multi-Region Resilience Demo

## Functional Requirements

### FR-1: Aurora Global Database (PostgreSQL)

- Aurora PostgreSQL 16.6 Global Database spanning us-east-1 (primary) and us-west-2 (secondary)
- Primary cluster in us-east-1 with one writer instance (db.r6g.large)
- Secondary cluster in us-west-2 with one reader instance (db.r6g.large)
- Storage-based replication (typically <1s lag)
- Encrypted with customer-managed KMS key per region (key rotation enabled)
- Deletion protection disabled (demo teardown)
- Automated backups with 7-day retention
- Global cluster identifier: `${project}-global-cluster`
- Default database name: `orders`

### FR-2: Test Application (Lambda-based, ALB-fronted)

- Single Aurora app Lambda deployed in both regions behind internal ALBs
- ALB with HTTP listener (port 80) in isolated subnets
- Lambda target group with `/health` health check
- Endpoints:
  - `POST /orders` — calls `sp_insert_order`
  - `PUT /orders/{id}/status` — calls `sp_update_order_status`
  - `DELETE /orders/{id}` — calls `sp_delete_order`
  - `GET /orders` — calls `sp_query_orders` (query params: region, status, since)
  - `GET /health` — connectivity check (returns region)
- Read/write split: `DB_READ_HOST` (local cluster endpoint) for GET, `DB_WRITE_HOST` (Aurora Global writer endpoint) for POST/PUT/DELETE
- Secret accessed by name `${project}/db-credentials` (not ARN) — replicated to both regions
- IAM policy also allows access to replicated secret via wildcard ARN pattern
- Deployed in isolated subnets, accesses AWS services via VPC endpoints only
- Reserved concurrency: 5, timeout: 60s
- Python 3.12, psycopg2-binary

### FR-3: CloudWatch Synthetics Testing

- 6 CloudWatch Synthetics canaries per region (12 total):
  - Read-only local (`aurora-rd-local-{e1|w2}`) — hits region-aligned record for own region
  - Read-only remote (`aurora-rd-remote-{e1|w2}`) — hits region-aligned record for opposite region via VPC peering
  - Read-only global (`aurora-rd-global-{e1|w2}`) — hits `aurora-app.demo.internal` (ARC-managed latency-based routing)
  - Write local (`aurora-wr-local-{e1|w2}`) — POST + DELETE against own region record
  - Write remote (`aurora-wr-remote-{e1|w2}`) — POST + DELETE against opposite region record via VPC peering
  - Write global (`aurora-wr-global-{e1|w2}`) — POST + DELETE against `aurora-app.demo.internal`
- Read-only canaries: GET /health + GET /orders
- Write canaries: POST /orders + DELETE /orders/{id}
- Runtime: syn-python-selenium-10.0
- Runs every 5 minutes
- Canary artifacts stored in S3 (KMS encrypted, block public access, enforce SSL)
- CloudWatch alarm on canary SuccessPercent per canary (threshold: 100%, treat missing: ignore)
- All canaries VPC-deployed with Synthetics SG
- All testing flows through private hosted zone DNS records
- Canary names truncated to 21 characters

### FR-4: Database Schema

- Orders table: id (UUID, gen_random_uuid), region (VARCHAR 20), status (VARCHAR 20, default PENDING), payload (JSONB), created_at (TIMESTAMPTZ), updated_at (TIMESTAMPTZ), deleted_at (TIMESTAMPTZ)
- Replication tracking table: id (UUID, gen_random_uuid), source_region (VARCHAR 20), txn_id (BIGINT), committed_at (TIMESTAMPTZ), replicated_at (TIMESTAMPTZ)
- Indexes: idx_orders_region, idx_orders_status, idx_orders_created_at, idx_repl_tracking_source, idx_repl_tracking_committed
- Schema deployed via Lambda-backed custom resource (Provider pattern, on_event handler)
- 4 stored procedures: sp_insert_order, sp_update_order_status, sp_delete_order, sp_query_orders
- Idempotent (CREATE OR REPLACE for functions, IF NOT EXISTS for tables and indexes)
- Migration Lambda: Python 3.12, 5-min timeout, reserved concurrency 1

### FR-5: CloudWatch Alarms (Per Region)

7 alarms per region (14 total):
- ReplicaLag: AuroraReplicaLag > 1000ms (Maximum, 1 eval period) — SNS action
- ReplicaLagMax: AuroraReplicaLagMaximum > 2000ms (Maximum, 1 eval period) — SNS action
- CommitLatency: CommitLatency > 100ms (Average, 3 eval periods) — SNS action
- CatalogMissingRows: CatalogMissingRows > 10 (Maximum, 2 eval periods, custom namespace)
- Heartbeat: CatalogRPOHeartbeat < 1 (Sum, 2 eval periods, 10-min period, treat missing as BREACHING)
- EngineVersionMismatch: AuroraEngineVersionMismatch >= 1 (Maximum, 1 eval period)
- WriterRegionChange: AuroraWriterActive < 1 for primary region dimension (Maximum, 2 eval periods)
- Aurora alarms (ReplicaLag, ReplicaLagMax, CommitLatency) have SNS ALARM + OK actions
- SNS topic encrypted with KMS (key rotation enabled)

### FR-6: CloudWatch Dashboard (Primary Region Only)

Combined dashboard (`${project}-combined`) in us-east-1 with 7 widgets:
1. Writer Region — SingleValueWidget (12×3): AuroraWriterActive per region
2. DNS Active Region — SingleValueWidget (12×3): RegionDNSActive per region
3. Replica Lag — GraphWidget (12×6): AuroraReplicaLag from both regions
4. Missing Rows — GraphWidget (12×6): CatalogMissingRows from both regions
5. Commit Latency — full-width GraphWidget (24×6): CommitLatency Average from both regions
6. Engine Version Alignment — full-width SingleValueWidget (24×3): AuroraEngineVersionMismatch (0 = match, 1 = MISMATCH — blocks failover)
7. Heartbeat — full-width GraphWidget (24×5): CatalogRPOHeartbeat (gaps = monitor stopped, RPO data is stale)

### FR-7: RPO Monitoring

- RPO monitor Lambda deployed to both regions, runs every 5 minutes via EventBridge
- Each invocation connects to local Aurora (via secret host) and remote Aurora (via REMOTE_DB_HOST override)
- Compares order IDs (excluding soft-deleted) across regions
- Publishes to local CloudWatch (custom namespace `${project}/RPO`):
  - `CatalogMissingRows` — rows remote has that local doesn't (local dimension) + rows local has that remote doesn't (remote dimension)
  - `CatalogRPOHeartbeat` — value=1 for both local and remote region dimensions
  - `AuroraWriterActive` — 1.0 if writer, 0.0 if not, per region from describe_global_clusters
  - `AuroraEngineVersionMismatch` — 0 if local engine version matches global, 1 otherwise, for both regions
- Secret accessed by name `${project}/db-credentials` (LOCAL_SECRET_ARN and REMOTE_SECRET_ARN env vars)
- VPC-deployed with Lambda SG, reserved concurrency: 5, timeout: 2 min

### FR-8: DNS Status Lambda (Primary Region Only)

- NOT VPC-deployed (ARC API has no VPC endpoint)
- Runs every 1 minute via EventBridge
- Calls `arc-region-switch:ListRoute53HealthChecks` with planArn, hostedZoneId, recordName parameters
- Publishes `RegionDNSActive` metric (1.0 if healthy, 0.0 otherwise) per region to custom namespace
- Requires boto3 latest (bundled via requirements.txt: boto3>=1.38.0)
- Reserved concurrency: 1, timeout: 30s

### FR-9: VPC Infrastructure (Per Region)

- VPC with /23 CIDR, isolated subnets across 2 AZs (/24 each), no public subnets, no IGW, no NAT
- Non-overlapping CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23
- VPC peering between us-east-1 and us-west-2 (peering connection created in primary, accepted via CLI in Makefile)
- 8 VPC endpoints total:
  - 7 Interface (private DNS enabled): CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics, RDS
  - 1 Gateway: S3
- 5 Security groups (all allowAllOutbound: false):
  - ALB SG: inbound HTTP (80) from Synthetics SG + Lambda SG + cross-region peer CIDR
  - Database SG: inbound PostgreSQL (5432) from Lambda SG + cross-region peer CIDR
  - Lambda SG: inbound from ALB SG (80); egress to Database SG (5432), cross-region peer CIDR (5432), VPC Endpoint SG (443), ALB SG (80)
  - VPC Endpoint SG: inbound HTTPS (443) from Lambda SG + Synthetics SG
  - Synthetics SG: egress to local ALB SG (80), cross-region peer CIDR (80), VPC Endpoint SG (443), anyIpv4 (443 for S3 gateway)

### FR-10: Secrets Management

- Aurora master credentials auto-generated via `rds.Credentials.fromGeneratedSecret`
- Secret name: `${project}/db-credentials`
- Encrypted with regional KMS key
- Replicated to us-west-2 via ReplicaRegions property override on CfnSecret
- Lambda functions retrieve credentials from Secrets Manager at runtime by name

### FR-11: Private Hosted Zone and DNS Routing

- Route 53 private hosted zone (`demo.internal`) associated with both regional VPCs
- 3 DNS record groups (4 total record sets):
  - `aurora-app.demo.internal` — 2 latency-based A-alias records (SetIdentifier: PrimaryRegion/StandbyRegion, Region attribute), ARC health checks attached on second deployment pass
  - `aurora-app-use1.demo.internal` — simple A-alias to us-east-1 ALB
  - `aurora-app-usw2.demo.internal` — simple A-alias to us-west-2 ALB
- Health check IDs conditionally attached (spread operator, only if non-empty string)
- All alias targets use evaluateTargetHealth: true

### FR-12: ARC Region Switch Plan (Failover/Failback)

- AWS::ARCRegionSwitch::Plan with activeActive recovery approach
- PrimaryRegion: us-east-1, Regions: [us-east-1, us-west-2]
- Execution role for `arc-region-switch.amazonaws.com` with:
  - `iam:SimulatePrincipalPolicy` on own execution role ARN
  - arc-region-switch:GetPlan/GetPlanExecution/ListPlanExecutions on *
  - rds:DescribeGlobalClusters/DescribeDBClusters on *
  - rds:FailoverGlobalCluster/SwitchoverGlobalCluster on global cluster + both cluster ARNs
  - route53:ChangeResourceRecordSets/GetHostedZone/ListResourceRecordSets on hosted zone
  - route53:GetHealthCheck/UpdateHealthCheck on healthcheck/*
  - cloudwatch:DescribeAlarms/DescribeAlarmHistory/GetMetricStatistics on *
- Deactivate workflow: AuroraGlobalDatabase block (switchoverOnly, ungraceful: failover, 20min timeout) → Route53HealthCheck block (5min timeout)
- Activate workflow: Route53HealthCheck block (restore DNS, 5min timeout)
- Two-phase deployment: deploy DNS → deploy plan → capture ARC health check IDs → re-deploy DNS with health checks

### FR-13: CodeBuild Bootstrap

- Single CDK stack deployed locally that creates CodeBuild project
- Source uploaded via CDK BucketDeployment asset (excludes .git, node_modules, cdk.out, cdk.out.*, dist, .specs)
- CodeBuild triggered via Lambda-backed custom resource (onEvent starts build, isComplete polls status, 30s poll interval, 60min total timeout)
- Artifact bucket encrypted with local CMK (key rotation enabled)
- CodeBuild role scoped to: sts:AssumeRole on cdk-*, cloudformation:DescribeStacks/ListStacks/DescribeStackResources, ssm:GetParameter on cdk-bootstrap/*, ec2/rds describe ops, arc-region-switch list ops
- buildspec.yml: npm ci, aws-cdk + ts-node global install, pip install Lambda deps (iterates schema-migration, aurora-app, rpo-monitor, reconciliation, loadgen, dns-status — installs if requirements.txt exists), make deploy
- CodeBuild image: aws/codebuild/standard:7.0, SMALL compute, 60-min timeout

### FR-14: GitHub Actions CI/CD

- `aurora-build.yml`: compile + test + synth on pushes to non-main branches touching aurora/**
- `aurora-e2e.yml`: deploy all stacks via bootstrap, verify canaries, run load test + ARC failover exercise (4-step: deactivate e1 → activate e1 → deactivate w2 → activate w2), cleanup on success. 2h session (role-duration-seconds: 7200), account 563688183446
- `aurora-cleanup.yml`: manual trigger only, runs cleanup.sh
- AWS OIDC authentication (id-token: write, contents: read)

### FR-15: Projen Project Management

- AwsCdkTypeScriptApp with npm package manager
- GitHub workflow generation disabled (monorepo — workflows managed at repo root)
- Jest configuration managed by projen
- cdk-nag as dependency

### FR-16: Makefile Orchestration

- Parallel deploy targets using separate `-o cdk.out.*` directories
- Deployment order respects cross-stack dependencies
- Shell-based variable capture via `aws cloudformation describe-stacks`
- PID-based `wait` for parallel failure propagation
- VPC peering acceptance + secondary route creation via AWS CLI in Makefile
- cleanup.sh for reliable teardown (reverse order, global cluster detach with 60s wait)

### FR-17: Chaos Engineering (Amazon FIS)

- 2 FIS experiment templates per region (4 total):
  - Cross-region network disruption: `aws:network:route-table-disrupt-cross-region-connectivity` on subnets tagged ChaosAllowed=true
  - Aurora cluster failover: `aws:rds:failover-db-cluster` on clusters tagged ChaosAllowed=true
- FIS experiment IAM role with ec2 describe/create/delete, rds failover/reboot, tag:GetResources, logs permissions
- FIS log group (KMS encrypted, 7-day retention)
- Default duration: PT20M
- experimentOptions: single-account targeting, skip empty target resolution
- ChaosStack receives `targetRegion` (opposite region) for network disruption

### FR-18: Post-Failover Reconciliation

- Snapshot & Copy SSM Document: copies a source snapshot cross-region
- Restore & Reconcile SSM Document: restores snapshot into temporary cluster, creates instance (db.t4g.medium), waits for availability, invokes reconciliation Lambda
- Reconciliation Lambda (Python 3.12, VPC-deployed): connects to restored snapshot cluster and target primary, compares order IDs, produces missing transaction report (capped at 100 IDs per direction)
- SSM Automation role: ssm.amazonaws.com, with lambda:InvokeFunction, rds:RestoreDBClusterFromSnapshot/DescribeDBClusterSnapshots/DescribeDBClusters/CreateDBInstance/DescribeDBInstances/DeleteDBCluster/DeleteDBInstance, kms:Decrypt/CreateGrant/DescribeKey
- Reconciliation Lambda: reserved concurrency 5, timeout 10 min

### FR-19: Load Generation

- Load generation Lambda (Python 3.12, 15-min timeout, 512MB, reserved concurrency 10)
- Configurable via event: rps, duration, target, operation mix (insert,query,update,delete percentages)
- Publishes CloudWatch metrics to `${project}/LoadTest` namespace: RequestsSent, Errors, AvgLatency, P99Latency
- SSM Automation Document: async Lambda invocation via aws:executeScript (InvocationType=Event) + aws:sleep for duration
- VPC-deployed with Lambda SG, AURORA_ALB_DNS env var

### FR-20: Security Compliance

- cdk-nag AwsSolutionsChecks enabled via `-c nag=true` in bin/app.ts
- Global NagSuppressions applied per stack: IAM4, IAM5, L1, RDS10, RDS11, SMG4
- Checkov `.checkov.yaml` at project root with documented skip rules (CKV_AWS_116, CKV_AWS_173)

## Non-Functional Requirements

### NFR-1: Infrastructure as Code

- All infrastructure defined in CDK (TypeScript)
- Projen for project configuration management
- Makefile for cross-region deployment orchestration
- No manual console steps for deployment

### NFR-2: Security

- Aurora clusters encrypted with customer-managed KMS keys (rotation enabled)
- SNS topics encrypted with KMS
- VPC-deployed Lambdas in isolated subnets (no public subnets, no IGW, no NAT)
- All AWS API calls routed through VPC endpoints (except DNS Status Lambda which is not VPC-deployed)
- Least-privilege IAM roles
- Lambda reserved concurrency limits on all functions
- No hardcoded credentials
- cdk-nag compliance (all findings suppressed with justifications)
- Security groups with minimal ingress/egress rules, all allowAllOutbound: false
- S3 buckets: block public access, enforce SSL

### NFR-3: Reproducibility

- Deployable end-to-end with no local state
- Parameterized (project name, regions, account ID via CDK context)
- Clean teardown via cleanup.sh

### NFR-4: CDK Assertion Tests

- Jest-based tests using aws-cdk-lib/assertions
- 79 tests across 13 suites
- Unit tests per stack verifying CloudFormation template correctness
- Run via `npx projen test`

### NFR-5: Latest Runtimes and Versions

- Lambda runtime: Python 3.12
- Aurora PostgreSQL: 16.6
- Synthetics runtime: syn-python-selenium-10.0
- CodeBuild image: aws/codebuild/standard:7.0
- psycopg2-binary: 2.9.10
- Pin versions explicitly for reproducibility

## Out of Scope

- **RDS Proxy** — connection pooling layer between Lambda and Aurora; not needed for demo-scale traffic
- **Application-level connection pooling** — Lambda handles short-lived connections; no pgBouncer or similar
- **Custom domain with public DNS** — uses private hosted zone only; no Route 53 public zone or domain registration
- **Multi-account deployment** — single AWS account assumed for both regions
