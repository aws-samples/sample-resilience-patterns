# Design: Aurora Global Database — Multi-Region Resilience Demo

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GLOBAL RESOURCES                         │
│  Aurora Global Database (PostgreSQL 16.6)                       │
│    └─► Primary Cluster (us-east-1) + Secondary Cluster (us-west-2) │
│  Route 53 Private Hosted Zone (demo.internal)                    │
│    └─► aurora-app.demo.internal → latency-based (ARC health checks) │
│    └─► aurora-app-use1.demo.internal → us-east-1 ALB            │
│    └─► aurora-app-usw2.demo.internal → us-west-2 ALB            │
│  ARC Region Switch Plan (activeActive)                           │
│    └─► AuroraGlobalDatabase block + Route53HealthCheck block     │
└─────────────────────────────────────────────────────────────────┘

┌──────────── us-east-1 ────────────┐  ┌──────────── us-west-2 ────────────┐
│  VPC (10.0.0.0/23, 2 AZ, isolated)│  │  VPC (10.0.2.0/23, 2 AZ, isolated)│
│  8 VPC Endpoints (no IGW, no NAT) │  │  8 VPC Endpoints (no IGW, no NAT) │
│                                   │  │                                   │
│  Aurora App:                      │  │  Aurora App:                      │
│    ALB (internal, HTTP:80) ──►   │  │    ALB (internal, HTTP:80) ──►   │
│    Lambda (isolated) ──►          │  │    Lambda (isolated) ──►          │
│    DB_READ_HOST: primary endpoint │  │    DB_READ_HOST: secondary reader │
│    DB_WRITE_HOST: global writer   │  │    DB_WRITE_HOST: global writer   │
│                                   │  │                                   │
│  Synthetics (6 canaries):         │  │  Synthetics (6 canaries):         │
│    rd-local  → aurora-app-use1    │  │    rd-local  → aurora-app-usw2    │
│    rd-remote → aurora-app-usw2    │  │    rd-remote → aurora-app-use1    │
│    rd-global → aurora-app (dns)   │  │    rd-global → aurora-app (dns)   │
│    wr-local  → write local        │  │    wr-local  → write local        │
│    wr-remote → write remote       │  │    wr-remote → write remote       │
│    wr-global → write dns          │  │    wr-global → write dns          │
│                                   │  │                                   │
│  Schema Migration Lambda          │  │                                   │
│  RPO Monitor Lambda               │  │  RPO Monitor Lambda               │
│  DNS Status Lambda (NOT in VPC)   │  │                                   │
│  Combined Dashboard + 7 Alarms    │  │  7 Alarms (no dashboard)          │
│  Reconciliation SSM + Lambda      │  │  Reconciliation SSM + Lambda      │
│  Load Generation Lambda + SSM     │  │                                   │
│  FIS Experiments (network, Aurora) │  │  FIS Experiments (network, Aurora) │
│  Secrets Manager (DB creds)       │  │  Secrets Manager (replicated)     │
└───────────────────────────────────┘  └───────────────────────────────────┘
                    │                                    │
                    └──── VPC Peering (cross-region) ────┘
```

## CDK Stacks

### BootstrapStack (primary region)
- CodeBuild project (`${project}-deploy`, aws/codebuild/standard:7.0, SMALL compute, 150-min timeout)
- S3 artifact bucket encrypted with local CMK (`${project}-codebuild-${account}`)
- BucketDeployment to upload source as CDK asset (excludes .git, node_modules, cdk.out, cdk.out.*, dist, .specs)
- IAM role: sts:AssumeRole on cdk-*, cloudformation:DescribeStacks/ListStacks/DescribeStackResources, ssm:GetParameter on cdk-bootstrap/*, ec2/rds describe ops, arc-region-switch list ops
- WaitCondition + CfnWaitConditionHandle pattern: lightweight inline Lambda trigger starts CodeBuild and returns immediately via urllib/cfnresponse. CodeBuild signals WaitCondition via curl to WAIT_HANDLE_URL in buildspec post_build phase. 150-min WaitCondition timeout (9000 seconds). No 1-hour CloudFormation custom resource limit.
- Trigger Lambda: inline Python 3.12, 30s timeout, starts CodeBuild build, responds to CloudFormation via urllib.request (no polling, no isComplete handler)
- WAIT_HANDLE_URL passed to CodeBuild as environment variable
- buildspec.yml: npm ci, global install aws-cdk + ts-node, pip install Lambda deps (iterates schema-migration, aurora-app, rpo-monitor, reconciliation, loadgen, dns-status — installs if requirements.txt exists), make deploy. post_build phase signals WaitCondition via curl — SUCCESS if CODEBUILD_BUILD_SUCCEEDING=1, FAILURE otherwise.

### VpcStack (per region)
- VPC with 2 AZs, isolated subnets only (/23 CIDR, /24 subnets)
- Non-overlapping CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23
- 7 Interface endpoints (private DNS enabled): CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics, RDS
- 1 Gateway endpoint: S3
- 5 Security groups (all allowAllOutbound: false): ALB, Database, Lambda, VPC Endpoint, Synthetics
- Outputs: VpcId, VpcCidr, IsolatedSubnetIds, AvailabilityZones, all 5 SG IDs

### VpcPeeringStack (primary region)
- CfnVPCPeeringConnection: primary VPC → secondary VPC (peerRegion: us-west-2)
- Peering acceptance + route table entries done via AWS CLI in Makefile
- Output: PeeringConnectionId

### DatabaseStack (primary region)
- CfnGlobalCluster: aurora-postgresql 16.6, storageEncrypted, deletionProtection: false
- Primary DatabaseCluster: aurora-postgres 16.6, one db.r6g.large writer, KMS encryption, isolated subnets
- Credentials: fromGeneratedSecret('dbadmin', secretName: `${project}/db-credentials`, encrypted with same KMS key)
- Default database: 'orders', backup retention: 7 days
- Secret replication: CfnSecret ReplicaRegions property override to secondary region
- Outputs: GlobalClusterArn, ClusterIdentifier, ClusterEndpoint, ClusterReaderEndpoint, SecretArn, EncryptionKeyArn

### DatabaseReplicaStack (secondary region)
- Secondary DatabaseCluster joined to global cluster via globalClusterIdentifier
- One db.r6g.large reader instance, regional KMS key
- MasterUsername, MasterUserPassword, DatabaseName properties deleted from CfnDBCluster
- Outputs: ClusterIdentifier, ClusterReaderEndpoint, EncryptionKeyArn

### SchemaStack (primary region)
- Lambda-backed custom resource (Provider pattern) for schema migration
- Migration Lambda: Python 3.12, on_event handler, 5-min timeout, reserved concurrency 1
- VPC-deployed with Lambda SG, DB_SECRET_ARN env var (secret ARN)
- IAM: secretsmanager:GetSecretValue + kms:Decrypt

### AuroraAppStack (per region)
- Internal ALB (HTTP:80, isolated subnets, named `${project}-aurora-${region}`)
- Lambda target group with /health health check
- Lambda: Python 3.12, handler index.handler, 60s timeout, reserved concurrency 5
- Function name: `${project}-aurora-app-${region}`
- Environment: DB_SECRET_ARN=`${project}/db-credentials` (name, not ARN), DB_READ_HOST, DB_WRITE_HOST
- IAM: secretsmanager:GetSecretValue on both the passed secretArn and wildcard `${project}/db-credentials-*` in current region; kms:Decrypt
- Outputs: AlbDnsName, AlbArn, AlbHostedZoneId

### DnsStack (primary region)
- CfnHostedZone: `demo.internal`, associated with both VPCs
- 4 CfnRecordSets:
  - 2 latency-based A-alias: `aurora-app.demo.internal` (PrimaryRegion/us-east-1, StandbyRegion/us-west-2)
  - 2 simple A-alias: `aurora-app-use1.demo.internal`, `aurora-app-usw2.demo.internal`
- Health check IDs conditionally attached (spread operator, only if non-empty)
- All alias targets: evaluateTargetHealth: true
- Outputs: HostedZoneIdOutput, PrimaryRegionRecordName, SecondaryRegionRecordName

### FailoverPlanStack (primary region)
- CfnResource type AWS::ARCRegionSwitch::Plan
- Name: `${project}-region-switch`, RecoveryApproach: activeActive
- PrimaryRegion: us-east-1, Regions: [us-east-1, us-west-2]
- Execution role: arc-region-switch.amazonaws.com with iam:SimulatePrincipalPolicy on self, arc-region-switch read ops, rds describe/failover/switchover, route53 change/get/list/healthcheck, cloudwatch describe/get
- Deactivate workflow (2 steps): failover-aurora-db (AuroraGlobalDatabase, switchoverOnly, ungraceful: failover, 20min) → shift-dns-aurora (Route53HealthCheck, 5min)
- Activate workflow (1 step): restore-dns-aurora (Route53HealthCheck, 5min)
- Outputs: PlanArn, ExecutionRoleArn

### SyntheticsStack (per region)
- 6 canaries per region: rd-local, rd-remote, rd-global (read-only), wr-local, wr-remote, wr-global (write)
- Read-only code: GET /health + GET /orders via http.client
- Write code: POST /orders + DELETE /orders/{id} via http.client
- Runtime: syn-python-selenium-10.0
- Schedule: every 5 minutes, startAfterCreation: true
- KMS-encrypted artifact bucket (`${project}-canary-${region}-${account}`)
- 6 CloudWatch alarms (SuccessPercent < 100%, treat missing: ignore)
- All canaries VPC-deployed with Synthetics SG
- All canaries have `provisionedResourceCleanup: true` — ensures Synthetics deletes Lambda functions when canary is deleted, releasing Hyperplane ENIs
- Canary names: `${project}-${suffix}` (truncated to 21 chars), region suffix: -e1 (us-east-1), -w2 (us-west-2)

### MonitoringStack (per region)
- KMS-encrypted SNS alarm topic (`${project}-alarms-${region}`)
- 3 Aurora alarms with SNS actions: ReplicaLag (>1000, Max, 1 period), ReplicaLagMax (>2000, Max, 1 period), CommitLatency (>100, Avg, 3 periods)
- 3 RPO alarms (custom namespace `${project}/RPO`): CatalogMissingRows (>10, Max, 2 periods), Heartbeat (<1, Sum, 10-min period, 2 periods, BREACHING), EngineVersionMismatch (>=1, Max, 1 period)
- 1 Writer region alarm: AuroraWriterActive < 1 for primary region dimension (Max, 2 periods)
- RPO Monitor Lambda: `${project}-rpo-monitor-${region}`, Python 3.12, 2-min timeout, reserved concurrency 5, every 5 min
  - Env: PROJECT, LOCAL_SECRET_ARN (name), REMOTE_SECRET_ARN (name), REMOTE_REGION, REMOTE_DB_HOST, GLOBAL_CLUSTER_ID
  - IAM: secretsmanager:GetSecretValue (wildcard ARN), kms:Decrypt (both keys), cloudwatch:PutMetricData, rds:DescribeDBClusters/DescribeGlobalClusters
- DNS Status Lambda (primary region only, NOT VPC-deployed): `${project}-dns-status-${region}`, Python 3.12, 30s timeout, reserved concurrency 1, every 1 min
  - Env: PLAN_ARN, HOSTED_ZONE_ID, RECORD_NAME, METRIC_NAMESPACE
  - IAM: arc-region-switch:ListRoute53HealthChecks, cloudwatch:PutMetricData
  - Publishes RegionDNSActive metric per region
- Combined Dashboard (primary region only): `${project}-combined`
  - Row 0: Writer Region (SingleValue, 12×3) + DNS Active Region (SingleValue, 12×3)
  - Row 1: Replica Lag (Graph, 12×6) + Missing Rows (Graph, 12×6)
  - Row 2: Commit Latency (Graph, 24×6, full-width)
  - Row 3: Engine Version Alignment (SingleValue, 24×3, full-width)
  - Row 4: Heartbeat (Graph, 24×5, full-width, "gaps = monitor stopped, RPO data is stale")

### ReconciliationStack (per region)
- Reconciliation Lambda: `${project}-reconcile-${region}`, Python 3.12, lambda_handler, 10-min timeout, reserved concurrency 5, VPC-deployed
- SSM Automation role: ssm.amazonaws.com, lambda:InvokeFunction, rds snapshot/restore/describe/create/delete, kms:Decrypt/CreateGrant/DescribeKey
- Snapshot & Copy SSM Document (`${project}-snapshot-copy-${region}`): copies source snapshot cross-region
- Restore & Reconcile SSM Document (`${project}-restore-reconcile-${region}`): restores snapshot → temp cluster (db.t4g.medium) → waits → invokes reconciliation Lambda

### LoadGenStack (primary region)
- Load gen Lambda: `${project}-loadgen`, Python 3.12, 15-min timeout, 512MB, reserved concurrency 10, VPC-deployed
- Env: AURORA_ALB_DNS
- IAM: cloudwatch:PutMetricData
- SSM Automation Document: async Lambda invocation via aws:executeScript (InvocationType=Event) + aws:sleep for duration
- SSM Automation role: ssm.amazonaws.com, lambda:InvokeFunction
- Output: LoadGenFunctionArn

### ChaosStack (per region)
- 2 FIS experiment templates:
  - NetworkDisruption: aws:network:route-table-disrupt-cross-region-connectivity on subnets (ChaosAllowed=true), targets opposite region
  - AuroraFailover: aws:rds:failover-db-cluster on clusters (ChaosAllowed=true)
- FIS IAM role: ec2 describe/create/delete/associate/disassociate, rds:FailoverDBCluster/RebootDBInstance, tag:GetResources, logs
- KMS-encrypted log group (`${project}-chaos-${region}`, 7-day retention)
- experimentOptions: single-account, skip empty targets
- Default duration: PT20M

## Deployment Order (Makefile)

```
deploy-vpc                  (parallel: vpc-primary + vpc-secondary)
    │
deploy-wave2                (parallel: vpc-peering + database — saves ~15 min on fresh deploys)
    │                       vpc-peering: sequential (peering + accept + routes via CLI)
    │                       database: sequential (db-primary, then db-secondary)
    │
deploy-schema               (sequential: schema migration against primary writer)
    │
deploy-aurora-app           (sequential: aurora-app-primary, then aurora-app-secondary)
    │                       (captures: P_READ_HOST from primary ClusterEndpoint,
    │                        S_READ_HOST from secondary ClusterReaderEndpoint,
    │                        GLOBAL_WRITER_HOST from describe_global_clusters Endpoint)
    │
deploy-dns                  (sequential: PHZ + latency-based + region-aligned records, no health checks)
    │
deploy-failover-plan        (sequential: ARC Region Switch Plan, captures PlanArn)
    │
deploy-dns-with-hc          (sequential: re-deploy DNS with ARC health check IDs)
    │
deploy-synthetics           (sequential: synthetics-primary, then synthetics-secondary)
    │
deploy-monitoring           (sequential: monitoring-primary, then monitoring-secondary)
    │
deploy-reconciliation       (parallel: reconciliation-primary + reconciliation-secondary)
    │
deploy-loadgen              (sequential: load generation Lambda + SSM doc)
    │
deploy-chaos                (parallel: chaos-primary + chaos-secondary)
```

Individual targets have NO inter-target dependencies — the `deploy` target enforces order via its prerequisite list. The `deploy-wave2` target runs `$(MAKE) deploy-vpc-peering & $(MAKE) deploy-database & wait` in a single shell line.

## Cross-Stack Data Flow

- VPC IDs, subnet IDs, AZs, SG IDs: CloudFormation outputs from VpcStack, passed as CDK context via `vpc_ctx` macro
- Database endpoints: CloudFormation outputs from DatabaseStack/DatabaseReplicaStack
- Global writer endpoint: `aws rds describe-global-clusters` Endpoint field
- Secret ARN: CloudFormation output from DatabaseStack
- KMS key ARNs: CloudFormation outputs from DatabaseStack/DatabaseReplicaStack
- Hosted zone ID: CloudFormation output from DnsStack (HostedZoneIdOutput)
- ARC health check IDs: `aws arc-region-switch list-route53-health-checks` filtered by region
- Plan ARN: CloudFormation output from FailoverPlanStack
- ALB DNS/hosted zone: CloudFormation outputs from AuroraAppStack
- Global cluster identifier: convention-based (`${project}-global-cluster`)
- Cross-region VPC CIDR: hardcoded in VpcStack props (peerCidr)

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS replication_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_region VARCHAR(20) NOT NULL,
    txn_id BIGINT NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replicated_at TIMESTAMPTZ
);
```

Indexes: idx_orders_region, idx_orders_status, idx_orders_created_at, idx_repl_tracking_source, idx_repl_tracking_committed

## Stored Procedures

- `sp_insert_order(p_region, p_status, p_payload)` → returns UUID
- `sp_update_order_status(p_id, p_status)` → soft update with timestamp
- `sp_delete_order(p_id)` → soft delete (sets deleted_at + updated_at)
- `sp_query_orders(p_region, p_status, p_since)` → filtered query excluding deleted

## Cleanup

Standalone `cleanup.sh` script with phased approach:

- **Phase 0**: Delete cwsyn-* Lambda functions (filtered by VPC ID) + delete synthetics stacks and wait. Starts ENI release timer as early as possible.
- **Phase 1**: Fire delete on all non-VPC stacks + nuke RDS instances/clusters directly via RDS API (bypassing CloudFormation). Detach members from global cluster, delete instances, delete clusters.
- **Phase 2**: Wait for non-VPC stacks + RDS. Waits for instances first, then re-issues cluster deletes (instances must be gone before cluster delete succeeds), then waits for clusters. Final global cluster delete.
- **Phase 2b**: Retry any DELETE_FAILED non-VPC stacks with `--retain-resources` on the failed logical resources.
- **Phase 3**: ENI cleanup loop — polls every 10s, deletes available ENIs, 90-min time limit. Deletes VPC stacks only when all ENIs are gone (skips stack delete if ENIs still exist to avoid 16-min CloudFormation blind spots). First attempt always deletes stacks regardless.

Key design decisions:
- Uses explicit stack list from CDK app (no pattern matching)
- Uses stack resource lookups for RDS identifiers (no name matching)
- Scoped safely: Lambdas filtered by VPC ID, stacks by explicit list, RDS by stack resources, ENIs by VPC ID
- Final verification: exits non-zero if any stacks remain

## GitHub Actions

### aurora-build.yml
- Triggers on pushes to non-main branches touching aurora/**
- Steps: checkout, setup node 20, npm ci, test, cdk synth

### aurora-e2e.yml
- Triggers on pull_request (aurora/**) and workflow_dispatch
- Single deploy step (no retry logic)
- Credential refresh (role-duration-seconds: 7200) before failover and cleanup steps
- github-actions-aurora IAM role has: ec2:DescribeNetworkInterfaces, ec2:DeleteNetworkInterface, ec2:DetachNetworkInterface, lambda:ListFunctions, lambda:DeleteFunction
- Steps: checkout, setup node, configure AWS credentials (2h session, account 123456789012), npm ci, test, deploy via bootstrap, verify canaries (6-min wait), refresh credentials, load test + ARC failover exercise (4-step: deactivate e1 → activate e1 → deactivate w2 → activate w2), refresh credentials, cleanup on success

### aurora-cleanup.yml
- Manual trigger only (workflow_dispatch)
- Runs cleanup.sh

## Project Structure

```
aurora/
├── .projenrc.ts                  # Projen project configuration
├── .projen/                      # Projen-managed files
├── .specs/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
├── bin/
│   └── app.ts                    # CDK app entry point, cdk-nag opt-in, stack wiring by -c stack=
├── lib/
│   ├── imports.ts                # VPC/SG import helpers (importVpc, importSg, VpcImportProps)
│   ├── bootstrap-stack.ts        # CodeBuild project + local CMK + WaitCondition + inline trigger Lambda
│   ├── vpc-stack.ts              # VPC per region (isolated subnets, 8 endpoints, 5 SGs)
│   ├── vpc-peering-stack.ts      # Cross-region VPC peering connection
│   ├── database-stack.ts         # Aurora Global DB primary cluster + secret replication
│   ├── database-replica-stack.ts # Aurora Global DB secondary cluster
│   ├── schema-stack.ts           # Schema migration custom resource
│   ├── aurora-app-stack.ts       # Aurora app: ALB + Lambda (read/write split)
│   ├── dns-stack.ts              # PHZ + latency-based + region-aligned DNS records
│   ├── failover-plan-stack.ts    # ARC Region Switch Plan (activeActive)
│   ├── synthetics-stack.ts       # CloudWatch Synthetics canaries (6 per region)
│   ├── monitoring-stack.ts       # 7 alarms + dashboard + RPO monitor + DNS status
│   ├── reconciliation-stack.ts   # Post-failover snapshot/restore/reconcile SSM docs
│   ├── loadgen-stack.ts          # Load generation Lambda + SSM doc
│   └── chaos-stack.ts            # FIS experiment templates
├── lambda/
│   ├── build-trigger/index.py    # UNUSED — trigger is now inline Lambda in bootstrap-stack.ts
│   ├── schema-migration/
│   │   ├── index.py              # Database schema + stored procedures (on_event)
│   │   └── requirements.txt      # psycopg2-binary==2.9.10
│   ├── aurora-app/
│   │   ├── index.py              # Aurora CRUD handler (ALB target, read/write split)
│   │   └── requirements.txt      # psycopg2-binary==2.9.10
│   ├── rpo-monitor/
│   │   ├── index.py              # RPO: cross-region row comparison + heartbeat + engine version + writer active
│   │   └── requirements.txt      # psycopg2-binary==2.9.10
│   ├── dns-status/
│   │   ├── index.py              # DNS status: ARC health check → RegionDNSActive metric
│   │   └── requirements.txt      # boto3>=1.38.0
│   ├── reconciliation/
│   │   └── index.py              # Post-failover: compare rows, missing txn report
│   └── loadgen/
│       └── index.py              # Load generation: sustained CRUD traffic via ALB
├── test/
│   ├── bootstrap.test.ts         # 7 tests
│   ├── vpc.test.ts               # 8 tests
│   ├── database.test.ts          # 7 tests
│   ├── database-replica.test.ts  # 5 tests
│   ├── schema.test.ts            # 4 tests
│   ├── aurora-app.test.ts        # 7 tests
│   ├── dns.test.ts               # 7 tests
│   ├── failover-plan.test.ts     # 7 tests
│   ├── synthetics.test.ts        # 5 tests
│   ├── monitoring.test.ts        # 7 tests
│   ├── chaos.test.ts             # 6 tests
│   ├── reconciliation.test.ts    # 4 tests
│   └── loadgen.test.ts           # 5 tests
├── Makefile                      # Parallel deploys, variable capture, vpc_ctx macro
├── buildspec.yml                 # CodeBuild: npm ci, ts-node, pip install, make deploy, post_build signals WaitCondition
├── cleanup.sh                    # Phased teardown (ENI cleanup, RDS API nuke, explicit stack lists)
├── .checkov.yaml                 # Checkov skip rules (CKV_AWS_116, CKV_AWS_173)
├── cdk.json
├── tsconfig.json
├── tsconfig.dev.json
├── package.json
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── README.md
```
