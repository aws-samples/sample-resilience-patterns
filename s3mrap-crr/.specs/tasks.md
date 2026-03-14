# Tasks: S3 MRAP + CRR Demo

## Phase 1: Project Scaffold

- [x] 1.1 Initialize CDK TypeScript project in s3mrap-crr/
- [x] 1.2 Configure cdk.json, tsconfig.json, package.json
- [x] 1.3 Create .gitignore
- [x] 1.4 Create project README.md (architecture, prerequisites, usage)

## Phase 2: Bootstrap Stack (CodeBuild)

- [x] 2.1 Create lib/bootstrap-stack.ts — CodeBuild project, IAM role, artifact bucket, source upload, build trigger
- [x] 2.2 Create buildspec.yml — npm ci, make deploy
- [x] 2.3 Create lambda/build-trigger/index.py — starts CodeBuild, polls for completion
- [x] 2.4 Wire BootstrapStack in bin/app.ts

## Phase 3: Regional Bucket Stack

- [x] 3.1 Create lib/regional-bucket-stack.ts — versioned S3 bucket, encrypted, public access blocked
- [x] 3.2 Bucket names include account ID for global uniqueness
- [x] 3.3 Wire RegionalBucketStack (x2 regions) in bin/app.ts

## Phase 4: Global Routing Stack (MRAP + CRR)

- [x] 4.1 Create lambda/crr-custom-resource/index.py — bidirectional CRR with Replication Time Control
- [x] 4.2 Create lib/global-routing-stack.ts — CfnMultiRegionAccessPoint, CRR custom resource, IAM replication role
- [x] 4.3 Export MRAP alias and ARN as stack outputs
- [x] 4.4 Wire GlobalRoutingStack in bin/app.ts

## Phase 5: Routing Lambda Stack (Per Region)

- [x] 5.1 Create lambda/mrap-routing/index.py — SubmitMultiRegionAccessPointRoutes call
- [x] 5.2 Create lib/routing-lambda-stack.ts — MRAP routing Lambda with ARC invoke permission
- [x] 5.3 Wire RoutingLambdaStack (x2 regions) in bin/app.ts

## Phase 6: Failover Stack (ARC + Load Test)

- [x] 6.1 Create lib/failover-stack.ts — ARC Region Switch Plan referencing both-region Lambda ARNs
- [x] 6.2 Add load test Lambda + SSM Automation Document
- [x] 6.3 Wire FailoverStack in bin/app.ts

## Phase 7: Monitoring Stack (CloudWatch + MRAP Monitor)

- [x] 7.1 Create lib/monitoring-stack.ts — CloudWatch alarms with correct metric region placement
- [x] 7.2 Add CloudWatch dashboard (MRAP traffic dial + 4 replication metrics)
- [x] 7.3 Create lambda/mrap-monitor/index.py — publishes MrapTrafficDial metric per region
- [x] 7.4 MRAP alias passed at deploy time via Makefile output capture
- [x] 7.5 Wire MonitoringStack (x2 regions) in bin/app.ts

## Phase 8: Makefile Orchestration

- [x] 8.1 Create Makefile with parallel deploy targets using separate cdk.out directories
- [x] 8.2 PID-based wait for parallel failure propagation
- [x] 8.3 Capture MRAP alias from global-routing stack output
- [x] 8.4 Create cleanup.sh for reliable teardown (parallel deletes, stuck stack handling, orphan cleanup)

## Phase 9: Load Test

- [x] 9.1 Create lambda/load-test/index.py — concurrent S3 uploads + replication latency polling
- [x] 9.2 Add load test Lambda to FailoverStack (15-min timeout, S3 access to both buckets)
- [x] 9.3 Create SSM Automation Document with String-type parameters
- [x] 9.4 Summary statistics output (min/max/avg/p50/p99 latency)

## Phase 10: CDK Assertion Tests

- [x] 10.1 Install Jest + ts-jest + @types/jest, configure jest.config.js
- [x] 10.2 Test RegionalBucketStack — versioning, encryption, public access blocked
- [x] 10.3 Test GlobalRoutingStack — MRAP regions, CRR Lambda permissions, replication role
- [x] 10.4 Test FailoverStack — ARC plan schema, both-region Lambda ARNs, SSM parameter types
- [x] 10.5 Test MonitoringStack — alarm dimensions, dashboard, missing data treatment
- [x] 10.6 Test BootstrapStack — CodeBuild project, encrypted artifact bucket
- [x] 10.7 Test RoutingLambdaStack — function name, permissions, ARC invoke
- [x] 10.8 Integration tests — cross-stack bucket name consistency, Lambda ARN consistency, metric namespace consistency
- [x] 10.9 All 38 tests pass via `npm test`

## Phase 11: Verification

- [x] 11.1 CDK synth succeeds for all 9 stacks
- [x] 11.2 Makefile dry-run (synth only) passes
- [x] 11.3 README documents deployment, demo walkthrough, load test, and cleanup

## Phase 12: Observability Improvements

- [x] 12.1 Add S3 Event Notifications for replication failures (s3:Replication:OperationFailedReplication → SNS)
- [ ] 12.2 Enable S3 request metrics on both buckets (4xx/5xx errors, FirstByteLatency)
- [x] 12.3 Add SNS topic + alarm notification actions for ALARM/OK transitions
- [x] 12.4 Add daily storage metrics to dashboards (BucketSizeBytes, NumberOfObjects)
- [x] 12.5 Add OperationsPendingReplication alarm
- [ ] 12.6 Consider cross-region unified CloudWatch dashboard
- [x] 12.7 Set initial MRAP routing to primary=100%, secondary=0% on creation
- [x] 12.8 MRAP routing Lambda uses ARN (with alias) instead of name
- [x] 12.9 Integration tests verify no Lambda uses MRAP_NAME and IAM policies use alias-based ARN
