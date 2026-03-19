

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
│                                   │  │                                   │
│  Aurora Global DB App:            │  │  Aurora Global DB App:            │
│    ALB (HTTP) → Lambda → Aurora   │  │    ALB (HTTP) → Lambda → Aurora   │
│                                   │  │                                   │
│                                   │  │                                   │
│  Synthetics (4 canaries)          │  │  Synthetics (4 canaries)          │
│  Monitoring + RPO Monitor         │  │  Monitoring + RPO Monitor         │
│  Reconciliation SSM Runbooks      │  │  Reconciliation SSM Runbooks      │
│  Load Generation Lambda           │  │                                   │
│  FIS Chaos Experiments            │  │  FIS Chaos Experiments            │
└───────────────────────────────────┘  └───────────────────────────────────┘
                    │                                    │
                    └──── VPC Peering (cross-region) ────┘
```

## What's Deployed

| Stack | Region | Description |
|-------|--------|-------------|
| VPC (x2) | both | Isolated subnets, 6 VPC endpoints, 5 security groups, no IGW/NAT |
| VPC Peering | us-east-1 | Cross-region peering with routes |
| Database Primary | us-east-1 | Aurora Global Cluster + writer instance (db.r6g.large) |
| Database Secondary | us-west-2 | Aurora reader instance joined to global cluster |
| Schema | us-east-1 | Tables, indexes, 4 stored procedures via Lambda custom resource |
| Aurora App (x2) | both | Internal ALB → Lambda → Aurora (CRUD via stored procedures) |
| DNS | us-east-1 | Private hosted zone with latency-based routing for both apps |
| Failover Plan | us-east-1 | ARC Region Switch with Aurora failover + DNS health check toggle |
| Synthetics (x2) | both | 4 canaries per region (local + cross-region, per app) |
| Monitoring (x2) | both | CloudWatch alarms, dashboard, RPO monitor Lambda |
| Reconciliation (x2) | both | SSM runbooks for post-failover snapshot/restore/compare |
| Load Gen | us-east-1 | Lambda + SSM doc for sustained CRUD traffic generation |
| Chaos (x2) | both | FIS experiments: network disruption + Aurora failover |

## Prerequisites

- AWS account with CDK bootstrapped in us-east-1 and us-west-2
- AWS CLI v2 configured
- Node.js 20+
- `make`, `jq`

## Deployment

```bash
npm ci
  -c stack=bootstrap \
  -c primaryRegion=us-east-1 \
  -c secondaryRegion=us-west-2 \
  -c accountId=YOUR_ACCOUNT_ID \
  --require-approval never
```

This deploys a CodeBuild project that runs `make deploy` to orchestrate all 23 stacks.

## Testing

### Run Tests Locally
```bash
npx projen test    # 87 CDK assertion tests
```

### Run Load Test
```bash
aws ssm start-automation-execution \
  --parameters '{"RequestsPerSecond":["10"],"DurationSeconds":["300"],"TargetApp":["both"]}' \
  --region us-east-1
```

### Run Chaos Experiment
```bash
# Get experiment template ID
TEMPLATE_ID=$(aws fis list-experiment-templates --query "experimentTemplates[?tags.Name=='Cross-Region: Connectivity to us-west-2'].id" --output text --region us-east-1)

# Start experiment
aws fis start-experiment --experiment-template-id $TEMPLATE_ID --region us-east-1
```

## Cleanup

```bash
./cleanup.sh
```

## Security

| Rule | Explanation |
|------|-------------|
| AwsSolutions-IAM4 | AWS managed policies used for demo simplicity |
| AwsSolutions-IAM5 | Wildcard permissions for CDK framework, FIS experiments |
| AwsSolutions-RDS10 | Deletion protection disabled for demo teardown |
| AwsSolutions-RDS11 | Default ports used for demo |
| AwsSolutions-SMG4 | Non-credential secrets (ARNs, endpoints) don't require rotation |
| AwsSolutions-L1 | Python 3.12 stable; CDK Provider runtimes not configurable |

## License

MIT-0 — see [LICENSE](LICENSE)
