# Requirements: Aurora Global Database + Aurora DSQL — Multi-Region Resilience Demo

## Purpose

Demonstrate Aurora Global Database and Aurora DSQL multi-region resilience patterns — deployed via CDK (TypeScript) with GitHub Actions CI/CD, CloudWatch observability, RPO monitoring, and a test application that exercises stored procedures for CRUD operations.

## Functional Requirements

### FR-1: Aurora Global Database (PostgreSQL)

- Aurora PostgreSQL Global Database spanning us-east-1 (primary) and us-west-2 (secondary)
- Primary cluster in us-east-1 with one writer instance
- Secondary cluster in us-west-2 with one reader instance
- Storage-based replication (typically <1s lag)
- Encrypted with customer-managed KMS key per region
- Deletion protection enabled (configurable for E2E teardown)
- Automated backups with configurable retention

### FR-2: Aurora DSQL

- Aurora DSQL cluster in us-east-1 (primary) and us-west-2 (witness/linked)
- Multi-region active-active configuration
- Automatic conflict resolution
- IAM-based authentication (no static database credentials)
- Encrypted at rest and in transit

### FR-3: Test Applications (Lambda-based, ALB-fronted)

Two separate applications, each behind its own Application Load Balancer:

#### Aurora Global Database Application
- Lambda functions deployed in both regions behind an internal ALB
- ALB with HTTP listener in isolated subnets
- Target group with Lambda integration
- Private hosted zone DNS record (e.g., `aurora-app.demo.internal`) pointing to active-region ALB
- Endpoints:
  - `POST /orders` — calls `sp_insert_order`
  - `PUT /orders/{id}/status` — calls `sp_update_order_status`
  - `DELETE /orders/{id}` — calls `sp_delete_order`
  - `GET /orders` — calls `sp_query_orders` (query params: region, status, since)
  - `GET /health` — connectivity check
- Connects to Aurora Global Database (primary writer, secondary reader)
- Deployed in isolated subnets, accesses AWS services via VPC endpoints only

#### Aurora DSQL Application
- Lambda functions deployed in both regions behind a separate internal ALB
- ALB with HTTP listener in isolated subnets
- Target group with Lambda integration
- Private hosted zone DNS record (e.g., `dsql-app.demo.internal`) pointing to active-region ALB
- Endpoints:
  - `POST /orders` — calls `sp_insert_order`
  - `PUT /orders/{id}/status` — calls `sp_update_order_status`
  - `DELETE /orders/{id}` — calls `sp_delete_order`
  - `GET /orders` — calls `sp_query_orders` (query params: region, status, since)
  - `GET /health` — connectivity check
- Connects to Aurora DSQL endpoint with IAM authentication (no stored secrets)
- Deployed in isolated subnets, accesses AWS services via VPC endpoints only

### FR-3a: CloudWatch Synthetics Testing

- CloudWatch Synthetics canaries deployed in both regions
- Separate canary per application (Aurora Global DB canary, DSQL canary)
- Local canaries: call same-region ALB HTTP endpoints
- Cross-region canaries: call opposite-region ALB HTTP endpoints (us-east-1 canary → us-west-2 ALB, and vice versa)
- Four canaries per region: aurora-local, aurora-cross, dsql-local, dsql-cross
- Canary scripts exercise all CRUD endpoints and validate HTTP response codes and payloads
- Runs on configurable schedule (e.g., every 5 minutes)
- Canary artifacts (logs, screenshots, HAR files) stored in S3 (KMS encrypted)
- CloudWatch alarms on canary success rate per canary (local + cross-region)
- Cross-region canaries require VPC peering or Transit Gateway for private ALB connectivity
- All testing flows through Synthetics → ALB → Lambda → Database

### FR-4: Database Schema

- Orders table with: id (UUID), region (VARCHAR), status (VARCHAR), payload (JSONB), created_at (TIMESTAMPTZ), updated_at (TIMESTAMPTZ), deleted_at (TIMESTAMPTZ)
- Replication tracking table: id (UUID), source_region (VARCHAR), txn_id (BIGINT), committed_at (TIMESTAMPTZ), replicated_at (TIMESTAMPTZ)
- Schema deployed via Lambda-backed custom resource on stack creation
- Stored procedures created as part of schema migration

### FR-5: CloudWatch Alarms (Per Region)

- AuroraReplicaLag alarm (threshold: 1000ms for Global Database)
- AuroraReplicaLagMaximum alarm (threshold: 2000ms)
- DatabaseConnections alarm (threshold: configurable)
- CPUUtilization alarm (threshold: 80%)
- FreeableMemory alarm (threshold: configurable low-water mark)
- CommitLatency alarm (threshold: configurable)
- All alarms use "treat missing data as ignore"
- All alarms notify via SNS topic (ALARM + OK actions)
- SNS topics encrypted with KMS

### FR-6: CloudWatch Dashboard (Per Region)

- Regional dashboard showing:
  - RPO replication lag (AuroraReplicaLag metric) — line graph with threshold annotation
  - AuroraReplicaLagMaximum — peak lag tracking
  - RPO time series: CatalogMissingRows from both regions — line graph with FILL(REPEAT). Safe because each datapoint is an atomic cross-region comparison, not a one-sided count. Flat line during outage = stale but honest.
  - RPO single value: CatalogMissingRows latest from each region — quick glance current state, no FILL
  - Heartbeat time series: CatalogRPOHeartbeat from both regions — no FILL. Gaps out immediately when Lambda stops. This is the staleness indicator. Operator sees "RPO = 3" + heartbeat gap = "that number is stale"
  - Database connections (active, max)
  - CPU utilization
  - Commit latency (average, p99)
  - Freeable memory
  - Read/write IOPS
- Cross-region metric references for comparing primary vs secondary

### FR-7: RPO Monitoring — Replication Lag Metrics

- CloudWatch metrics sourced from Aurora's native AuroraReplicaLag metric
- Dashboard visualization of lag over time with threshold annotations
- Alarm on sustained lag above threshold

### FR-7a: Enhanced RPO Monitoring — Unreplicated Transaction Tracking

- Single Lambda function deployed to both regions, runs every 5 minutes via EventBridge schedule
- Each invocation connects to local Aurora (reader) and remote Aurora (reader/writer) in a single call
- Compares row IDs across relevant tables (orders, replication_tracking)
- Computes delta: "rows the remote has that I don't" (unreplicated rows from the local region's perspective)
- Publishes `CatalogMissingRows` custom CloudWatch metric — the computed delta count
- Publishes `CatalogRPOHeartbeat` custom CloudWatch metric (value=1) confirming the check ran successfully
- VPC-deployed with security group access to both local and remote Aurora endpoints
- Cross-region database connectivity: local reader endpoint + remote reader/writer endpoint
- Secrets Manager access for database credentials in both regions
- Reserved concurrency: 5

### FR-8: VPC Infrastructure (Per Region)

- VPC with isolated subnets across 2 AZs (no public subnets, no IGW, no NAT)
- Isolated subnets: ALBs, Lambdas, Aurora clusters (all in same tier — no internet route needed)
- VPC peering between us-east-1 and us-west-2 VPCs for cross-region canary → ALB connectivity
  - Non-overlapping CIDR ranges (e.g., 10.0.0.0/23 us-east-1, 10.0.2.0/23 us-west-2)
  - Route table entries for cross-region CIDR via peering connection
- VPC endpoints (Interface) for: CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics, Elastic Load Balancing
- VPC endpoint (Gateway) for: S3
- All Lambda functions deployed in isolated subnets, communicate with AWS services exclusively via VPC endpoints
- Security groups:
  - ALB SG: allows inbound HTTP (80) from local Synthetics SG and from cross-region Synthetics CIDR  - Database SG: allows inbound PostgreSQL (5432) from Lambda SG
  - Lambda SG: allows inbound from ALB SG, outbound to Database SG and VPC Endpoint SG (HTTPS 443)
  - VPC Endpoint SG: allows inbound HTTPS (443) from Lambda SG
  - Synthetics SG: allows outbound HTTP (80) to local ALB SG and cross-region ALB CIDR
- Subnet groups for Aurora clusters

### FR-9: Secrets Management

- Aurora Global Database master credentials stored in Secrets Manager
- Secret encrypted with regional KMS key
- Secret rotation enabled (30-day interval)
- Lambda functions retrieve credentials from Secrets Manager at runtime
- DSQL uses IAM authentication (no stored secrets)

### FR-10: Private Hosted Zone and DNS Routing

- Route 53 private hosted zone (`demo.internal`) associated with both regional VPCs
- Latency-based routing records for each application:
  - `aurora-app.demo.internal` — latency-based A-alias records pointing to each region's Aurora app ALB
  - `dsql-app.demo.internal` — latency-based A-alias records pointing to each region's DSQL app ALB
- Each record set has a SetIdentifier (PrimaryRegion, StandbyRegion) and Region attribute
- ARC-managed Route 53 health checks attached to records after ARC plan creation (two-phase deployment)
- Canaries resolve DNS names; latency routing + health checks direct traffic to healthy region

### FR-11: ARC Region Switch Plan (Failover/Failback)

- AWS::ARCRegionSwitch::Plan resource with activePassive recovery
- Uses ARC native execution block types (no custom failover Lambda):
  - `AuroraGlobalDatabase` block: performs managed switchover/failover of Aurora Global Database
    - `Behavior: switchoverOnly` for graceful switchover
    - `Ungraceful: failover` for ungraceful failover when primary is unavailable
  - `Route53HealthCheck` block: toggles ARC-managed health checks to shift DNS traffic
    - References hosted zone ID, record name, and both regional record set identifiers
- Execution role for `arc-region-switch.amazonaws.com` with permissions for:
  - `rds:FailoverGlobalCluster`, `rds:SwitchoverGlobalCluster`, `rds:DescribeGlobalClusters`, `rds:DescribeDBClusters`
  - `route53:ChangeResourceRecordSets`, `route53:GetHostedZone`, `route53:ListResourceRecordSets`
  - `route53:GetHealthCheck`, `route53:UpdateHealthCheck`
  - `arc-region-switch:GetPlan`, `arc-region-switch:GetPlanExecution`
- Deactivate workflow: failover Aurora Global DB → shift DNS away from deactivated region
- Activate workflow: restore DNS traffic to re-activated region
- Two-phase deployment: deploy DNS records first without health checks, then wire ARC health check IDs after plan creation

### FR-12: CodeBuild Bootstrap

- Single CDK stack deployed locally that creates CodeBuild project
- Source uploaded automatically via CDK BucketDeployment asset
- CodeBuild triggered automatically via Lambda-backed custom resource
- `cdk deploy` blocks until CodeBuild completes all child stack deployments
- Cleanup via standalone cleanup.sh script (not CodeBuild)
- Minimizes local dependencies to: AWS CLI, CDK, Node
- Artifact bucket encrypted with local CMK
- CodeBuild role scoped to sts:AssumeRole on cdk-* roles + cloudformation:DescribeStacks
- buildspec.yml runs `npm ci && make deploy`

### FR-13: GitHub Actions CI/CD

- Build workflow: triggers on push to non-main branches (path filter: `aurora-dsql/**`), runs compile + test + synth
- E2E workflow: triggers on PRs + manual, deploys all stacks, runs Synthetics canaries, verifies replication and metrics, cleans up on success
- Cleanup workflow: manual trigger only, runs cleanup.sh
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
- Unit tests per stack verifying CloudFormation template correctness
- Integration tests verifying cross-stack consistency
- Run via `npx projen test`

### NFR-5: Latest Runtimes and Versions

- Use latest stable CDK version
- Lambda runtime: Python 3.13 (or latest available)
- Aurora PostgreSQL: latest supported engine version
- Aurora DSQL: latest available
- CodeBuild image: aws/codebuild/standard:7.0 (or latest)
- Synthetics runtime: latest available (syn-python-selenium-*)
- Node.js: latest LTS for CDK toolchain
- Pin versions explicitly in package.json and buildspec to ensure reproducibility

### NFR-6: Test-First Development

- Every phase must have passing tests before it is considered complete
- CDK assertion tests written alongside stack code, not deferred
- Tests must cover: resource existence, property correctness, IAM permissions, cross-stack references
- Lambda handler logic tested locally where possible (unit tests with mocked AWS SDK calls)
- Canary scripts validated locally before deployment
- Deployment is expensive and time-consuming — catch bugs locally first
- CI build workflow gates on all tests passing before synth
- No phase is "done" unless `npx projen test` passes clean

### NFR-7: Test Coverage Strategy

- CDK assertion tests: every stack gets a test file verifying template output
- Cross-stack integration tests: verify endpoint consistency, security group references, DNS → ALB mapping
- Lambda unit tests: mock database connections and AWS SDK, verify handler logic (CRUD routing, error handling, metric publishing)
- Canary script tests: validate request construction and response parsing logic offline
- Makefile dry-run validation: verify deployment ordering without actual AWS calls where feasible

### FR-16: Chaos Engineering (Amazon FIS)

- FIS experiment templates deployed in both regions
- Experiment scenarios relevant to this architecture:
  - **Cross-region network disruption**: Disrupt subnet cross-region connectivity (blocks VPC peering traffic, simulates region isolation)
  - **Aurora failover**: Force Aurora DB cluster failover within a region (tests application reconnection)
  - **Aurora Global Database detach**: Simulate loss of replication by disrupting cross-region connectivity to Aurora
- FIS experiment IAM role scoped to account with least-privilege policies
- FIS experiment log group (KMS encrypted, 7-day retention)
- ChaosAllowed tags on target resources (subnets, DB clusters) to control blast radius
- Stop conditions: none (manual stop or duration-based auto-stop)
- Configurable duration parameter (default: 20 minutes)
- Experiments triggerable via CLI (`aws fis start-experiment`) or SSM Automation Document

## Out of Scope

- **RDS Proxy** — connection pooling layer between Lambda and Aurora; not needed for demo-scale traffic
- **Application-level connection pooling** — Lambda handles short-lived connections; no pgBouncer or similar
- **Automated reconciliation** — no automated comparison of pre/post-failover data (manual inspection only)
- **Custom domain with public DNS** — uses private hosted zone only; no Route 53 public zone or domain registration
- **Multi-account deployment** — single AWS account assumed for both regions
