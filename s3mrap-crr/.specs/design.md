# Design: S3 MRAP + CRR Demo

## Architecture

```
GitHub Actions                             AWS
──────────────                             ───
Push to non-main branch ──► Build workflow (compile + test + synth)
Pull Request ──────────────► E2E workflow:
                               ├─ Build + test
                               ├─ cdk deploy s3mrap-bootstrap ──► CodeBuild (make deploy)
                               │    ├─ deploy-kms            (us-east-1, then replica in us-west-2)
                               │    ├─ deploy-buckets        (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-routing        (us-east-1, captures MRAP alias)
                               │    ├─ deploy-routing-lambdas (us-east-1 + us-west-2, parallel)
                               │    └─ deploy-failover-and-monitoring (parallel)
                               ├─ Load test (100 objects) + mid-flight failover
                               ├─ Verify: replication, failover, metrics, alarms
                               └─ Cleanup (on success only)
Manual trigger ────────────► Cleanup workflow (cleanup.sh)
```

```
┌─────────────────────────────────────────────────────────────────┐
│                        GLOBAL RESOURCES                         │
│  Multi-Region KMS Key (MRK)                                     │
│    └─► Primary (us-east-1) + Replica (us-west-2)               │
│  S3 Multi-Region Access Point (MRAP)                            │
│    └─► us-east-1 bucket + us-west-2 bucket                     │
│  ARC Region Switch Plan                                         │
│    └─► Invokes MRAP Routing Lambda on failover                  │
└─────────────────────────────────────────────────────────────────┘

┌──────────── us-east-1 ────────────┐  ┌──────────── us-west-2 ────────────┐
│  S3 Bucket (versioned, KMS/MRK)   │  │  S3 Bucket (versioned, KMS/MRK)   │
│  CRR → us-west-2                  │  │  CRR → us-east-1                  │
│  CloudWatch Dashboard (combined)  │  │  CloudWatch Alarms                │
│  CloudWatch Alarms                │  │  MRAP Routing Lambda              │
│  MRAP Routing Lambda              │  │  MRAP Monitor Lambda              │
│  MRAP Monitor Lambda              │  │                                   │
│  Load Test Lambda + SSM Document  │  │                                   │
└───────────────────────────────────┘  └───────────────────────────────────┘
```

## CDK Stacks (11 total)

### 1. KmsStack (`s3mrap-kms`, us-east-1)
- Multi-region KMS key (MRK) with key rotation enabled
- Alias: `{project}-mrk`
- Outputs: KeyArn, KeyId

### 2. KmsReplicaStack (`s3mrap-kms-replica`, us-west-2)
- MRK replica key (same key ID as primary)
- Alias: `{project}-mrk`
- Outputs: ReplicaKeyArn

### 3. BootstrapStack (`s3mrap-bootstrap`, us-east-1)
- CodeBuild project (aws/codebuild/standard:7.0 image)
- S3 artifact bucket encrypted with local CMK (not MRK)
- IAM role scoped to: sts:AssumeRole on cdk-*, cloudformation:DescribeStacks/ListStacks, ssm:GetParameter on cdk-bootstrap/*, artifact bucket read
- BucketDeployment to upload source as CDK asset
- Build trigger custom resource (Lambda-backed):
  - On Create/Update: starts CodeBuild `make deploy`, polls until complete
  - On Delete: completes immediately (cleanup via cleanup.sh)
  - Uses Provider framework with `onEvent` + `isComplete` handlers
  - 30-second poll interval, 30-minute total timeout

### 4. RegionalBucketStack (`s3mrap-bucket-primary/secondary`)
- S3 Bucket (versioned, KMS/MRK encrypted, public access blocked)
- Bucket name: `{project}-{region}-{accountId}`
- Access logs bucket (S3-managed encryption)
- SNS topic (MRK encrypted) for replication failure event notifications
- S3 event notification: s3:Replication:OperationFailedReplication → SNS

### 5. GlobalRoutingStack (`s3mrap-global-routing`, us-east-1)
- CfnMultiRegionAccessPoint referencing both buckets
- Custom resource Lambda for bidirectional CRR configuration
  - EncryptionConfiguration with MRK key ARN per destination region
  - SourceSelectionCriteria with SseKmsEncryptedObjects enabled
- IAM replication role with kms:Decrypt/Encrypt/GenerateDataKey on MRK
- iam:PassRole conditioned on iam:PassedToService: s3.amazonaws.com
- AwsCustomResource to set initial routing: primary=100%, secondary=0%
- CRR custom resource Lambda: reserved concurrency 1

### 6. RoutingLambdaStack (`s3mrap-routing-primary/secondary`)
- MRAP routing Lambda (Python) — calls SubmitMultiRegionAccessPointRoutes
- Uses MRAP ARN (with alias) from env var, not MRAP name
- IAM policy resource uses alias-based ARN
- Deployed in both regions (ARC requires Lambda in each region)
- ARC invoke permission granted to arc-region-switch.amazonaws.com
- Reserved concurrency: 5

### 7. FailoverStack (`s3mrap-failover`, us-east-1)
- AWS::ARCRegionSwitch::Plan with activePassive recovery
- References routing Lambda ARNs from both regions
- Load test Lambda (Python, 15-min timeout, 512MB)
  - KMS permissions (kms:GenerateDataKey/Decrypt) on MRK for writing to encrypted buckets
- SSM Automation Document for load test invocation

### 8. MonitoringStack (`s3mrap-monitoring-primary/secondary`)
- CloudWatch Alarms: ReplicationLatency, BytesPendingReplication, OperationsPendingReplication, OperationsFailedReplication
- SNS alarm topic (MRK encrypted) per region — all alarms have ALARM + OK notification actions
- Combined CloudWatch Dashboard (primary stack only):
  - MRAP traffic dial for both regions
  - Both replication directions with cross-region metric references
  - Latency, BytesPending, Operations per direction
- MRAP Monitor Lambda (runs every 1 min via EventBridge, reserved concurrency 5)
- Metric region placement per AWS docs:
  - ReplicationLatency, BytesPendingReplication, OperationsPendingReplication → destination region
  - OperationsFailedReplication → source region

## Deployment Order (Makefile)

```
deploy-kms                  (sequential: kms primary, capture key ID, kms replica)
    │
deploy-buckets              (parallel: bucket-primary + bucket-secondary)
    │
deploy-routing              (sequential: global-routing, captures MRAP_ALIAS)
    │
deploy-routing-lambdas      (parallel: routing-primary + routing-secondary)
    │
deploy-failover-and-monitoring  (parallel: failover + monitoring-primary + monitoring-secondary)
```

Parallel deploys use separate `-o cdk.out.*` directories to avoid CDK lock conflicts.
Each parallel group uses PID-based `wait` to propagate failures.
Shell variables captured via `aws cloudformation describe-stacks` and exported for backgrounded processes.
Bootstrap target cleans `cdk.out` before deploy to ensure fresh asset hashes.
Buildspec installs `ts-node` globally to prevent npm cache corruption during parallel deploys.

## Cross-Stack Data Flow

- Bucket names: computed by convention `{project}-{region}-{accountId}` in app.ts
- MRAP alias: captured from global-routing stack CloudFormation output, passed as `-c mrapAlias=`
- Encryption key ID: captured from kms stack CloudFormation output, passed as `-c encryptionKeyId=`
- Routing Lambda ARNs: computed by convention in app.ts

## GitHub Actions Workflows

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `s3mrap-crr: build` | Push to non-main branches | compile + 47 tests + synth |
| `s3mrap-crr: e2e` | Pull requests, manual | Deploy → load test + mid-flight failover → verify → cleanup on success |
| `s3mrap-crr: cleanup` | Manual only | Run cleanup.sh |

- AWS OIDC authentication via `aws-actions/configure-aws-credentials`
- GitHub Actions role assumes CDK bootstrap roles for deployment
- CDK bootstrap is a prerequisite (one-time manual setup per account/region)
- E2E skips cleanup on failure to preserve stacks for troubleshooting

## Projen Configuration

- `AwsCdkTypeScriptApp` with npm package manager
- `github: false` — workflows managed at repo root for monorepo compatibility
- `eslint: false` — disabled for existing codebase
- `srcdir: '.'`, `libdir: '.'` — source at project root (not `src/`)
- `appEntrypoint: 'bin/app.ts'`
- Jest configuration managed by projen (no standalone jest.config.js)

## Cleanup

Standalone `cleanup.sh` script (not CodeBuild):
1. Delete stuck stacks (ROLLBACK_COMPLETE/ROLLBACK_FAILED)
2. Destroy failover + monitoring (parallel)
3. Destroy routing lambdas (parallel)
4. Destroy global routing
5. Destroy buckets (parallel)
6. Destroy KMS stacks (parallel: replica first, then primary)
7. Destroy bootstrap stack
8. Clean orphaned S3 buckets
9. Remove local cdk.out directories

## Project Structure

```
s3mrap-crr/
├── .projenrc.ts                  # Projen project configuration
├── .projen/                      # Projen-managed files
├── .specs/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
├── bin/
│   └── app.ts                    # CDK app entry point, cdk-nag opt-in, NagSuppressions
├── lib/
│   ├── kms-stack.ts              # MRK primary + replica stacks
│   ├── bootstrap-stack.ts        # CodeBuild project + local CMK
│   ├── regional-bucket-stack.ts  # S3 bucket per region (MRK encrypted)
│   ├── global-routing-stack.ts   # MRAP + CRR with MRK
│   ├── routing-lambda-stack.ts   # MRAP routing Lambda (per region)
│   ├── failover-stack.ts         # ARC plan + load test (with KMS perms)
│   └── monitoring-stack.ts       # Alarms + combined dashboard + MRAP monitor
├── lambda/
│   ├── build-trigger/index.py
│   ├── crr-custom-resource/index.py
│   ├── mrap-routing/index.py
│   ├── mrap-monitor/index.py
│   └── load-test/index.py
├── test/
│   ├── regional-bucket.test.ts
│   ├── global-routing.test.ts
│   ├── routing-lambda.test.ts
│   ├── failover.test.ts
│   ├── monitoring.test.ts
│   ├── bootstrap.test.ts
│   └── integration.test.ts       # Cross-stack consistency tests
├── Makefile                      # Parallel deploys, shell-based variable capture
├── buildspec.yml
├── cleanup.sh
├── cdk.json
├── tsconfig.json
├── tsconfig.dev.json
├── package.json
└── README.md
```
