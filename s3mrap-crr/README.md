# S3 Multi-Region Access Point + Cross-Region Replication Demo

Demonstrates S3 Multi-Region Access Points (MRAP) with bidirectional Cross-Region Replication (CRR), CloudWatch observability, ARC-based region failover, and a replication latency load test — all deployed via CodeBuild from a single local bootstrap command.

## Architecture

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

## Prerequisites

- AWS CLI configured with credentials
- Node.js 20+
- CDK CLI (`npm install -g aws-cdk`)
- Project dependencies installed (`npm install`)
- CDK bootstrapped in both regions:
  ```bash
  cdk bootstrap aws://ACCOUNT_ID/us-east-1
  cdk bootstrap aws://ACCOUNT_ID/us-west-2
  ```

## Quick Start

```bash
npx cdk deploy s3mrap-bootstrap -c accountId=ACCOUNT_ID
```

## Deployment

### Option A: Via CodeBuild (recommended)

A single CDK deploy uploads the source, creates the CodeBuild project, and triggers the build automatically:

```bash
npx cdk deploy s3mrap-bootstrap \
  -c project=s3mrap -c primaryRegion=us-east-1 -c secondaryRegion=us-west-2 \
  -c accountId=ACCOUNT_ID
```

This deploys the bootstrap stack which:
1. Uploads project source to S3 as a CDK asset
2. Creates the CodeBuild project
3. Triggers the build via a custom resource

Monitor progress in the CodeBuild console.

### Option B: Direct (local)

```bash
# Deploy all stacks in order
make deploy ACCOUNT_ID=123456789012
```

### Individual Stacks

```bash
make deploy-buckets      # S3 buckets in both regions
make deploy-routing      # MRAP + bidirectional CRR
make deploy-failover     # ARC plan + routing Lambda + load test
make deploy-monitoring   # CloudWatch alarms + dashboards
```

## Stacks

| Stack | Region | Resources |
|-------|--------|-----------|
| `s3mrap-bootstrap` | us-east-1 | CodeBuild project, artifact bucket |
| `s3mrap-bucket-primary` | us-east-1 | Versioned S3 bucket |
| `s3mrap-bucket-secondary` | us-west-2 | Versioned S3 bucket |
| `s3mrap-global-routing` | us-east-1 | MRAP, CRR custom resource, replication IAM role |
| `s3mrap-routing-primary` | us-east-1 | MRAP routing Lambda |
| `s3mrap-routing-secondary` | us-west-2 | MRAP routing Lambda |
| `s3mrap-failover` | us-east-1 | ARC Region Switch Plan, load test Lambda, SSM Document |
| `s3mrap-monitoring-primary` | us-east-1 | CloudWatch alarms + dashboard, MRAP monitor Lambda |
| `s3mrap-monitoring-secondary` | us-west-2 | CloudWatch alarms + dashboard, MRAP monitor Lambda |

## Demo Walkthrough

### 1. Verify Replication

Upload a file via MRAP and confirm it appears in both regions:

```bash
# Upload via MRAP
aws s3api put-object \
  --bucket arn:aws:s3::ACCOUNT_ID:accesspoint/MRAP_ALIAS \
  --key test/hello.txt \
  --body /dev/stdin <<< "hello world"

# Check both regions
aws s3api head-object --bucket s3mrap-us-east-1-ACCOUNT_ID --key test/hello.txt --region us-east-1
aws s3api head-object --bucket s3mrap-us-west-2-ACCOUNT_ID --key test/hello.txt --region us-west-2
```

### 2. Run Load Test

Via SSM (console or CLI):

```bash
aws ssm start-automation-execution \
  --document-name s3mrap-load-test \
  --parameters '{
    "SourceRegion":["us-east-1"],
    "DestRegion":["us-west-2"],
    "ObjectCount":["50"],
    "ObjectSizeKB":["10"],
    "TimeoutSeconds":["300"]
  }' \
  --region us-east-1
```

Or invoke the Lambda directly:

```bash
aws lambda invoke \
  --function-name s3mrap-load-test \
  --payload '{"sourceRegion":"us-east-1","destRegion":"us-west-2","objectCount":50,"objectSizeKB":10,"timeoutSeconds":300}' \
  --region us-east-1 \
  /dev/stdout
```

### 3. View Dashboards

Open CloudWatch dashboards in each region:
- `s3mrap-replication-iad-to-pdx` (us-west-2)
- `s3mrap-replication-pdx-to-iad` (us-east-1)

### 4. Trigger Failover

Use the ARC Region Switch Plan in the AWS console:
1. Go to **Route 53 Application Recovery Controller** → **Region switch**
2. Select the `s3mrap-region-switch` plan
3. Choose the target region and activate

This invokes the MRAP routing Lambda, which sets the active region's traffic dial to 100% and the passive to 0%.

## Cleanup

```bash
./cleanup.sh ACCOUNT_ID PROFILE
# e.g.
./cleanup.sh 123456789012 cloudAdmin-sbx0
```

This deletes all stacks in reverse dependency order (parallel where possible), handles stuck stacks in ROLLBACK_COMPLETE/ROLLBACK_FAILED, removes the bootstrap stack last, cleans up orphaned S3 buckets, and removes local `cdk.out` directories.

## Configuration

Override defaults via environment or make variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT` | `s3mrap` | Project identifier |
| `PRIMARY_REGION` | `us-east-1` | Primary AWS region |
| `SECONDARY_REGION` | `us-west-2` | Secondary AWS region |
| `ACCOUNT_ID` | Auto-detected | AWS account ID |

## Contributing

### Running Tests

```bash
npm test    # 47 CDK assertion tests including cross-stack integration tests
```

Run tests before committing changes to catch CloudFormation template errors, cross-stack naming mismatches, and IAM policy issues before deployment.
