# Requirements: Aurora Global Database — Multi-Region Resilience Demo

## Functional Requirements

### FR-1: Aurora Global Database (PostgreSQL)

- Aurora PostgreSQL 16.6 Global Database spanning us-east-1 (primary) and us-west-2 (secondary)
- Primary cluster in us-east-1 with one writer instance (db.r6g.large)
- Secondary cluster in us-west-2 with one reader instance (db.r6g.large)
- Storage-based replication (typically <1s lag)
- Encrypted with customer-managed KMS key per region
- Deletion protection enabled (configurable for E2E teardown)
- Automated backups with configurable retention

### FR-2: Test Application (Lambda-based, ALB-fronted)

- Single Aurora app deployed in both regions behind internal ALBs
- ALB with HTTP listener (port 80) in isolated subnets
- Lambda target group integration
- Endpoints:
  - `POST /orders` — calls `sp_insert_order`
  - `PUT /orders/{id}/status` — calls `sp_update_order_status`
  - `DELETE /orders/{id}` — calls `sp_delete_order`
  - `GET /orders` — calls `sp_query_orders` (query params: region, status, since)
  - `GET /health` — connectivity check
- Primary region connects to Aurora writer endpoint
- Secondary region uses `DB_HOST_OVERRIDE` to connect to reader endpoint
- Secret replicated to us-west-2 for cross-region credential access
- Deployed in isolated subnets, accesses AWS services via VPC endpoints only
- Reserved concurrency: 5, timeout: 60s

### FR-3: CloudWatch Synthetics Testing

- 3 CloudWatch Synthetics canaries per region (6 total), all read-only (health + query):
  - `al` (local) — hits region-aligned record for own region (e.g., `aurora-app-use1.demo.internal`)
  - `ar` (remote) — hits region-aligned record for opposite region (e.g., `aurora-app-usw2.demo.internal`) via VPC peering
  - `ad` (dns) — hits `aurora-app.demo.internal` (ARC-managed latency-based routing)
- Runtime: syn-python-selenium-10.0
- Runs on configurable schedule (every 5 minutes)
- Canary artifacts (logs, screenshots, HAR files) stored in S3 (KMS encrypted)
- CloudWatch alarm on canary SuccessPercent per canary (threshold: 100%)
- Cross-region canaries require VPC peering for private ALB connectivity
- All testing flows through Synthetics → ALB → Lambda → Database

### FR-4: Database Schema

- Orders table with: id (UUID), region (VARCHAR), status (VARCHAR), payload (JSONB), created_at (TIMESTAMPTZ), updated_at (TIMESTAMPTZ), deleted_at (TIMESTAMPTZ)
- Replication tracking table: id (UUID), source_region (VARCHAR), txn_id (BIGINT), committed_at (TIMESTAMPTZ), replicated_at (TIMESTAMPTZ)
- Schema deployed via Lambda-backed custom resource on stack creation
- 4 stored procedures: sp_insert_order, sp_update_order_status, sp_delete_order, sp_query_orders
- Idempotent (CREATE OR REPLACE for procedures, IF NOT EXISTS for tables)

### FR-5: CloudWatch Alarms (Per Region)

8 alarms total per region:
- AuroraReplicaLag (threshold: 1000ms)
- AuroraReplicaLagMaximum (threshold: 2000ms)
- CPUUtilization (threshold: 80%)
- FreeableMemory (threshold: 256MB low-water mark)
- CommitLatency (threshold: 100ms)
- CatalogMissingRows (threshold: 10, 2 evaluation periods)
- CatalogRPOHeartbeat (threshold: 1, treat missing as breaching)
- AuroraEngineVersionMismatch (threshold: 1, fires on mismatch)
- All alarms notify via SNS topic (ALARM + OK actions)
- SNS topics encrypted with KMS

### FR-6: CloudWatch Dashboard (Per Region)

- Aurora Replica Lag (ms) — line graph with threshold annotation
- RPO: Missing Rows (CatalogMissingRows from both regions) — line graph with FILL(REPEAT)
- RPO: Current Missing Rows — single value widget, no FILL
- RPO: Heartbeat (CatalogRPOHeartbeat from both regions) — no FILL, gaps immediately when Lambda stops
- CPU Utilization (%)
- Commit Latency (avg + p99)
- Freeable Memory (bytes)
- Aurora Engine Version Alignment — single value widget (0 = aligned, 1 = mismatch)
- Cross-region metric references for comparing primary vs secondary

### FR-7: RPO Monitoring — Enhanced Unreplicated Transaction Tracking

- Single RPO monitor Lambda deployed to both regions, runs every 5 minutes via EventBridge
- Each invocation connects to local Aurora (reader) and remote Aurora (reader/writer)
- Compares row IDs across tables, computes delta ("rows remote has that I don't")
- Publishes `CatalogMissingRows` custom CloudWatch metric (delta count)
- Publishes `CatalogRPOHeartbeat` custom CloudWatch metric (value=1) confirming check ran
- Checks engine versions across clusters, publishes `AuroraEngineVersionMismatch` metric
- VPC-deployed with security group access to both local and remote Aurora endpoints
- Secrets Manager access for database credentials in both regions
- Reserved concurrency: 5

### FR-8: VPC Infrastructure (Per Region)

- VPC with /23 CIDR, isolated subnets across 2 AZs (no public subnets, no IGW, no NAT)
- Non-overlapping CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23
- Isolated subnets (/24 each): ALBs, Lambdas, Aurora clusters all in same tier
- VPC peering between us-east-1 and us-west-2 for cross-region canary → ALB connectivity
- 7 VPC endpoints:
  - Interface: CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics
  - Gateway: S3
- Security groups:
  - ALB SG: inbound HTTP (80) from local Synthetics SG and cross-region Synthetics CIDR
  - Database SG: inbound PostgreSQL (5432) from Lambda SG
  - Lambda SG: inbound from ALB SG, outbound to Database SG and VPC Endpoint SG (443)
  - VPC Endpoint SG: inbound HTTPS (443) from Lambda SG and Synthetics SG
  - Synthetics SG: outbound HTTP (80) to local ALB SG and cross-region ALB CIDR, outbound HTTPS (443) to VPC endpoints

### FR-9: Secrets Management

- Aurora master credentials stored in Secrets Manager
- Secret encrypted with regional KMS key
- Secret rotation enabled (30-day interval)
- Secret replicated to us-west-2 for cross-region app access
- Lambda functions retrieve credentials from Secrets Manager at runtime

### FR-10: Private Hosted Zone and DNS Routing

- Route 53 private hosted zone (`demo.internal`) associated with both regional VPCs
- Three DNS record types:
  - `aurora-app.demo.internal` — latency-based A-alias records (regionless, ARC health checks attached)
  - `aurora-app-use1.demo.internal` — simple A-alias to us-east-1 ALB (region-aligned)
  - `aurora-app-usw2.demo.internal` — simple A-alias to us-west-2 ALB (region-aligned)
- Latency-based records use SetIdentifier (PrimaryRegion, StandbyRegion) and Region attribute
- ARC-managed Route 53 health checks attached in second deployment pass (two-phase deployment)

### FR-11: ARC Region Switch Plan (Failover/Failback)

- AWS::ARCRegionSwitch::Plan with activeActive recovery
- Uses ARC native execution block types:
  - `AuroraGlobalDatabase` block: managed switchover/failover of Aurora Global Database
    - `Behavior: switchoverOnly` for graceful switchover
    - `Ungraceful: failover` for ungraceful failover when primary is unavailable
  - `Route53HealthCheck` block: toggles ARC-managed health checks to shift DNS traffic
- Execution role for `arc-region-switch.amazonaws.com` with permissions for RDS, Route 53, ARC
- Deactivate workflow: failover Aurora Global DB → shift DNS away
- Activate workflow: restore DNS traffic to re-activated region
- Two-phase deployment: deploy DNS records first without health checks, then wire ARC health check IDs after plan creation

### FR-12: CodeBuild Bootstrap

- Single CDK stack deployed locally that creates CodeBuild project
- Source uploaded via CDK BucketDeployment asset
- CodeBuild triggered via Lambda-backed custom resource (onEvent + isComplete, 30s poll, 30min timeout)
- `cdk deploy` blocks until CodeBuild completes all child stack deployments
- Artifact bucket encrypted with local CMK
- CodeBuild role scoped to sts:AssumeRole on cdk-* roles + cloudformation:DescribeStacks
- buildspec.yml runs `npm ci && make deploy`

### FR-13: GitHub Actions CI/CD

- Build workflow: compile + test + synth on pushes
- E2E workflow: deploy all stacks, run Synthetics, verify replication and metrics, cleanup on success
- Cleanup workflow: manual trigger only
- AWS OIDC authentication (no long-lived credentials)

### FR-14: Projen Project Management

- AwsCdkTypeScriptApp with npm package manager
- GitHub workflow generation disabled (monorepo — workflows managed at repo root)
- Jest configuration managed by projen
- cdk-nag as dependency

### FR-15: Makefile Orchestration

- Parallel deploy targets using separate cdk.out directories
- Deployment order respects cross-stack dependencies
- Shell-based variable capture for sequential steps
- PID-based wait for parallel failure propagation
- cleanup.sh for reliable teardown

### FR-16: Chaos Engineering (Amazon FIS)

- FIS experiment templates deployed in both regions:
  - Cross-region network disruption: `aws:network:route-table-disrupt-cross-region-connectivity` on subnets
  - Aurora cluster failover: `aws:rds:failover-db-cluster` on Aurora DB cluster
- FIS experiment IAM role scoped with least-privilege policies
- FIS log group (KMS encrypted, 7-day retention)
- ChaosAllowed tags on target resources (subnets, DB clusters)
- Configurable duration (default: 20 minutes)

### FR-17: Post-Failover Reconciliation

- Snapshot & Copy SSM Document (primary region): takes Aurora cluster snapshot, copies cross-region with KMS encryption
- Restore & Reconcile SSM Document (standby region): restores snapshot into temporary cluster, invokes reconciliation Lambda
- Reconciliation Lambda (Python, VPC-deployed): connects to restored snapshot cluster and new primary, compares order IDs, produces missing transaction report
- IAM roles scoped to RDS snapshot/restore/describe, KMS, Lambda invoke
- Reserved concurrency: 5

### FR-18: Load Generation

- Load generation Lambda (Python 3.12, 15-min timeout, 512MB, reserved concurrency 10)
- Configurable: RPS, duration, operation mix, target app
- Publishes CloudWatch metrics: requests sent, errors, latency (avg/p50/p99)
- SSM Automation Document with named String parameters for operator invocation
- VPC-deployed with access to ALB endpoints

### FR-19: Security Compliance

- cdk-nag AwsSolutionsChecks enabled via `-c nag=true` in bin/app.ts
- Global NagSuppressions applied per stack with justification strings
- Checkov `.checkov.yaml` at project root with documented skip rules
- MIT-0 LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md

## Non-Functional Requirements

### NFR-1: Infrastructure as Code

- All infrastructure defined in CDK (TypeScript)
- Projen for project configuration management
- Makefile for cross-region deployment orchestration
- No manual console steps for deployment

### NFR-2: Security

- Aurora clusters encrypted with customer-managed KMS keys
- SNS topics encrypted with KMS
- VPC-deployed Lambdas in isolated subnets (no public subnets, no IGW, no NAT)
- All AWS API calls routed through VPC endpoints
- Least-privilege IAM roles
- iam:PassRole conditioned on iam:PassedToService
- Lambda reserved concurrency limits
- No hardcoded credentials
- cdk-nag compliance (all findings suppressed with justifications)
- Security groups with minimal ingress/egress rules

### NFR-3: Reproducibility

- Deployable end-to-end with no local state
- Parameterized (project name, regions)
- Clean teardown via cleanup.sh

### NFR-4: CDK Assertion Tests

- Jest-based tests using aws-cdk-lib/assertions
- 78 tests across 13 suites
- Unit tests per stack verifying CloudFormation template correctness
- Run via `npx projen test`

### NFR-5: Latest Runtimes and Versions

- Lambda runtime: Python 3.12
- Aurora PostgreSQL: 16.6
- Synthetics runtime: syn-python-selenium-10.0
- CodeBuild image: aws/codebuild/standard:7.0
- Pin versions explicitly for reproducibility

### NFR-6: Test-First Development

- Every phase must have passing tests before it is considered complete
- CDK assertion tests written alongside stack code, not deferred
- No phase is "done" unless `npx projen test` passes clean

## Out of Scope

- **RDS Proxy** — connection pooling layer between Lambda and Aurora; not needed for demo-scale traffic
- **Application-level connection pooling** — Lambda handles short-lived connections; no pgBouncer or similar
- **Custom domain with public DNS** — uses private hosted zone only; no Route 53 public zone or domain registration
- **Multi-account deployment** — single AWS account assumed for both regions
