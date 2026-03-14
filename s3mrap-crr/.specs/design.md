# Design: S3 MRAP + CRR Demo

## Architecture

```
Local Machine                              AWS
─────────────                              ───
cdk deploy s3mrap-bootstrap ──────►  CodeBuild Project (us-east-1)
  (one-time, one region)                   │
                                           ├─ deploy-buckets         (us-east-1 + us-west-2, parallel)
                                           ├─ deploy-routing         (us-east-1, captures MRAP alias)
                                           ├─ deploy-routing-lambdas (us-east-1 + us-west-2, parallel)
                                           └─ deploy-failover-and-monitoring (parallel)
                                               ├─ failover           (us-east-1)
                                               ├─ monitoring-primary (us-east-1)
                                               └─ monitoring-secondary (us-west-2)
```

```
┌─────────────────────────────────────────────────────────────────┐
│                        GLOBAL RESOURCES                         │
│  S3 Multi-Region Access Point (MRAP)                            │
│    └─► us-east-1 bucket + us-west-2 bucket                     │
│  ARC Region Switch Plan                                         │
│    └─► Invokes MRAP Routing Lambda on failover                  │
└─────────────────────────────────────────────────────────────────┘

┌──────────── us-east-1 ────────────┐  ┌──────────── us-west-2 ────────────┐
│  S3 Bucket (versioned)            │  │  S3 Bucket (versioned)            │
│  CRR → us-west-2                  │  │  CRR → us-east-1                  │
│  CloudWatch Dashboard + Alarms    │  │  CloudWatch Dashboard + Alarms    │
│  MRAP Routing Lambda              │  │  MRAP Routing Lambda              │
│  MRAP Monitor Lambda              │  │  MRAP Monitor Lambda              │
│  Load Test Lambda + SSM Document  │  │                                   │
└───────────────────────────────────┘  └───────────────────────────────────┘
```

## CDK Stacks (9 total)

### 1. BootstrapStack (`s3mrap-bootstrap`, us-east-1)
- CodeBuild project (aws/codebuild/standard:7.0 image)
- S3 artifact bucket for source upload
- IAM role for CodeBuild with cross-region permissions
- BucketDeployment to upload source as CDK asset
- Build trigger custom resource (Lambda-backed):
  - On Create/Update: starts CodeBuild `make deploy`, polls until complete
  - On Delete: completes immediately (cleanup via cleanup.sh)
  - Uses Provider framework with `onEvent` + `isComplete` handlers
  - 30-second poll interval, 30-minute total timeout

### 2. RegionalBucketStack (`s3mrap-bucket-primary/secondary`)
- S3 Bucket (versioned, encrypted, public access blocked)
- Bucket name: `{project}-{region}-{accountId}`
- removalPolicy: DESTROY, autoDeleteObjects: true
- SNS topic for replication failure event notifications
- S3 event notification: s3:Replication:OperationFailedReplication → SNS

### 3. GlobalRoutingStack (`s3mrap-global-routing`, us-east-1)
- CfnMultiRegionAccessPoint referencing both buckets
- Custom resource Lambda for bidirectional CRR configuration
- IAM replication role (trusted by S3)
- AwsCustomResource to set initial routing: primary=100%, secondary=0%
- Outputs: MRAP alias, MRAP ARN, replication role ARN

### 4. RoutingLambdaStack (`s3mrap-routing-primary/secondary`)
- MRAP routing Lambda (Python) — calls SubmitMultiRegionAccessPointRoutes
- Uses MRAP ARN (with alias) from env var, not MRAP name
- IAM policy resource uses alias-based ARN
- Deployed in both regions (ARC requires Lambda in each region)
- ARC invoke permission granted to arc-region-switch.amazonaws.com

### 5. FailoverStack (`s3mrap-failover`, us-east-1)
- AWS::ARCRegionSwitch::Plan with activePassive recovery
- References routing Lambda ARNs from both regions
- ARC execution role for arc-region-switch.amazonaws.com
- Load test Lambda (Python, 15-min timeout, 512MB)
- SSM Automation Document for load test invocation

### 6. MonitoringStack (`s3mrap-monitoring-primary/secondary`)
- CloudWatch Alarms: ReplicationLatency, BytesPendingReplication, OperationsPendingReplication, OperationsFailedReplication
- SNS alarm topic per region — all alarms have ALARM + OK notification actions
- CloudWatch Dashboard: MRAP traffic dial + 4 replication metrics + daily storage metrics (BucketSizeBytes, NumberOfObjects)
- MRAP Monitor Lambda (runs every 1 min via EventBridge)
  - Reads MRAP routes, publishes MrapTrafficDial custom metric
  - MRAP alias passed as env var at deploy time
- Metric region placement per AWS docs:
  - ReplicationLatency, BytesPendingReplication, OperationsPendingReplication → destination region
  - OperationsFailedReplication → source region (uses reverse direction dimensions)

## Deployment Order (Makefile)

```
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
Bootstrap target cleans `cdk.out` before deploy to ensure fresh asset hashes.
Buildspec installs `ts-node` globally to prevent npm cache corruption during parallel deploys.

## Cross-Stack Data Flow

Bucket names and MRAP alias flow between stacks via convention and Makefile output capture:

- Bucket names: computed by convention `{project}-{region}-{accountId}` in app.ts
- MRAP alias: captured from global-routing stack CloudFormation output, passed as `-c mrapAlias=` to monitoring stacks
- Routing Lambda ARNs: computed by convention in app.ts

## Cleanup

Standalone `cleanup.sh` script (not CodeBuild):
1. Delete stuck stacks (ROLLBACK_COMPLETE/ROLLBACK_FAILED)
2. Destroy failover + monitoring (parallel)
3. Destroy routing lambdas (parallel)
4. Destroy global routing
5. Destroy buckets (parallel)
6. Destroy bootstrap stack
7. Clean orphaned S3 buckets
8. Remove local cdk.out directories

## Project Structure

```
s3mrap-crr/
├── .specs/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
├── bin/
│   └── app.ts                    # CDK app entry point
├── lib/
│   ├── bootstrap-stack.ts        # CodeBuild project
│   ├── regional-bucket-stack.ts  # S3 bucket per region
│   ├── global-routing-stack.ts   # MRAP + CRR
│   ├── routing-lambda-stack.ts   # MRAP routing Lambda (per region)
│   ├── failover-stack.ts         # ARC plan + load test
│   └── monitoring-stack.ts       # CloudWatch alarms + dashboards + MRAP monitor
├── lambda/
│   ├── build-trigger/            # Python: starts CodeBuild + polls for completion
│   │   └── index.py
│   ├── crr-custom-resource/      # Python: configures bidirectional CRR
│   │   └── index.py
│   ├── mrap-routing/             # Python: changes MRAP traffic dial
│   │   └── index.py
│   ├── mrap-monitor/             # Python: publishes MRAP traffic dial metric
│   │   └── index.py
│   └── load-test/                # Python: replication latency load test
│       └── index.py
├── test/
│   ├── regional-bucket.test.ts
│   ├── global-routing.test.ts
│   ├── routing-lambda.test.ts
│   ├── failover.test.ts
│   ├── monitoring.test.ts
│   ├── bootstrap.test.ts
│   └── integration.test.ts       # Cross-stack consistency tests
├── Makefile
├── buildspec.yml
├── cleanup.sh
├── cdk.json
├── tsconfig.json
├── jest.config.js
├── package.json
└── README.md
```

## Future Observability Improvements

Per AWS best practices research, the following improvements are recommended:

| Priority | Improvement | Detail |
|----------|------------|--------|
| HIGH | S3 Event Notifications for replication failures | Configure s3:Replication:OperationFailedReplication on both buckets → SNS. Provides per-object failure reasons. |
| MEDIUM | S3 request metrics (4xx/5xx, latency) | Enable CloudWatch request metrics on both buckets. Alarm on 5xxErrors. Add FirstByteLatency to dashboards. |
| MEDIUM | SNS notification actions on alarms | Add SNS topic + alarm actions for ALARM/OK transitions. Enables email/Slack/PagerDuty. |
| MEDIUM | Daily storage metrics on dashboards | Add BucketSizeBytes + NumberOfObjects. Compare across regions to detect replication drift. |
| LOW | Cross-region unified dashboard | Single dashboard in us-east-1 pulling metrics from both regions. |
| LOW | S3 Storage Lens advanced metrics | Replication rule auditing and data protection metrics. |
