# Aurora Global Database — Multi-Region Resilience

Aurora PostgreSQL 16.6 Global Database spanning us-east-1 and us-west-2 with ARC Region Switch failover, CloudWatch Synthetics, RPO monitoring, post-failover reconciliation, FIS chaos testing, and load generation. All infrastructure defined in CDK (TypeScript).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GLOBAL RESOURCES                         │
│  Aurora Global Database (PostgreSQL 16.6)                       │
│  Route 53 Private Hosted Zone (demo.internal)                   │
│  ARC Region Switch Plan (activeActive)                          │
│  VPC Peering (cross-region)                                     │
└─────────────────────────────────────────────────────────────────┘

┌──────────── us-east-1 ────────────┐  ┌──────────── us-west-2 ────────────┐
│  VPC (10.0.0.0/23, isolated)      │  │  VPC (10.0.2.0/23, isolated)      │
│  8 VPC Endpoints (no IGW, no NAT) │  │  8 VPC Endpoints (no IGW, no NAT) │
│                                   │  │                                   │
│  Aurora App:                      │  │  Aurora App:                      │
│    ALB (internal, HTTP:80) ──►    │  │    ALB (internal, HTTP:80) ──►    │
│    Lambda (isolated) ──►          │  │    Lambda (isolated) ──►          │
│    DB_READ_HOST: local endpoint   │  │    DB_READ_HOST: local endpoint   │
│    DB_WRITE_HOST: global writer   │  │    DB_WRITE_HOST: global writer   │
│                                   │  │                                   │
│  Synthetics (6 canaries)          │  │  Synthetics (6 canaries)          │
│  Monitoring + RPO Monitor         │  │  Monitoring + RPO Monitor         │
│  DNS Status Lambda (not in VPC)   │  │                                   │
│  Combined Dashboard               │  │                                   │
│  Reconciliation SSM Runbooks      │  │  Reconciliation SSM Runbooks      │
│  Load Generation Lambda + SSM     │  │                                   │
│  FIS Chaos Experiments            │  │  FIS Chaos Experiments            │
└───────────────────────────────────┘  └───────────────────────────────────┘
                    │                                    │
                    └──── VPC Peering (cross-region) ────┘
```

## What's Deployed

| Stack | Region | Description |
|-------|--------|-------------|
| `aurora-bootstrap` | us-east-1 | CodeBuild project (60-min timeout), S3 artifact bucket, build trigger custom resource |
| `aurora-vpc-primary` | us-east-1 | VPC 10.0.0.0/23, isolated subnets, 8 VPC endpoints, 5 security groups |
| `aurora-vpc-secondary` | us-west-2 | VPC 10.0.2.0/23, isolated subnets, 8 VPC endpoints, 5 security groups |
| `aurora-vpc-peering` | us-east-1 | Cross-region VPC peering connection + routes |
| `aurora-db-primary` | us-east-1 | Aurora Global Cluster + writer instance (db.r6g.large), KMS key, secret replication |
| `aurora-db-secondary` | us-west-2 | Aurora reader instance joined to global cluster, regional KMS key |
| `aurora-schema` | us-east-1 | Tables, indexes, 4 stored procedures via Lambda custom resource |
| `aurora-aurora-app-primary` | us-east-1 | Internal ALB → Lambda → Aurora (read/write split via stored procedures) |
| `aurora-aurora-app-secondary` | us-west-2 | Internal ALB → Lambda → Aurora (read/write split via stored procedures) |
| `aurora-dns` | us-east-1 | Private hosted zone with latency-based + region-aligned DNS records |
| `aurora-failover-plan` | us-east-1 | ARC Region Switch plan (activeActive) with Aurora + DNS steps |
| `aurora-synthetics-primary` | us-east-1 | 6 canaries: read + write × local/remote/dns |
| `aurora-synthetics-secondary` | us-west-2 | 6 canaries: read + write × local/remote/dns |
| `aurora-monitoring-primary` | us-east-1 | 7 alarms, RPO monitor, DNS status Lambda, combined dashboard |
| `aurora-monitoring-secondary` | us-west-2 | 7 alarms, RPO monitor |
| `aurora-reconciliation-primary` | us-east-1 | Post-failover snapshot/restore/reconcile SSM runbooks |
| `aurora-reconciliation-secondary` | us-west-2 | Post-failover snapshot/restore/reconcile SSM runbooks |
| `aurora-loadgen` | us-east-1 | Load generation Lambda + SSM automation document |
| `aurora-chaos-primary` | us-east-1 | FIS: cross-region network disruption + Aurora failover |
| `aurora-chaos-secondary` | us-west-2 | FIS: cross-region network disruption + Aurora failover |

## Prerequisites

- AWS account with CDK bootstrapped in us-east-1 and us-west-2
- AWS CLI v2 configured
- Node.js 20+
- `make`, `jq`

## Deployment

```bash
npm ci
npx cdk deploy aurora-bootstrap \
  -c stack=bootstrap \
  -c project=aurora \
  -c primaryRegion=us-east-1 \
  -c secondaryRegion=us-west-2 \
  -c accountId=YOUR_ACCOUNT_ID \
  --require-approval never
```

This deploys a CodeBuild project that runs `make deploy` to orchestrate all stacks. The build trigger custom resource starts the build and polls until complete (60-min timeout, 30s poll interval).

Alternatively, deploy directly with `make deploy` if you have credentials configured for both regions.

## Testing

### CDK Assertion Tests

```bash
npx projen test    # 79 tests across 13 suites
```

### Load Test

```bash
# Find the SSM document name from the loadgen stack
SSM_DOC=$(aws cloudformation describe-stack-resources \
  --stack-name aurora-loadgen --region us-east-1 \
  --query "StackResources[?ResourceType=='AWS::SSM::Document'].PhysicalResourceId" \
  --output text)

aws ssm start-automation-execution \
  --document-name "$SSM_DOC" \
  --parameters '{"RequestsPerSecond":["10"],"DurationSeconds":["300"],"TargetApp":["aurora"],"OperationMix":["50,20,10,20"]}' \
  --region us-east-1
```

### Chaos Experiment

```bash
# Cross-region network disruption
TEMPLATE_ID=$(aws fis list-experiment-templates \
  --query "experimentTemplates[?tags.Name=='Cross-Region: Connectivity to us-west-2'].id" \
  --output text --region us-east-1)
aws fis start-experiment --experiment-template-id $TEMPLATE_ID --region us-east-1

# Aurora cluster failover
TEMPLATE_ID=$(aws fis list-experiment-templates \
  --query "experimentTemplates[?tags.Name=='Aurora Cluster Failover'].id" \
  --output text --region us-east-1)
aws fis start-experiment --experiment-template-id $TEMPLATE_ID --region us-east-1
```

## Cleanup

```bash
./cleanup.sh
```

The cleanup script tears down stacks in reverse dependency order. It handles Aurora Global Database detachment by removing all member clusters from the global cluster, waiting 60 seconds for detach to complete, then deleting the global cluster before destroying the database stacks.

## Security Suppressions

### cdk-nag (AwsSolutions)

| Rule | Reason |
|------|--------|
| AwsSolutions-IAM4 | AWSLambdaBasicExecutionRole is standard for Lambda functions |
| AwsSolutions-IAM5 | Wildcard permissions for CDK framework, FIS, cross-region ops |
| AwsSolutions-L1 | Python 3.12 stable; CDK Provider runtimes not configurable |
| AwsSolutions-RDS10 | Deletion protection disabled for demo teardown |
| AwsSolutions-RDS11 | Default ports used for demo |
| AwsSolutions-SMG4 | Non-credential secrets need no rotation |

### Checkov

| Rule | Reason |
|------|--------|
| CKV_AWS_116 | Lambda DLQ not needed — custom resource Lambdas invoked synchronously by CloudFormation |
| CKV_AWS_173 | Lambda env vars contain resource ARNs/endpoints, not secrets |

## License

MIT-0 — see [LICENSE](../LICENSE)
