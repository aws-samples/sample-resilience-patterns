# Design: Aurora Global Database — Multi-Region Resilience Demo

## Architecture

```
GitHub Actions                             AWS
──────────────                             ───
Push to non-main branch ──► Build workflow (compile + test + synth)
Pull Request ──────────────► E2E workflow:
                               ├─ Build + test
                               │    ├─ deploy-vpc            (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-vpc-peering    (sequential)
                               │    ├─ deploy-database       (us-east-1 primary, then us-west-2 secondary)
                               │    ├─ deploy-schema         (us-east-1, runs migration)
                               │    ├─ deploy-aurora-app     (us-east-1 + us-west-2, sequential)
                               │    ├─ deploy-dns            (sequential, no health checks)
                               │    ├─ deploy-failover-plan  (sequential, captures health check IDs)
                               │    ├─ deploy-dns-with-hc    (sequential, wires health checks)
                               │    ├─ deploy-synthetics     (us-east-1 + us-west-2, sequential)
                               │    ├─ deploy-monitoring     (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-reconciliation (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-loadgen        (sequential)
                               │    └─ deploy-chaos          (us-east-1 + us-west-2, parallel)
                               ├─ Run Synthetics canaries (read-only health + query)
                               ├─ Verify: replication lag, metrics, alarms
                               └─ Cleanup (on success only)
Manual trigger ────────────► Cleanup workflow (cleanup.sh)
```

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
│  7 VPC Endpoints (no IGW, no NAT) │  │  7 VPC Endpoints (no IGW, no NAT) │
│                                   │  │                                   │
│  Aurora App:                      │  │  Aurora App:                      │
│    ALB (internal, HTTP:80) ──►   │  │    ALB (internal, HTTP:80) ──►   │
│    Lambda (isolated) ──►          │  │    Lambda (isolated) ──►          │
│    Aurora Primary (writer)        │  │    Aurora Secondary (reader)      │
│                                   │  │    (DB_HOST_OVERRIDE → reader)    │
│  Synthetics (3 canaries):         │  │  Synthetics (3 canaries):         │
│    al → aurora-app-use1 (local)   │  │    al → aurora-app-usw2 (local)   │
│    ar → aurora-app-usw2 (remote)  │  │    ar → aurora-app-use1 (remote)  │
│    ad → aurora-app (dns/ARC)      │  │    ad → aurora-app (dns/ARC)      │
│  Schema Migration Lambda          │  │                                   │
│  RPO Monitor Lambda               │  │  RPO Monitor Lambda               │
│  CloudWatch Dashboard + 8 Alarms  │  │  CloudWatch Dashboard + 8 Alarms  │
│  Reconciliation SSM + Lambda      │  │  Reconciliation SSM + Lambda      │
│  Load Generation Lambda + SSM     │  │                                   │
│  FIS Experiments (network, Aurora) │  │  FIS Experiments (network, Aurora) │
│  Secrets Manager (DB creds)       │  │  Secrets Manager (replicated)     │
└───────────────────────────────────┘  └───────────────────────────────────┘
                    │                                    │
                    └──── VPC Peering (cross-region) ────┘
```

## CDK Stacks

### BootstrapStack
- CodeBuild project (aws/codebuild/standard:7.0)
- S3 artifact bucket encrypted with local CMK
- IAM role scoped to: sts:AssumeRole on cdk-*, cloudformation:DescribeStacks/ListStacks, ssm:GetParameter on cdk-bootstrap/*
- BucketDeployment to upload source as CDK asset
- Build trigger custom resource (Lambda-backed): onEvent + isComplete, 30s poll, 30min timeout
- buildspec.yml: npm ci, ts-node install, make deploy

### VpcStack (per region)
- VPC with 2 AZs, isolated subnets only (/23 CIDR, /24 subnets)
- Non-overlapping CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23
- 6 VPC Interface endpoints: CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics
- 1 VPC Gateway endpoint: S3
- Security groups: ALB, Database, Lambda, VPC Endpoint, Synthetics

### VpcPeeringStack
- Cross-region VPC peering connection (requester in us-east-1, accepter in us-west-2)
- Route table entries in both VPCs: cross-region CIDR → peering connection

### DatabaseStack (primary)
- Aurora Global Database cluster (PostgreSQL 16.6)
- Primary Aurora cluster with one db.r6g.large writer instance
- Customer-managed KMS key, Secrets Manager credentials (30-day rotation)

### DatabaseReplicaStack (secondary)
- Secondary Aurora cluster joined to Global Database
- One db.r6g.large reader instance, regional KMS key

### SchemaStack
- Lambda-backed custom resource for schema migration
- Creates orders table, replication_tracking table, 4 stored procedures
- VPC-deployed, idempotent

### AuroraAppStack (per region)
- Internal ALB (HTTP:80, isolated subnets) + Lambda target group
- Python 3.12 Lambda with CRUD handler calling stored procedures
- Secondary region uses DB_HOST_OVERRIDE for reader endpoint
- Secret replicated to us-west-2 for cross-region access
- Reserved concurrency: 5, timeout: 60s

### DnsStack
- Route 53 private hosted zone: `demo.internal` (associated with both VPCs)
- `aurora-app.demo.internal` — latency-based A-alias records (PrimaryRegion + StandbyRegion)
- `aurora-app-use1.demo.internal` — simple A-alias to us-east-1 ALB
- `aurora-app-usw2.demo.internal` — simple A-alias to us-west-2 ALB
- ARC health check IDs attached in second deployment pass

### FailoverPlanStack
- AWS::ARCRegionSwitch::Plan with activeActive recovery
- Execution role for arc-region-switch.amazonaws.com
- Deactivate: AuroraGlobalDatabase block (switchoverOnly, ungraceful: failover) → Route53HealthCheck block
- Activate: Route53HealthCheck block (restore DNS)

### SyntheticsStack (per region)
- 3 canaries per region, all read-only (health + query):
  - `al` (local) → region-aligned record for own region
  - `ar` (remote) → region-aligned record for opposite region (via VPC peering)
  - `ad` (dns) → `aurora-app.demo.internal` (ARC-managed routing)
- Runtime: syn-python-selenium-10.0
- KMS-encrypted artifact bucket, CloudWatch alarm per canary

### MonitoringStack (per region)
- 5 Aurora alarms: ReplicaLag, ReplicaLagMax, CPU, FreeMemory, CommitLatency
- 2 RPO alarms: CatalogMissingRows, CatalogRPOHeartbeat
- 1 engine version alarm: AuroraEngineVersionMismatch
- SNS alarm topic (KMS encrypted)
- RPO Monitor Lambda (Python 3.12, every 5 min): cross-region row comparison + heartbeat + engine version check
- Dashboard: replica lag, missing rows (FILL REPEAT), heartbeat (no FILL), CPU, commit latency, memory, engine version alignment

### ReconciliationStack (per region)
- Snapshot & Copy SSM Document (primary): takes Aurora snapshot, copies cross-region with KMS
- Restore & Reconcile SSM Document (standby): restores snapshot → temp cluster → reconciliation Lambda
- Reconciliation Lambda: compares order IDs, produces missing transaction report

### LoadGenStack
- Load generation Lambda (Python 3.12, 15-min timeout, 512MB, reserved concurrency 10)
- SSM Automation Document for operator invocation
- VPC-deployed with ALB access

### ChaosStack (per region)
- FIS experiment templates: cross-region network disruption + Aurora cluster failover
- FIS IAM role, KMS-encrypted log group (7-day retention)
- ChaosAllowed tags on target resources

## Deployment Order (Makefile)

```
deploy-vpc                  (parallel: vpc-primary + vpc-secondary)
    │
deploy-vpc-peering          (sequential: peering connection + routes)
    │
deploy-database             (sequential: db-primary, then db-secondary)
    │
deploy-schema               (sequential: schema migration against primary writer)
    │
deploy-aurora-app           (sequential: aurora-app-primary, then aurora-app-secondary)
    │
deploy-dns                  (sequential: PHZ + latency-based + region-aligned records, no health checks)
    │
deploy-failover-plan        (sequential: ARC Region Switch Plan, captures health check IDs)
    │
deploy-dns-with-hc          (sequential: re-deploy DNS with ARC health check IDs)
    │
deploy-synthetics           (sequential: synthetics-primary, then synthetics-secondary)
    │
deploy-monitoring           (parallel: monitoring-primary + monitoring-secondary)
    │
deploy-reconciliation       (parallel: reconciliation-primary + reconciliation-secondary)
    │
deploy-loadgen              (sequential: load generation Lambda + SSM doc)
    │
deploy-chaos                (parallel: chaos-primary + chaos-secondary)
```

Parallel deploys use separate `-o cdk.out.*` directories to avoid CDK lock conflicts.
PID-based `wait` propagates failures. Shell variables captured via `aws cloudformation describe-stacks`.

## Cross-Stack Data Flow

- VPC IDs, subnet IDs, security group IDs: CloudFormation outputs from VpcStack, passed as CDK context
- Database endpoints: CloudFormation outputs from DatabaseStack
- Secret ARN: CloudFormation output from DatabaseStack, passed to AuroraAppStack, SchemaStack, MonitoringStack
- KMS key ARNs: CloudFormation outputs, passed to dependent stacks
- Hosted zone ID: CloudFormation output from DnsStack, passed to FailoverPlanStack
- ARC health check IDs: retrieved from ARC plan via `arc-region-switch list-route53-health-checks`, passed back to DnsStack on second deploy
- Global cluster identifier: convention-based (`{project}-global-cluster`)
- Regional cluster ARNs: resolved via `aws rds describe-db-clusters`
- VPC peering connection ID: CloudFormation output from VpcPeeringStack
- Cross-region VPC CIDR: passed as CDK context for security group rules and route tables

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

## Stored Procedures

- `sp_insert_order(p_region, p_status, p_payload)` → returns UUID
- `sp_update_order_status(p_id, p_status)` → soft update with timestamp
- `sp_delete_order(p_id)` → soft delete
- `sp_query_orders(p_region, p_status, p_since)` → filtered query excluding deleted

## Cleanup

Standalone `cleanup.sh` script (reverse deployment order):
1. Delete stuck stacks (ROLLBACK_COMPLETE/ROLLBACK_FAILED)
2. Destroy chaos stacks (parallel)
3. Destroy loadgen stack
4. Destroy reconciliation stacks (parallel, clean up temp clusters)
5. Destroy monitoring stacks (parallel)
6. Destroy synthetics stacks (parallel)
7. Destroy failover plan stack
8. Destroy DNS stack
9. Destroy Aurora app stacks (parallel)
10. Destroy schema stack
11. Destroy database secondary (leave global cluster before deletion)
12. Destroy database primary + global cluster
13. Destroy VPC peering stack
14. Destroy VPC stacks (parallel)
15. Destroy bootstrap stack
16. Clean orphaned S3 buckets
17. Remove local cdk.out directories

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
│   └── app.ts                    # CDK app entry point, cdk-nag opt-in
├── lib/
│   ├── imports.ts                # VPC/SG import helpers
│   ├── bootstrap-stack.ts        # CodeBuild project + local CMK + build trigger
│   ├── vpc-stack.ts              # VPC per region (isolated subnets, 7 endpoints)
│   ├── vpc-peering-stack.ts      # Cross-region VPC peering + routes
│   ├── database-stack.ts         # Aurora Global DB primary cluster
│   ├── database-replica-stack.ts # Aurora Global DB secondary cluster
│   ├── schema-stack.ts           # Schema migration custom resource
│   ├── aurora-app-stack.ts       # Aurora app: ALB + Lambda
│   ├── dns-stack.ts              # PHZ + latency-based + region-aligned DNS records
│   ├── failover-plan-stack.ts    # ARC Region Switch Plan (activeActive)
│   ├── synthetics-stack.ts       # CloudWatch Synthetics canaries (3 per region)
│   ├── monitoring-stack.ts       # Alarms + dashboard + RPO monitor
│   ├── reconciliation-stack.ts   # Post-failover snapshot/restore/reconcile SSM docs
│   ├── loadgen-stack.ts          # Load generation Lambda + SSM doc
│   └── chaos-stack.ts            # FIS experiment templates
├── lambda/
│   ├── build-trigger/index.py    # CodeBuild start + poll for completion
│   ├── schema-migration/index.py # Database schema + stored procedures
│   ├── aurora-app/index.py       # Aurora CRUD handler (ALB target)
│   ├── rpo-monitor/index.py      # RPO: cross-region row comparison + heartbeat + engine version
│   ├── reconciliation/index.py   # Post-failover: compare rows, missing txn report
│   └── loadgen/index.py          # Load generation: sustained CRUD traffic via ALB
├── test/
│   ├── bootstrap.test.ts
│   ├── vpc.test.ts
│   ├── database.test.ts
│   ├── database-replica.test.ts
│   ├── schema.test.ts
│   ├── aurora-app.test.ts
│   ├── dns.test.ts
│   ├── failover-plan.test.ts
│   ├── synthetics.test.ts
│   ├── monitoring.test.ts
│   ├── chaos.test.ts
│   ├── reconciliation.test.ts
│   └── loadgen.test.ts
├── Makefile                      # Parallel deploys, variable capture
├── buildspec.yml                 # CodeBuild: npm ci, ts-node, make deploy
├── cleanup.sh                    # Reliable teardown (reverse order)
├── .checkov.yaml                 # Checkov skip rules with justifications
├── cdk.json
├── tsconfig.json
├── tsconfig.dev.json
├── package.json
├── LICENSE                       # MIT-0
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── README.md
```
