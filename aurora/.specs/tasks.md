# Tasks: Aurora Global Database — Multi-Region Resilience Demo

**RULE: No phase is complete until its tests pass.** Every phase that produces a CDK stack or Lambda handler
must have corresponding tests written and passing (`npx projen test`) before moving to the next phase.

## Phase 1: Project Setup

- [x] 1.1 Initialize projen AwsCdkTypeScriptApp with npm, github: false
- [x] 1.2 Configure cdk.json, tsconfig.json, package.json (projen-managed)
- [x] 1.3 Create .gitignore (projen-managed + sensitive file patterns)
- [x] 1.4 Create project README.md (architecture, prerequisites, usage)

## Phase 2: Bootstrap Stack (CodeBuild)

- [x] 2.1 Create lib/bootstrap-stack.ts — CodeBuild project, local CMK, scoped IAM role, artifact bucket, source upload, build trigger
- [x] 2.2 Create buildspec.yml — npm ci, ts-node install, make deploy
- [x] 2.3 Create lambda/build-trigger/index.py — starts CodeBuild, polls for completion (onEvent + isComplete, 30s poll, 30min timeout)
- [x] 2.4 Wire BootstrapStack in bin/app.ts
- [x] ✅ Tests pass: bootstrap.test.ts

## Phase 3: VPC Stack (Per Region)

- [x] 3.1 Create lib/vpc-stack.ts — VPC with 2 AZs, isolated subnets only, no public, no IGW, no NAT
- [x] 3.2 Non-overlapping /23 CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23 (/24 subnets)
- [x] 3.3 VPC Interface endpoints: CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics
- [x] 3.4 VPC Gateway endpoint: S3
- [x] 3.5 Security groups: ALB, Database, Lambda, VPC Endpoint, Synthetics (with cross-region CIDR rules)
- [x] 3.6 Wire VpcStack (x2 regions) in bin/app.ts
- [x] ✅ Tests pass: vpc.test.ts

## Phase 4: VPC Peering Stack

- [x] 4.1 Create lib/vpc-peering-stack.ts — cross-region VPC peering connection
- [x] 4.2 Route table entries in both VPCs: cross-region CIDR → peering connection
- [x] 4.3 Wire VpcPeeringStack in bin/app.ts (depends on both VpcStacks)
- [x] ✅ Tests pass: database.test.ts (peering verified in database tests)

## Phase 5: Aurora Global Database Stack

- [x] 5.1 Create lib/database-stack.ts — Global Database, primary Aurora cluster (PostgreSQL 16.6), db.r6g.large writer, KMS key
- [x] 5.2 Master credentials in Secrets Manager (auto-generated, KMS-encrypted, 30-day rotation)
- [x] 5.3 Subnet group using isolated subnets, database SG from VpcStack
- [x] 5.4 Create lib/database-replica-stack.ts — secondary cluster joined to Global Database, db.r6g.large reader
- [x] 5.5 Wire DatabaseStack + DatabaseReplicaStack in bin/app.ts
- [x] ✅ Tests pass: database.test.ts + database-replica.test.ts

## Phase 6: Schema Migration Stack

- [x] 6.1 Create lambda/schema-migration/index.py — creates tables, indexes, stored procedures
- [x] 6.2 Stored procedures: sp_insert_order, sp_update_order_status, sp_delete_order, sp_query_orders
- [x] 6.3 Create lib/schema-stack.ts — Lambda-backed custom resource, VPC-deployed, DB SG access
- [x] 6.4 Idempotent migration (CREATE OR REPLACE, IF NOT EXISTS)
- [x] 6.5 Wire SchemaStack in bin/app.ts (depends on DatabaseStack)
- [x] ✅ Tests pass: schema.test.ts

## Phase 7: Aurora Application Stack (Per Region)

- [x] 7.1 Create lambda/aurora-app/index.py — CRUD handler (ALB target) calling stored procedures
- [x] 7.2 Routes: POST /orders, PUT /orders/{id}/status, DELETE /orders/{id}, GET /orders, GET /health
- [x] 7.3 Primary region connects to writer endpoint; secondary uses DB_HOST_OVERRIDE for reader endpoint
- [x] 7.4 Create lib/aurora-app-stack.ts — internal ALB (HTTP:80, isolated subnets) + Lambda target group
- [x] 7.5 Secret replicated to us-west-2 for cross-region access
- [x] 7.6 IAM role with Secrets Manager read, KMS decrypt
- [x] 7.7 Reserved concurrency: 5, timeout: 60s
- [x] 7.8 Wire AuroraAppStack (x2 regions) in bin/app.ts
- [x] ✅ Tests pass: aurora-app.test.ts

## Phase 8: DNS Stack

- [x] 8.1 Create lib/dns-stack.ts — Route 53 private hosted zone (`demo.internal`)
- [x] 8.2 Associate hosted zone with both regional VPCs
- [x] 8.3 Latency-based A-alias records: `aurora-app.demo.internal` (PrimaryRegion + StandbyRegion)
- [x] 8.4 Region-aligned simple A-alias records: `aurora-app-use1.demo.internal`, `aurora-app-usw2.demo.internal`
- [x] 8.5 Conditional health check attachment (empty on first deploy, wired on second pass)
- [x] 8.6 Wire DnsStack in bin/app.ts
- [x] ✅ Tests pass: dns.test.ts

## Phase 9: ARC Region Switch Plan

- [x] 9.1 Create lib/failover-plan-stack.ts — AWS::ARCRegionSwitch::Plan (activeActive)
- [x] 9.2 Execution role for arc-region-switch.amazonaws.com with rds, route53, arc-region-switch permissions
- [x] 9.3 Deactivate workflow: AuroraGlobalDatabase block (switchoverOnly, ungraceful: failover) → Route53HealthCheck block
- [x] 9.4 Activate workflow: Route53HealthCheck block (restore DNS traffic)
- [x] 9.5 Makefile two-phase deployment: deploy DNS → deploy plan → capture ARC health check IDs → re-deploy DNS with health checks
- [x] 9.6 Wire FailoverPlanStack in bin/app.ts
- [x] ✅ Tests pass: failover-plan.test.ts

## Phase 10: CloudWatch Synthetics Stack (Per Region)

- [x] 10.1 3 canaries per region, all read-only (health + query):
  - `al` (local) → region-aligned record for own region
  - `ar` (remote) → region-aligned record for opposite region (via VPC peering)
  - `ad` (dns) → `aurora-app.demo.internal` (ARC-managed routing)
- [x] 10.2 Runtime: syn-python-selenium-10.0
- [x] 10.3 CloudWatch alarm on canary SuccessPercent per canary (threshold: 100%)
- [x] 10.4 Canaries deployed in VPC with Synthetics SG
- [x] 10.5 Wire SyntheticsStack (x2 regions) in bin/app.ts
- [x] ✅ Tests pass: synthetics.test.ts

## Phase 11: Monitoring Stack (Per Region)

- [x] 11.1 Create lib/monitoring-stack.ts — CloudWatch alarms + dashboard + RPO monitor
- [x] 11.2 5 Aurora alarms: ReplicaLag, ReplicaLagMax, CPU, FreeMemory, CommitLatency
- [x] 11.3 2 RPO alarms: CatalogMissingRows, CatalogRPOHeartbeat
- [x] 11.4 1 engine version alarm: AuroraEngineVersionMismatch
- [x] 11.5 SNS alarm topic (KMS encrypted) — ALARM + OK actions
- [x] 11.6 RPO Monitor Lambda (Python 3.12, every 5 min): cross-region row comparison + heartbeat + engine version check
- [x] 11.7 Dashboard: replica lag, missing rows (FILL REPEAT), heartbeat (no FILL), CPU, commit latency, memory, engine version alignment
- [x] 11.8 Wire MonitoringStack (x2 regions) in bin/app.ts
- [x] ✅ Tests pass: monitoring.test.ts

## Phase 12: Reconciliation Stack

- [x] 12.1 Create lambda/reconciliation/index.py — connects to restored snapshot cluster + new primary, compares order IDs, returns missing transaction report
- [x] 12.2 Create lib/reconciliation-stack.ts — SSM Automation Documents (snapshot-copy + restore-reconcile)
- [x] 12.3 IAM roles: SSM Automation role (RDS snapshot/restore/describe, KMS, Lambda invoke), reconciliation Lambda role
- [x] 12.4 Reconciliation Lambda: VPC-deployed, reserved concurrency 5
- [x] 12.5 Wire ReconciliationStack in bin/app.ts
- [x] ✅ Tests pass: reconciliation.test.ts

## Phase 13: Load Generation Stack

- [x] 13.1 Create lambda/loadgen/index.py — sustained CRUD traffic against ALB, publishes CloudWatch metrics
- [x] 13.2 Create lib/loadgen-stack.ts — Lambda (15-min timeout, 512MB, reserved concurrency 10), VPC-deployed
- [x] 13.3 SSM Automation Document for operator invocation
- [x] 13.4 Wire LoadGenStack in bin/app.ts
- [x] ✅ Tests pass: loadgen.test.ts

## Phase 14: Chaos Engineering Stack (Per Region)

- [x] 14.1 Create lib/chaos-stack.ts — FIS experiment templates per region
- [x] 14.2 Cross-region network disruption: `aws:network:route-table-disrupt-cross-region-connectivity`
- [x] 14.3 Aurora cluster failover: `aws:rds:failover-db-cluster`
- [x] 14.4 FIS IAM role, KMS-encrypted log group (7-day retention), ChaosAllowed tags
- [x] 14.5 Wire ChaosStack (x2 regions) in bin/app.ts
- [x] ✅ Tests pass: chaos.test.ts

## Phase 15: Makefile Orchestration

- [x] 15.1 Create Makefile with parallel deploy targets using separate cdk.out directories
- [x] 15.2 PID-based wait for parallel failure propagation
- [x] 15.3 Shell-based variable capture for sequential steps
- [x] 15.4 Create cleanup.sh for reliable teardown (reverse order, global cluster detach before delete)

## Phase 16: Security Hardening & Open-Source Compliance

- [x] 16.1 Least-privilege IAM roles for all Lambdas
- [x] 16.2 Lambda reserved concurrency limits
- [x] 16.3 cdk-nag AwsSolutionsChecks opt-in via `-c nag=true`
- [x] 16.4 NagSuppressions per stack with justification strings
- [x] 16.5 Create .checkov.yaml with skip rules and justifications
- [x] 16.6 MIT-0 LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- [x] 16.7 No public subnets, no IGW, no NAT — all traffic via VPC endpoints

## Phase 17: GitHub Actions CI/CD

- [x] 17.1 Build workflow (compile + test + synth)
- [x] 17.2 E2E workflow (deploy + verify + cleanup)
- [x] 17.3 Cleanup workflow (manual trigger)
- [x] 17.4 AWS OIDC authentication
- [x] 17.5 Status badges in repo root README

## Phase 18: CDK Assertion Tests

- [x] 18.1 78 tests across 13 suites
- [x] 18.2 bootstrap.test.ts — CodeBuild project, KMS-encrypted artifact bucket, scoped IAM role
- [x] 18.3 vpc.test.ts — isolated subnets, no IGW, no NAT, CIDRs, security groups, 7 VPC endpoints
- [x] 18.4 database.test.ts — global cluster, primary cluster, KMS, Secrets Manager
- [x] 18.5 database-replica.test.ts — secondary cluster, global cluster membership
- [x] 18.6 schema.test.ts — custom resource Lambda, VPC deployment
- [x] 18.7 aurora-app.test.ts — internal ALB, HTTP listener, Lambda target group, IAM permissions
- [x] 18.8 dns.test.ts — PHZ, VPC associations, latency-based + region-aligned records, conditional health checks
- [x] 18.9 failover-plan.test.ts — ARC plan, activeActive, AuroraGlobalDatabase block, Route53HealthCheck block
- [x] 18.10 synthetics.test.ts — 3 canaries per region, schedule, artifact bucket, VPC deployment
- [x] 18.11 monitoring.test.ts — 8 alarms, dashboard, SNS, RPO monitor Lambda
- [x] 18.12 chaos.test.ts — FIS experiment templates, IAM role, log group
- [x] 18.13 reconciliation.test.ts — SSM documents, reconciliation Lambda, IAM roles
- [x] 18.14 loadgen.test.ts — Lambda, SSM document, IAM permissions, VPC deployment
- [x] 18.15 All tests pass via `npx projen test`
