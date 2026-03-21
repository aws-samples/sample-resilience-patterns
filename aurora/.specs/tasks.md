# Tasks: Aurora Global Database — Multi-Region Resilience Demo

**RULE: No phase is complete until its tests pass.** Every phase that produces a CDK stack or Lambda handler
must have corresponding tests written and passing (`npx projen test`) before moving to the next phase.

## Phase 1: Project Setup

- [x] 1.1 Initialize projen AwsCdkTypeScriptApp with npm, github: false
- [x] 1.2 Configure cdk.json, tsconfig.json, package.json (projen-managed)
- [x] 1.3 Create .gitignore (projen-managed + sensitive file patterns)
- [x] 1.4 Create project README.md (architecture, prerequisites, usage)

## Phase 2: Bootstrap Stack (CodeBuild)

- [x] 2.1 Create lib/bootstrap-stack.ts — CodeBuild project (standard:7.0, SMALL), local CMK, scoped IAM role (sts:AssumeRole cdk-*, cloudformation describe/list, ssm:GetParameter cdk-bootstrap/*, ec2/rds/dsql describe, arc-region-switch list), artifact bucket (KMS, block public, enforce SSL), source upload (BucketDeployment), build trigger (onEvent + isComplete, 30s poll, 60min timeout)
- [x] 2.2 Create buildspec.yml — npm ci, global install aws-cdk + ts-node, pip install Lambda deps, make deploy
- [x] 2.3 Create lambda/build-trigger/index.py — on_event starts CodeBuild, is_complete polls BatchGetBuilds (SUCCEEDED/IN_PROGRESS/fail)
- [x] 2.4 Wire BootstrapStack in bin/app.ts (target=bootstrap)
- [x] ✅ Tests pass: bootstrap.test.ts (7 tests)

## Phase 3: VPC Stack (Per Region)

- [x] 3.1 Create lib/vpc-stack.ts — VPC with 2 AZs, isolated subnets only, no public, no IGW, no NAT
- [x] 3.2 Non-overlapping /23 CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23 (/24 subnets)
- [x] 3.3 7 VPC Interface endpoints (private DNS): CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics, RDS
- [x] 3.4 1 VPC Gateway endpoint: S3
- [x] 3.5 5 Security groups (all allowAllOutbound: false): ALB (inbound 80 from Synthetics SG + peer CIDR), Database (inbound 5432 from Lambda SG + peer CIDR), Lambda (inbound 80 from ALB; egress 5432 to DB SG + peer CIDR, 443 to VPCe SG), VPC Endpoint (inbound 443 from Lambda + Synthetics), Synthetics (egress 80 to ALB SG + peer CIDR, 443 to VPCe SG + anyIpv4)
- [x] 3.6 Wire VpcStack (x2 regions) in bin/app.ts (target=vpc-primary, vpc-secondary)
- [x] 3.7 Outputs: VpcId, VpcCidr, IsolatedSubnetIds, AvailabilityZones, all 5 SG IDs
- [x] ✅ Tests pass: vpc.test.ts (8 tests)

## Phase 4: VPC Peering Stack

- [x] 4.1 Create lib/vpc-peering-stack.ts — CfnVPCPeeringConnection (primary → secondary, peerRegion)
- [x] 4.2 Peering acceptance + secondary route table entries via AWS CLI in Makefile (not in CDK)
- [x] 4.3 Wire VpcPeeringStack in bin/app.ts (target=vpc-peering, depends on both VpcStacks)
- [x] 4.4 Output: PeeringConnectionId

## Phase 5: Aurora Global Database Stack

- [x] 5.1 Create lib/database-stack.ts — CfnGlobalCluster (aurora-postgresql 16.6, storageEncrypted, deletionProtection: false), primary DatabaseCluster (db.r6g.large writer), KMS key with rotation
- [x] 5.2 Credentials: fromGeneratedSecret('dbadmin', secretName: `${project}/db-credentials`, encrypted with KMS key)
- [x] 5.3 Default database: 'orders', backup retention: 7 days, isolated subnets, database SG
- [x] 5.4 Secret replication: CfnSecret ReplicaRegions property override to secondary region
- [x] 5.5 Create lib/database-replica-stack.ts — secondary cluster joined to global cluster (db.r6g.large reader), regional KMS key, delete MasterUsername/MasterUserPassword/DatabaseName from CfnDBCluster
- [x] 5.6 Wire DatabaseStack + DatabaseReplicaStack in bin/app.ts (target=db-primary, db-secondary)
- [x] ✅ Tests pass: database.test.ts (7 tests) + database-replica.test.ts (5 tests)

## Phase 6: Schema Migration Stack

- [x] 6.1 Create lambda/schema-migration/index.py — creates tables (orders, replication_tracking), indexes (5 total), stored procedures (4 total), idempotent (IF NOT EXISTS, CREATE OR REPLACE)
- [x] 6.2 Stored procedures: sp_insert_order, sp_update_order_status (soft update), sp_delete_order (soft delete), sp_query_orders (excludes deleted)
- [x] 6.3 Create lib/schema-stack.ts — Provider-based custom resource, migration Lambda (Python 3.12, on_event handler, 5-min timeout, reserved concurrency 1), VPC-deployed, DB_SECRET_ARN env var
- [x] 6.4 Wire SchemaStack in bin/app.ts (target=schema, depends on DatabaseStack)
- [x] ✅ Tests pass: schema.test.ts (4 tests)

## Phase 7: Aurora Application Stack (Per Region)

- [x] 7.1 Create lambda/aurora-app/index.py — CRUD handler (ALB target) with read/write split: get_read_connection (DB_READ_HOST) for GET, get_write_connection (DB_WRITE_HOST) for POST/PUT/DELETE
- [x] 7.2 Routes: POST /orders, PUT /orders/{id}/status, DELETE /orders/{id}, GET /orders, GET /health
- [x] 7.3 DB_SECRET_ARN set to `${project}/db-credentials` (secret name, not ARN)
- [x] 7.4 Create lib/aurora-app-stack.ts — internal ALB (HTTP:80, isolated subnets) + Lambda target group (/health health check)
- [x] 7.5 IAM: secretsmanager:GetSecretValue on passed secretArn + wildcard `${project}/db-credentials-*` in current region; kms:Decrypt
- [x] 7.6 Reserved concurrency: 5, timeout: 60s, function name: `${project}-aurora-app-${region}`
- [x] 7.7 Wire AuroraAppStack (x2 regions) in bin/app.ts (target=aurora-app-primary, aurora-app-secondary)
- [x] 7.8 Makefile: primary DB_READ_HOST=ClusterEndpoint, secondary DB_READ_HOST=ClusterReaderEndpoint, both DB_WRITE_HOST=global writer endpoint from describe_global_clusters
- [x] ✅ Tests pass: aurora-app.test.ts (7 tests)

## Phase 8: DNS Stack

- [x] 8.1 Create lib/dns-stack.ts — CfnHostedZone `demo.internal` associated with both VPCs
- [x] 8.2 4 CfnRecordSets: 2 latency-based A-alias `aurora-app.demo.internal` (PrimaryRegion/StandbyRegion) + 2 simple A-alias `aurora-app-use1.demo.internal`, `aurora-app-usw2.demo.internal`
- [x] 8.3 All alias targets: evaluateTargetHealth: true
- [x] 8.4 Conditional health check attachment (spread operator, only if non-empty string)
- [x] 8.5 Wire DnsStack in bin/app.ts (target=dns)
- [x] ✅ Tests pass: dns.test.ts (7 tests)

## Phase 9: ARC Region Switch Plan

- [x] 9.1 Create lib/failover-plan-stack.ts — CfnResource AWS::ARCRegionSwitch::Plan (activeActive, PrimaryRegion: us-east-1)
- [x] 9.2 Execution role for arc-region-switch.amazonaws.com: iam:SimulatePrincipalPolicy on self, arc-region-switch read ops, rds describe/failover/switchover, route53 change/get/list/healthcheck, cloudwatch describe/get
- [x] 9.3 Deactivate workflow: failover-aurora-db (AuroraGlobalDatabase, switchoverOnly, ungraceful: failover, 20min) → shift-dns-aurora (Route53HealthCheck, 5min)
- [x] 9.4 Activate workflow: restore-dns-aurora (Route53HealthCheck, 5min)
- [x] 9.5 Makefile two-phase deployment: deploy DNS → deploy plan → capture ARC health check IDs via list-route53-health-checks → re-deploy DNS with health checks
- [x] 9.6 Wire FailoverPlanStack in bin/app.ts (target=failover-plan)
- [x] ✅ Tests pass: failover-plan.test.ts (7 tests)

## Phase 10: CloudWatch Synthetics Stack (Per Region)

- [x] 10.1 6 canaries per region: al/ar/ad (read-only: GET /health + GET /orders), wl/wr/wd (write: POST /orders + DELETE /orders/{id})
- [x] 10.2 All canaries use private hosted zone records (localRecordName, remoteRecordName, dnsRecordName)
- [x] 10.3 Runtime: syn-python-selenium-10.0, schedule: every 5 minutes, startAfterCreation: true
- [x] 10.4 KMS-encrypted artifact bucket (`${project}-canary-${region}-${account}`)
- [x] 10.5 6 CloudWatch alarms (SuccessPercent < 100%, treat missing: ignore)
- [x] 10.6 All canaries VPC-deployed with Synthetics SG
- [x] 10.7 Wire SyntheticsStack (x2 regions) in bin/app.ts (target=synthetics-primary, synthetics-secondary)
- [x] ✅ Tests pass: synthetics.test.ts (5 tests)

## Phase 11: Monitoring Stack (Per Region)

- [x] 11.1 Create lib/monitoring-stack.ts — alarms + dashboard + RPO monitor + DNS status
- [x] 11.2 3 Aurora alarms with SNS actions: ReplicaLag (>1000, Max, 1p), ReplicaLagMax (>2000, Max, 1p), CommitLatency (>100, Avg, 3p)
- [x] 11.3 3 RPO alarms: CatalogMissingRows (>10, Max, 2p), Heartbeat (<1, Sum, 10-min period, 2p, BREACHING), EngineVersionMismatch (>=1, Max, 1p)
- [x] 11.4 1 Writer region alarm: AuroraWriterActive < 1 for primary region dimension (Max, 2p)
- [x] 11.5 SNS alarm topic (KMS encrypted, key rotation) — ALARM + OK actions on Aurora alarms
- [x] 11.6 RPO Monitor Lambda: Python 3.12, every 5 min, VPC-deployed, reserved concurrency 5, 2-min timeout
  - Publishes to local CloudWatch: CatalogMissingRows (both regions), CatalogRPOHeartbeat (both regions), AuroraWriterActive (per region from describe_global_clusters), AuroraEngineVersionMismatch (both regions)
  - Secret accessed by name `${project}/db-credentials`
- [x] 11.7 DNS Status Lambda (primary region only, NOT VPC-deployed): every 1 min, reserved concurrency 1, 30s timeout
  - Publishes RegionDNSActive from ARC health checks
- [x] 11.8 Combined Dashboard (primary region only): Writer Region, DNS Active Region, Replica Lag, Missing Rows, Current Missing Rows, Heartbeat, Commit Latency, Engine Version Alignment
- [x] 11.9 Wire MonitoringStack (x2 regions) in bin/app.ts (target=monitoring-primary, monitoring-secondary)
- [x] ✅ Tests pass: monitoring.test.ts (7 tests)

## Phase 12: Reconciliation Stack (Per Region)

- [x] 12.1 Create lambda/reconciliation/index.py — connects to source + target endpoints, compares order IDs, returns report (capped at 100 IDs per direction)
- [x] 12.2 Create lib/reconciliation-stack.ts — 2 SSM Automation Documents (snapshot-copy + restore-reconcile)
- [x] 12.3 SSM Automation role: ssm.amazonaws.com, lambda:InvokeFunction, rds snapshot/restore/describe/create/delete, kms:Decrypt/CreateGrant/DescribeKey
- [x] 12.4 Reconciliation Lambda: `${project}-reconcile-${region}`, Python 3.12, lambda_handler, VPC-deployed, reserved concurrency 5, 10-min timeout
- [x] 12.5 Restore & Reconcile: restores snapshot → temp cluster (db.t4g.medium) → waits → invokes Lambda
- [x] 12.6 Wire ReconciliationStack (x2 regions) in bin/app.ts (target=reconciliation-primary, reconciliation-secondary)
- [x] ✅ Tests pass: reconciliation.test.ts (4 tests)

## Phase 13: Load Generation Stack

- [x] 13.1 Create lambda/loadgen/index.py — sustained CRUD traffic against ALB, publishes CloudWatch metrics (RequestsSent, Errors, AvgLatency, P99Latency) to `${project}/LoadTest` namespace
- [x] 13.2 Create lib/loadgen-stack.ts — Lambda (`${project}-loadgen`, 15-min timeout, 512MB, reserved concurrency 10), VPC-deployed, AURORA_ALB_DNS env var
- [x] 13.3 SSM Automation Document (`${project}-load-test`): parameters RequestsPerSecond, DurationSeconds, TargetApp, OperationMix
- [x] 13.4 Wire LoadGenStack in bin/app.ts (target=loadgen)
- [x] ✅ Tests pass: loadgen.test.ts (5 tests)

## Phase 14: Chaos Engineering Stack (Per Region)

- [x] 14.1 Create lib/chaos-stack.ts — 2 FIS experiment templates per region
- [x] 14.2 NetworkDisruption: aws:network:route-table-disrupt-cross-region-connectivity on subnets (ChaosAllowed=true), targets opposite region, default PT20M
- [x] 14.3 AuroraFailover: aws:rds:failover-db-cluster on clusters (ChaosAllowed=true)
- [x] 14.4 FIS IAM role (ec2 describe/create/delete, rds failover/reboot, tag:GetResources, logs), KMS-encrypted log group (7-day retention)
- [x] 14.5 experimentOptions: single-account, skip empty targets
- [x] 14.6 Wire ChaosStack (x2 regions) in bin/app.ts (target=chaos-primary targets secondaryRegion, chaos-secondary targets primaryRegion)
- [x] ✅ Tests pass: chaos.test.ts (6 tests)

## Phase 15: Makefile Orchestration

- [x] 15.1 Create Makefile with parallel deploy targets using separate `-o cdk.out.*` directories
- [x] 15.2 PID-based `wait` for parallel failure propagation
- [x] 15.3 Shell-based variable capture via `aws cloudformation describe-stacks` (`so` macro)
- [x] 15.4 `vpc_ctx` macro for passing VPC/SG context to all VPC-dependent stacks
- [x] 15.5 Two-phase DNS deployment: deploy → plan → capture health checks → re-deploy
- [x] 15.6 VPC peering acceptance + secondary route creation via AWS CLI
- [x] 15.7 Create cleanup.sh for reliable teardown (reverse order)

## Phase 16: Security Hardening & Open-Source Compliance

- [x] 16.1 Least-privilege IAM roles for all Lambdas
- [x] 16.2 Lambda reserved concurrency limits on all functions
- [x] 16.3 cdk-nag AwsSolutionsChecks opt-in via `-c nag=true`
- [x] 16.4 Global NagSuppressions per stack: IAM4, IAM5, L1, RDS10, RDS11, SMG4
- [x] 16.5 Create .checkov.yaml with skip rules and justifications
- [x] 16.6 MIT-0 LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- [x] 16.7 No public subnets, no IGW, no NAT — all traffic via VPC endpoints (except DNS Status Lambda)

## Phase 17: GitHub Actions CI/CD

- [x] 17.1 Build workflow (compile + test + synth)
- [x] 17.2 E2E workflow (deploy + verify + cleanup)
- [x] 17.3 Cleanup workflow (manual trigger)
- [x] 17.4 AWS OIDC authentication
- [x] 17.5 Status badges in repo root README

## Phase 18: CDK Assertion Tests

- [x] 18.1 79 tests across 13 suites
- [x] 18.2 bootstrap.test.ts (7) — CodeBuild project, KMS-encrypted artifact bucket, scoped IAM role, build trigger Lambdas, custom resource
- [x] 18.3 vpc.test.ts (8) — CIDR, isolated subnets, no IGW/NAT, 5 SGs, cross-region CIDR rules, S3 gateway, 7 interface endpoints
- [x] 18.4 database.test.ts (7) — global cluster, primary cluster, writer instance (db.r6g.large), KMS, secret name, subnet group, deletion protection
- [x] 18.5 database-replica.test.ts (5) — secondary cluster, global cluster membership, no MasterUsername/Password/DatabaseName, reader instance, regional KMS
- [x] 18.6 schema.test.ts (4) — migration Lambda (on_event, python3.12, 5min, concurrency 1), VPC deployment, Secrets Manager access, custom resource
- [x] 18.7 aurora-app.test.ts (7) — internal ALB, HTTP:80 listener, Lambda target group (/health), Lambda config (python3.12, 60s, concurrency 5), VPC deployment, DB_READ_HOST/DB_WRITE_HOST env vars, SM+KMS permissions
- [x] 18.8 dns.test.ts (7) — PHZ, both VPC associations, 4 record sets, latency routing with SetIdentifier, region-aligned records, no health check when empty, health check when provided
- [x] 18.9 failover-plan.test.ts (7) — ARC plan (activeActive, regions), deactivate Aurora step, deactivate DNS step, activate DNS step, execution role (arc-region-switch.amazonaws.com), RDS failover permissions, Route53 permissions
- [x] 18.10 synthetics.test.ts (5) — 6 canaries, 5-min schedule, VPC deployment, KMS-encrypted bucket, 6 alarms
- [x] 18.11 monitoring.test.ts (7) — 7 alarms, KMS-encrypted SNS topic, treat missing ignore, RPO monitor Lambda (python3.12, concurrency 5), 5-min schedule, dashboard, heartbeat BREACHING
- [x] 18.12 chaos.test.ts (6) — 2 FIS templates, network disruption (subnet, ChaosAllowed), Aurora failover (cluster, ChaosAllowed), FIS IAM role, KMS log group (7-day), single-account targeting
- [x] 18.13 reconciliation.test.ts (4) — reconciliation Lambda (python3.12, 600s, concurrency 5), 2 SSM documents, SSM automation role, RDS restore permissions
- [x] 18.14 loadgen.test.ts (5) — Lambda (python3.12, 900s, 512MB, concurrency 10), AURORA_ALB_DNS env var, SSM document, SSM automation role, PutMetricData permission
- [x] 18.15 All tests pass via `npx projen test`
