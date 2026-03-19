
**RULE: No phase is complete until its tests pass.** Every phase that produces a CDK stack or Lambda handler
must have corresponding tests written and passing (`npx projen test`) before moving to the next phase.
Tests are written inline with implementation, not deferred to a later phase.

## Phase 1: Project Setup

- [ ] 1.1 Initialize projen AwsCdkTypeScriptApp with npm, github: false
- [ ] 1.2 Configure cdk.json, tsconfig.json, package.json (projen-managed)
- [ ] 1.3 Create .gitignore (projen-managed + sensitive file patterns)
- [ ] 1.4 Create project README.md (architecture, prerequisites, usage)

## Phase 2: Bootstrap Stack (CodeBuild)

- [ ] 3.1 Create lib/bootstrap-stack.ts — CodeBuild project, local CMK, scoped IAM role, artifact bucket, source upload, build trigger
- [ ] 3.2 Create buildspec.yml — npm ci, ts-node install, make deploy
- [ ] 3.3 Create lambda/build-trigger/index.py — starts CodeBuild, polls for completion (onEvent + isComplete, 30s poll, 30min timeout)
- [ ] 3.4 Wire BootstrapStack in bin/app.ts
- [ ] ✅ Tests pass: bootstrap.test.ts

## Phase 3: VPC Stack (Per Region)

- [ ] 3.1 Create lib/vpc-stack.ts — VPC with 2 AZs, isolated subnets only (ALBs, Lambdas, Aurora all in same tier) — no public, no private, no IGW, no NAT
- [ ] 3.2 Non-overlapping CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23 (2 isolated subnets per VPC as /24s — 256 IPs each, demo-sized)
- [ ] 3.3 VPC Interface endpoints: CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics, ELB
- [ ] 3.4 VPC Gateway endpoint: S3
- [ ] 3.5 Security groups: ALB SG (inbound 80 from local Synthetics SG + cross-region CIDR), Database SG (inbound 5432 from Lambda SG), Lambda SG (inbound from ALB SG, outbound to DB SG + VPC Endpoint SG 443), VPC Endpoint SG (inbound 443 from Lambda SG), Synthetics SG (outbound 80 to local ALB SG + cross-region CIDR)
- [ ] 3.6 Wire VpcStack (x2 regions) in bin/app.ts
- [ ] ✅ Tests pass: vpc.test.ts

## Phase 3a: VPC Peering Stack

- [ ] 3a.1 Create lib/vpc-peering-stack.ts — cross-region VPC peering connection (requester in us-east-1, accepter in us-west-2)
- [ ] 3a.2 Route table entries in both VPCs: cross-region CIDR → peering connection
- [ ] 3a.3 Wire VpcPeeringStack in bin/app.ts (depends on both VpcStacks)
- [ ] ✅ Tests pass: vpc-peering.test.ts

## Phase 4: Aurora Global Database Stack

- [ ] 4.1 Create lib/database-stack.ts — Global Database, primary Aurora cluster, writer instance, KMS key
- [ ] 4.2 Master credentials in Secrets Manager (auto-generated, KMS-encrypted, 30-day rotation)
- [ ] 4.3 Subnet group using private subnets, database SG from VpcStack
- [ ] 4.4 Export GlobalClusterArn, ClusterEndpoint, SecretArn as stack outputs
- [ ] 4.5 Create lib/database-replica-stack.ts — secondary cluster joined to Global Database, reader instance
- [ ] 4.6 Regional KMS key for secondary cluster encryption
- [ ] 4.7 Wire DatabaseStack + DatabaseReplicaStack in bin/app.ts
- [ ] ✅ Tests pass: database.test.ts



## Phase 6: Schema Migration Stack

- [ ] 6.1 Create lambda/schema-migration/index.py — creates tables, indexes, stored procedures
- [ ] 6.2 Stored procedures: sp_insert_order, sp_update_order_status, sp_delete_order, sp_query_orders
- [ ] 6.3 Create lib/schema-stack.ts — Lambda-backed custom resource, VPC-deployed, DB SG access
- [ ] 6.4 Idempotent migration (CREATE OR REPLACE, IF NOT EXISTS)
- [ ] 6.5 Wire SchemaStack in bin/app.ts (depends on DatabaseStack)
- [ ] ✅ Tests pass: schema.test.ts + schema-migration unit tests

## Phase 7: Aurora Global Database Application Stack (Per Region)

- [ ] 7.1 Create lambda/aurora-app/index.py — CRUD handler (ALB target) calling Aurora stored procedures
- [ ] 7.2 Routes: POST /orders, PUT /orders/{id}/status, DELETE /orders/{id}, GET /orders, GET /health
- [ ] 7.3 Aurora Global Database connectivity (writer in primary, reader in secondary)
- [ ] 7.4 Create lib/aurora-app-stack.ts — internal ALB (HTTP, isolated subnets) + Lambda target group (isolated subnets)
- [ ] 7.5 IAM role with Secrets Manager read, KMS decrypt
- [ ] 7.6 Security group: inbound from ALB SG, outbound to Database SG + VPC Endpoint SG
- [ ] 7.7 Reserved concurrency: 5, timeout: 60s
- [ ] 7.8 Wire AuroraAppStack (x2 regions) in bin/app.ts
- [ ] ✅ Tests pass: aurora-app.test.ts + aurora-app handler unit tests


- [ ] 7a.2 Routes: POST /orders, PUT /orders/{id}/status, DELETE /orders/{id}, GET /orders, GET /health
- [ ] 7a.5 Security group: inbound from ALB SG, outbound to Database SG + VPC Endpoint SG
- [ ] 7a.6 Reserved concurrency: 5, timeout: 60s

## Phase 7b: DNS Stack

- [ ] 7b.1 Create lib/dns-stack.ts — Route 53 private hosted zone (`demo.internal`)
- [ ] 7b.2 Associate hosted zone with both regional VPCs
- [ ] 7b.3 Latency-based A-alias records per app per region (SetIdentifier: PrimaryRegion/StandbyRegion)
- [ ] 7b.4 Conditional health check attachment (empty on first deploy, wired on second pass after ARC plan creation)
- [ ] 7b.5 Wire DnsStack in bin/app.ts (depends on both AppStacks + both VpcStacks)
- [ ] ✅ Tests pass: dns.test.ts

## Phase 7c: ARC Region Switch Plan

- [ ] 7c.1 Create lib/failover-plan-stack.ts — AWS::ARCRegionSwitch::Plan (activePassive)
- [ ] 7c.2 Execution role for arc-region-switch.amazonaws.com with rds, route53, arc-region-switch permissions
- [ ] 7c.3 Deactivate workflow: AuroraGlobalDatabase block (switchoverOnly, ungraceful: failover) → Route53HealthCheck block
- [ ] 7c.4 Activate workflow: Route53HealthCheck block (restore DNS traffic)
- [ ] 7c.5 Makefile two-phase deployment: deploy DNS → deploy plan → capture ARC health check IDs → re-deploy DNS with health checks
- [ ] 7c.6 Wire FailoverPlanStack in bin/app.ts
- [ ] ✅ Tests pass: failover-plan.test.ts

## Phase 7d: CloudWatch Synthetics Stack (Per Region)

- [ ] 7d.1 Create canaries/aurora-canary/index.py — Synthetics canary calling Aurora app ALB HTTP endpoints, validates all CRUD responses
- [ ] 7d.4 Cross-region canaries validate failover behavior — DNS resolves to active-region ALB
- [ ] 7d.5 CloudWatch alarm on canary SuccessPercent per canary (threshold: 100%)
- [ ] 7d.6 Canaries deployed in VPC with Synthetics SG (outbound 80 to local ALB SG + cross-region CIDR)
- [ ] 7d.7 Wire SyntheticsStack (x2 regions) in bin/app.ts
- [ ] ✅ Tests pass: synthetics.test.ts + canary script unit tests

## Phase 8: Monitoring Stack (Per Region)

- [ ] 8.1 Create lib/monitoring-stack.ts — CloudWatch alarms for Aurora metrics
- [ ] 8.2 Alarms: AuroraReplicaLag, AuroraReplicaLagMaximum, DatabaseConnections, CPUUtilization, FreeableMemory, CommitLatency
- [ ] 8.3 SNS alarm topic (KMS encrypted) — ALARM + OK actions
- [ ] 8.4 CloudWatch Dashboard: RPO replication lag, connections, CPU, commit latency, memory, IOPS
- [ ] 8.5 Cross-region metric references for primary vs secondary comparison
- [ ] 8.6 Wire MonitoringStack (x2 regions) in bin/app.ts
- [ ] ✅ Tests pass: monitoring.test.ts + rpo-monitor handler unit tests

## Phase 8a: Reconciliation Stack

- [ ] 8a.1 Create lambda/reconciliation/index.py — connects to restored snapshot cluster + new primary, compares order IDs, returns missing transaction report
- [ ] 8a.2 Create lib/reconciliation-stack.ts — SSM Automation Documents (snapshot-copy in primary, restore-reconcile in standby)
- [ ] 8a.3 Snapshot & Copy SSM doc: takes Aurora snapshot, copies cross-region with KMS encryption
- [ ] 8a.4 Restore & Reconcile SSM doc: restores snapshot → temp cluster → waits for availability → invokes reconciliation Lambda
- [ ] 8a.5 IAM roles: SSM Automation role (RDS snapshot/restore/describe, KMS, Lambda invoke), reconciliation Lambda role (Secrets Manager, RDS, VPC)
- [ ] 8a.6 Reconciliation Lambda: VPC-deployed, reserved concurrency 5
- [ ] 8a.7 Wire ReconciliationStack in bin/app.ts
- [ ] ✅ Tests pass: reconciliation.test.ts + reconciliation handler unit tests

## Phase 8b: Load Generation Stack

- [ ] 8c.1 Create lambda/loadgen/index.py — generates sustained CRUD traffic against ALB endpoints, publishes CloudWatch metrics (requests, errors, latency)
- [ ] 8c.2 Create lib/loadgen-stack.ts — Lambda (15-min timeout, 512MB, reserved concurrency 10), VPC-deployed
- [ ] 8c.4 Wire LoadGenStack in bin/app.ts
- [ ] ✅ Tests pass: loadgen.test.ts + loadgen handler unit tests

## Phase 8c: Chaos Engineering Stack (Per Region)

- [ ] 8c.1 Create lib/chaos-stack.ts — FIS experiment templates per region
- [ ] 8c.2 Cross-region network disruption experiment: `aws:network:route-table-disrupt-cross-region-connectivity` targeting subnets with ChaosAllowed tag
- [ ] 8c.3 Aurora cluster failover experiment: `aws:rds:failover-db-cluster` targeting Aurora DB cluster with ChaosAllowed tag
- [ ] 8c.4 FIS experiment IAM role with scoped policies (route table, RDS failover, tag resolution)
- [ ] 8c.5 FIS log group (KMS encrypted, 7-day retention)
- [ ] 8c.6 ChaosAllowed tags added to target resources in VpcStack and DatabaseStack
- [ ] 8c.7 Wire ChaosStack (x2 regions) in bin/app.ts
- [ ] ✅ Tests pass: chaos.test.ts

## Phase 9: Makefile Orchestration
- [ ] 9.1 Create Makefile with parallel deploy targets using separate cdk.out directories
- [ ] 9.3 PID-based wait for parallel failure propagation
- [ ] 9.4 Shell-based variable capture for sequential steps
- [ ] 9.5 Create cleanup.sh for reliable teardown (reverse order, global cluster detach before delete)

## Phase 10: CDK Assertion Tests

NOTE: Tests are written alongside each phase, not deferred. This phase tracks the full test inventory.
A phase is NOT complete unless all its tests pass via `npx projen test`.

- [ ] 10.1 Configure Jest via projen
- [ ] 10.2 Test BootstrapStack — CodeBuild project, KMS-encrypted artifact bucket, scoped IAM role
- [ ] 10.3 Test VpcStack — isolated subnets only, no IGW, no NAT, non-overlapping CIDRs, security groups (ALB, DB, Lambda, VPC Endpoint, Synthetics), VPC endpoints
- [ ] 10.4 Test VpcPeeringStack — peering connection, route table entries for cross-region CIDR
- [ ] 10.5 Test DatabaseStack — global cluster, primary cluster, KMS, Secrets Manager
- [ ] 10.6 Test DatabaseReplicaStack — secondary cluster, global cluster membership
- [ ] 10.8 Test SchemaStack — custom resource Lambda, VPC deployment
- [ ] 10.9 Test AuroraAppStack — internal ALB, HTTP listener, Lambda target group, IAM permissions
- [ ] 10.11 Test DnsStack — private hosted zone, VPC associations, latency-based records, conditional health checks
- [ ] 10.12 Test FailoverPlanStack — ARC plan, activePassive, AuroraGlobalDatabase block, Route53HealthCheck block, execution role
- [ ] 10.13 Test MonitoringStack — alarms, dashboard, SNS
- [ ] 10.14 Test SyntheticsStack — four canaries per region (local + cross-region DNS), schedule, artifact bucket, VPC deployment
- [ ] 10.15 Test ChaosStack — FIS experiment templates, IAM role, log group, target tags
- [ ] 10.16 Test ReconciliationStack — SSM documents, reconciliation Lambda, IAM roles
- [ ] 10.17 Test LoadGenStack — Lambda, SSM document, IAM permissions, VPC deployment
- [ ] 10.16 Integration tests — cross-stack endpoint consistency, security group references, ALB → Lambda → DB chain, VPC peering routes, DNS → ALB mapping
- [ ] 10.18 Canary script tests — validate request construction and response parsing logic offline
- [ ] 10.19 All tests pass via `npx projen test`

## Phase 11: Security Hardening & Open-Source Compliance

- [ ] 11.1 Least-privilege IAM roles for all Lambdas
- [ ] 11.2 Lambda reserved concurrency limits
- [ ] 11.3 iam:PassRole conditioned on iam:PassedToService
- [ ] 11.4 .gitignore sensitive patterns (.env, *.pem, *.key, credentials, cdk.context.json)
- [ ] 11.5 cdk-nag AwsSolutionsChecks opt-in via `-c nag=true` in bin/app.ts
- [ ] 11.6 NagSuppressions per stack with justification strings (no bare suppressions)
- [ ] 11.7 Create .checkov.yaml with skip rules and justifications
- [ ] 11.8 cfn_nag Metadata blocks on resources requiring inline suppression
- [ ] 11.9 README Security section with suppression table (rule ID | cause | explanation)
- [ ] 11.10 No public subnets, no IGW, no NAT — all traffic via VPC endpoints
- [ ] 11.11 No public database endpoints, isolated subnet access only
- [ ] 11.12 MIT-0 LICENSE file
- [ ] 11.13 CONTRIBUTING.md and CODE_OF_CONDUCT.md
- [ ] 11.14 cdk-nag passes clean (`npx cdk synth -c nag=true` produces no errors)

## Phase 12: GitHub Actions CI/CD

- [ ] 12.2 E2E workflow — PRs + manual, deploy + run Synthetics canaries + verify replication + cleanup on success
- [ ] 12.3 Cleanup workflow — manual trigger only
- [ ] 12.4 AWS OIDC authentication (no long-lived credentials)
- [ ] 12.5 Status badges in repo root README

## Phase 13: Enhanced RPO Monitoring

- [ ] 12.1 Create lambda/rpo-monitor/index.py — connects to local Aurora (reader) + remote Aurora (reader/writer) in single invocation
- [ ] 12.2 Row ID comparison across orders and replication_tracking tables, computes delta ("rows remote has that I don't")
- [ ] 12.3 Publish CatalogMissingRows custom CloudWatch metric (delta count)
- [ ] 12.4 Publish CatalogRPOHeartbeat custom CloudWatch metric (value=1) confirming check ran
- [ ] 12.5 EventBridge schedule: every 5 minutes, deployed in both regions
- [ ] 12.6 VPC-deployed with cross-region DB connectivity (local reader + remote reader/writer)
- [ ] 12.7 Secrets Manager access for credentials in both regions, reserved concurrency 5
- [ ] 12.8 Dashboard: RPO time series (CatalogMissingRows, FILL(REPEAT)) — atomic comparison makes FILL safe
- [ ] 12.9 Dashboard: RPO single value (CatalogMissingRows latest per region, no FILL)
- [ ] 12.10 Dashboard: Heartbeat time series (CatalogRPOHeartbeat, no FILL) — gaps = staleness indicator
- [ ] 12.11 Alarm on CatalogMissingRows exceeding threshold
- [ ] 12.12 Alarm on missing CatalogRPOHeartbeat (INSUFFICIENT_DATA = Lambda stopped running)

## Phase 14: Verification

- [ ] 13.1 CDK synth succeeds for all stacks
- [ ] 13.2 cdk-nag passes clean
- [ ] 13.3 Local end-to-end deploy + CRUD test verified
- [ ] 13.4 Replication lag visible in dashboard
- [ ] 13.5 README documents deployment, architecture, demo walkthrough, and cleanup
