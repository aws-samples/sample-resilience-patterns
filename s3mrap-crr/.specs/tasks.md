# Tasks: S3 MRAP + CRR Demo

## Phase 1: Project Setup

- [x] 1.1 Initialize projen AwsCdkTypeScriptApp with npm, github: false
- [x] 1.2 Configure cdk.json, tsconfig.json, package.json (projen-managed)
- [x] 1.3 Create .gitignore (projen-managed + sensitive file patterns)
- [x] 1.4 Create project README.md (architecture, prerequisites, usage)

## Phase 2: KMS Stack (Multi-Region Key)

- [x] 2.1 Create lib/kms-stack.ts — MRK primary with key rotation, alias
- [x] 2.2 Create KmsReplicaStack — MRK replica in secondary region with alias
- [x] 2.3 Wire KmsStack + KmsReplicaStack in bin/app.ts
- [x] 2.4 Makefile deploy-kms target: deploy primary, capture key ID, deploy replica

## Phase 3: Bootstrap Stack (CodeBuild)

- [x] 3.1 Create lib/bootstrap-stack.ts — CodeBuild project, local CMK, scoped IAM role, artifact bucket, source upload, build trigger
- [x] 3.2 Create buildspec.yml — npm ci, make deploy
- [x] 3.3 Create lambda/build-trigger/index.py — starts CodeBuild, polls for completion
- [x] 3.4 Wire BootstrapStack in bin/app.ts

## Phase 4: Regional Bucket Stack

- [x] 4.1 Create lib/regional-bucket-stack.ts — versioned S3 bucket, MRK encrypted, public access blocked
- [x] 4.2 Bucket names include account ID for global uniqueness
- [x] 4.3 SNS topic (MRK encrypted) for replication failure notifications
- [x] 4.4 Wire RegionalBucketStack (x2 regions) in bin/app.ts

## Phase 5: Global Routing Stack (MRAP + CRR)

- [x] 5.1 Create lambda/crr-custom-resource/index.py — bidirectional CRR with RTC, EncryptionConfiguration, SourceSelectionCriteria
- [x] 5.2 Create lib/global-routing-stack.ts — MRAP, CRR custom resource, replication role with KMS permissions
- [x] 5.3 iam:PassRole conditioned on iam:PassedToService: s3.amazonaws.com
- [x] 5.4 Export MRAP alias and ARN as stack outputs
- [x] 5.5 Wire GlobalRoutingStack in bin/app.ts

## Phase 6: Routing Lambda Stack (Per Region)

- [x] 6.1 Create lambda/mrap-routing/index.py — SubmitMultiRegionAccessPointRoutes with retry and endpoint fallback
- [x] 6.2 Create lib/routing-lambda-stack.ts — MRAP routing Lambda with ARC invoke permission, reserved concurrency 5
- [x] 6.3 Wire RoutingLambdaStack (x2 regions) in bin/app.ts

## Phase 7: Failover Stack (ARC + Load Test)

- [x] 7.1 Create lib/failover-stack.ts — ARC Region Switch Plan referencing both-region Lambda ARNs
- [x] 7.2 Add load test Lambda + SSM Automation Document with KMS permissions for CMK-encrypted buckets
- [x] 7.3 Wire FailoverStack in bin/app.ts

## Phase 8: Monitoring Stack (CloudWatch + MRAP Monitor)

- [x] 8.1 Create lib/monitoring-stack.ts — CloudWatch alarms with correct metric region placement
- [x] 8.2 Combined CloudWatch dashboard in primary stack with cross-region metric references for both directions
- [x] 8.3 Create lambda/mrap-monitor/index.py — publishes MrapTrafficDial metric per region, reserved concurrency 5
- [x] 8.4 MRAP alias passed at deploy time via Makefile output capture
- [x] 8.5 SNS alarm topics encrypted with MRK
- [x] 8.6 Wire MonitoringStack (x2 regions) in bin/app.ts

## Phase 9: Makefile Orchestration

- [x] 9.1 Create Makefile with parallel deploy targets using separate cdk.out directories
- [x] 9.2 PID-based wait for parallel failure propagation
- [x] 9.3 Shell-based variable capture (not $(eval)/$(shell)) for sequential execution
- [x] 9.4 Export variables for backgrounded parallel processes
- [x] 9.5 Create cleanup.sh for reliable teardown (parallel deletes, stuck stack handling, KMS cleanup, orphan cleanup)

## Phase 10: Load Test

- [x] 10.1 Create lambda/load-test/index.py — concurrent S3 uploads + replication latency polling
- [x] 10.2 Add load test Lambda to FailoverStack (15-min timeout, S3 + KMS access to both buckets)
- [x] 10.3 Create SSM Automation Document with String-type parameters
- [x] 10.4 Summary statistics output (min/max/avg/p50/p99 latency)

## Phase 11: CDK Assertion Tests

- [x] 11.1 Configure Jest via projen (no standalone jest.config.js)
- [x] 11.2 Test RegionalBucketStack — versioning, KMS encryption, public access blocked
- [x] 11.3 Test GlobalRoutingStack — MRAP regions, CRR Lambda permissions, replication role, KMS permissions
- [x] 11.4 Test FailoverStack — ARC plan schema, both-region Lambda ARNs, SSM parameter types
- [x] 11.5 Test MonitoringStack — alarm dimensions, dashboard, missing data treatment
- [x] 11.6 Test BootstrapStack — CodeBuild project, KMS-encrypted artifact bucket
- [x] 11.7 Test RoutingLambdaStack — function name, permissions, ARC invoke
- [x] 11.8 Integration tests — cross-stack bucket name consistency, Lambda ARN consistency, metric namespace consistency
- [x] 11.9 All 47 tests pass via `npx projen test`

## Phase 12: Security Hardening

- [x] 12.1 CodeBuild IAM scoped to sts:AssumeRole on cdk-* + cloudformation:DescribeStacks
- [x] 12.2 Lambda reserved concurrency (routing: 5, monitor: 5, CRR: 1)
- [x] 12.3 iam:PassRole conditioned on iam:PassedToService
- [x] 12.4 .gitignore sensitive patterns (.env, *.pem, *.key, credentials, cdk.context.json)
- [x] 12.5 cdk-nag compliance — all findings suppressed with justifications

## Phase 13: GitHub Actions CI/CD

- [x] 13.1 Build workflow — push to non-main branches, compile + test + synth
- [x] 13.2 E2E workflow — PRs + manual, deploy + load test + mid-flight failover + verify + cleanup on success
- [x] 13.3 Cleanup workflow — manual trigger only
- [x] 13.4 AWS OIDC authentication (no long-lived credentials)
- [x] 13.5 Status badges in repo root README

## Phase 14: Verification

- [x] 14.1 CDK synth succeeds for all 11 stacks
- [x] 14.2 cdk-nag passes clean
- [x] 14.3 Local end-to-end deploy + replication test verified
- [x] 14.4 README documents deployment, routing design, demo walkthrough, load test, and cleanup
