# Design: Aurora Global Database + Aurora DSQL — Multi-Region Resilience Demo

## Architecture

```
GitHub Actions                             AWS
──────────────                             ───
Push to non-main branch ──► Build workflow (compile + test + synth)
Pull Request ──────────────► E2E workflow:
                               ├─ Build + test
                               ├─ cdk deploy aurora-dsql-bootstrap ──► CodeBuild (make deploy)
                               │    ├─ deploy-vpc            (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-vpc-peering    (sequential)
                               │    ├─ deploy-database       (us-east-1 primary, then us-west-2 secondary)
                               │    ├─ deploy-dsql           (us-east-1 + us-west-2)
                               │    ├─ deploy-schema         (us-east-1, runs migration)
                               │    ├─ deploy-aurora-app     (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-dsql-app       (us-east-1 + us-west-2, parallel)
                               │    ├─ deploy-dns            (sequential, no health checks)
                               │    ├─ deploy-failover-plan  (sequential, captures health check IDs)
                               │    ├─ deploy-dns-with-hc    (sequential, wires health checks)
                               │    ├─ deploy-synthetics     (us-east-1 + us-west-2, parallel)
                               │    └─ deploy-monitoring     (us-east-1 + us-west-2, parallel)
                               ├─ Run Synthetics canaries (CRUD operations + replication verification)
                               ├─ Verify: replication lag, metrics, alarms
                               └─ Cleanup (on success only)
Manual trigger ────────────► Cleanup workflow (cleanup.sh)
```

```
┌─────────────────────────────────────────────────────────────────┐
│                        GLOBAL RESOURCES                         │
│  Aurora Global Database (PostgreSQL)                             │
│    └─► Primary Cluster (us-east-1) + Secondary Cluster (us-west-2) │
│  Aurora DSQL                                                     │
│    └─► Multi-region active-active (us-east-1 + us-west-2)      │
│  Route 53 Private Hosted Zone (demo.internal)                    │
│    └─► aurora-app.demo.internal → active-region ALB             │
│    └─► dsql-app.demo.internal → active-region ALB               │
│  ARC Region Switch Plan (activePassive)                          │
│    └─► AuroraGlobalDatabase block + Route53HealthCheck block     │
└─────────────────────────────────────────────────────────────────┘

┌──────────── us-east-1 ────────────┐  ┌──────────── us-west-2 ────────────┐
│  VPC (2 AZ, private/isolated)     │  │  VPC (2 AZ, private/isolated)     │
│  VPC Endpoints (no IGW, no NAT)   │  │  VPC Endpoints (no IGW, no NAT)   │
│                                   │  │                                   │
│  Aurora Global DB App:            │  │  Aurora Global DB App:            │
│    ALB (internal, HTTP) ──►      │  │    ALB (internal, HTTP) ──►      │
│    Lambda (isolated) ──►          │  │    Lambda (isolated) ──►          │
│    Aurora Primary (writer)        │  │    Aurora Secondary (reader)      │
│                                   │  │                                   │
│  DSQL App:                        │  │  DSQL App:                        │
│    ALB (internal, HTTP) ──►      │  │    ALB (internal, HTTP) ──►      │
│    Lambda (isolated) ──►          │  │    Lambda (isolated) ──►          │
│    Aurora DSQL Endpoint           │  │    Aurora DSQL Endpoint           │
│                                   │  │                                   │
│  Synthetics Canaries ──► ALBs     │  │  Synthetics Canaries ──► ALBs     │
│    (local + cross-region DNS)     │  │    (local + cross-region DNS)     │
│  Schema Migration Lambda          │  │                                   │
│  RPO Monitor Lambda               │  │  RPO Monitor Lambda               │
│  CloudWatch Dashboard             │  │  CloudWatch Dashboard             │
│  CloudWatch Alarms                │  │  CloudWatch Alarms                │
│  Secrets Manager (DB creds)       │  │  Secrets Manager (DB creds)       │
└───────────────────────────────────┘  └───────────────────────────────────┘
                    │                                    │
                    └──── VPC Peering (cross-region) ────┘
```

## CDK Stacks

### 1. BootstrapStack (`aurora-dsql-bootstrap`, us-east-1)
- CodeBuild project (aws/codebuild/standard:7.0 image)
- S3 artifact bucket encrypted with local CMK
- IAM role scoped to: sts:AssumeRole on cdk-*, cloudformation:DescribeStacks/ListStacks, ssm:GetParameter on cdk-bootstrap/*, artifact bucket read
- BucketDeployment to upload source as CDK asset
- Build trigger custom resource (Lambda-backed):
  - On Create/Update: starts CodeBuild `make deploy`, polls until complete
  - On Delete: completes immediately (cleanup via cleanup.sh)
  - Uses Provider framework with `onEvent` + `isComplete` handlers
  - 30-second poll interval, 30-minute total timeout
- buildspec.yml: npm ci, ts-node install, make deploy

### 2. VpcStack (`aurora-dsql-vpc-{region}`, per region)
- VPC with 2 AZs, isolated subnets only (no public, no private, no IGW, no NAT)
- Non-overlapping CIDRs: us-east-1 = 10.0.0.0/23, us-west-2 = 10.0.2.0/23
- Isolated subnets: ALBs, Lambdas, Aurora clusters (single tier — no internet route exists)
- VPC Interface endpoints: CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda, Synthetics, ELB
- VPC Gateway endpoint: S3
- Security groups:
  - ALB SG: inbound 80 from local Synthetics SG + cross-region Synthetics CIDR
  - Database SG: inbound 5432 from Lambda SG
  - Lambda SG: inbound from ALB SG, outbound to Database SG + VPC Endpoint SG (443)
  - VPC Endpoint SG: inbound 443 from Lambda SG
  - Synthetics SG: outbound 80 to local ALB SG + cross-region ALB CIDR
- Outputs: VpcId, VpcCidr, IsolatedSubnetIds, SecurityGroupIds

### 3. VpcPeeringStack (`aurora-dsql-vpc-peering`, us-east-1)
- VPC peering connection between us-east-1 and us-west-2 VPCs
- Peering accepter in us-west-2 (cross-region peering)
- Route table entries in both VPCs: cross-region CIDR → peering connection
- Depends on both VpcStacks
- Outputs: PeeringConnectionId

### 4. DatabaseStack (`aurora-dsql-db-primary`, us-east-1)
- Aurora Global Database cluster (PostgreSQL engine)
- Primary Aurora cluster with one writer instance
- Customer-managed KMS key for encryption
- Subnet group using isolated subnets from VpcStack
- Master credentials stored in Secrets Manager (auto-generated, KMS-encrypted)
- Secret rotation (30-day interval)
- Deletion protection (configurable)
- Outputs: GlobalClusterArn, ClusterEndpoint, ClusterReaderEndpoint, SecretArn

### 5. DatabaseReplicaStack (`aurora-dsql-db-secondary`, us-west-2)
- Secondary Aurora cluster joined to Global Database
- One reader instance
- Regional KMS key for encryption
- Subnet group using isolated subnets from VpcStack
- Outputs: ClusterReaderEndpoint

### 6. DsqlStack (`aurora-dsql-dsql`, us-east-1 + us-west-2)
- Aurora DSQL cluster configuration
- Multi-region linked clusters
- IAM authentication setup
- Outputs: DsqlEndpoints

### 7. SchemaStack (`aurora-dsql-schema`, us-east-1)
- Lambda-backed custom resource for database schema migration
- Creates orders table, replication_tracking table
- Creates stored procedures: sp_insert_order, sp_update_order_status, sp_delete_order, sp_query_orders
- VPC-deployed Lambda with database SG access
- Runs on stack create/update
- Idempotent (CREATE OR REPLACE for procedures, IF NOT EXISTS for tables)

### 8. AuroraAppStack (`aurora-dsql-aurora-app-{region}`, per region)
- Internal ALB in isolated subnets with HTTP listener
- Lambda target group for Aurora Global Database application
- Routes: POST /orders, PUT /orders/{id}/status, DELETE /orders/{id}, GET /orders, GET /health
- Lambda (Python, isolated subnets) connects to Aurora Global Database
  - Primary region: writer endpoint
  - Secondary region: reader endpoint
- IAM role with Secrets Manager read, KMS decrypt
- Security group allows inbound from ALB SG, outbound to Database SG + VPC Endpoint SG
- Reserved concurrency: 5, timeout: 60s
- All AWS API calls routed through VPC endpoints
- Outputs: ALB DNS name, ALB ARN

### 9. DsqlAppStack (`aurora-dsql-dsql-app-{region}`, per region)
- Internal ALB in isolated subnets with HTTP listener
- Lambda target group for Aurora DSQL application
- Routes: POST /orders, PUT /orders/{id}/status, DELETE /orders/{id}, GET /orders, GET /health
- Lambda (Python, isolated subnets) connects to Aurora DSQL endpoint
- IAM authentication for DSQL (no stored secrets)
- Security group allows inbound from ALB SG, outbound to Database SG + VPC Endpoint SG
- Reserved concurrency: 5, timeout: 60s
- All AWS API calls routed through VPC endpoints
- Outputs: ALB DNS name, ALB ARN

### 10. DnsStack (`aurora-dsql-dns`, us-east-1)
- Route 53 private hosted zone: `demo.internal`
- Associated with both regional VPCs (us-east-1 + us-west-2)
- Latency-based routing A-alias records (two per app, one per region):
  - `aurora-app.demo.internal` → primary ALB (SetIdentifier: PrimaryRegion) + secondary ALB (SetIdentifier: StandbyRegion)
  - `dsql-app.demo.internal` → primary ALB (SetIdentifier: PrimaryRegion) + secondary ALB (SetIdentifier: StandbyRegion)
- ARC-managed health check IDs attached in second deployment pass (after plan creation)
- Outputs: HostedZoneId, record names

### 11. FailoverPlanStack (`aurora-dsql-failover-plan`, us-east-1)
- AWS::ARCRegionSwitch::Plan with activePassive recovery
- Execution role for arc-region-switch.amazonaws.com with permissions:
  - rds: FailoverGlobalCluster, SwitchoverGlobalCluster, DescribeGlobalClusters, DescribeDBClusters
  - route53: ChangeResourceRecordSets, GetHostedZone, ListResourceRecordSets, GetHealthCheck, UpdateHealthCheck
  - arc-region-switch: GetPlan, GetPlanExecution, ListPlanExecutions
- Deactivate workflow steps:
  1. `failover-aurora-db` — AuroraGlobalDatabase block (switchoverOnly, ungraceful: failover)
  2. `shift-dns-traffic-away` — Route53HealthCheck block (toggles health checks for both apps)
- Activate workflow steps:
  1. `restore-dns-traffic` — Route53HealthCheck block (re-enables health checks)
- Two-phase deployment: Makefile deploys DNS stack first, then plan, then re-deploys DNS with ARC health check IDs
- Outputs: PlanArn, ARC-managed health check IDs

### 12. SyntheticsStack (`aurora-dsql-synthetics-{region}`, per region)
- Four CloudWatch Synthetics canaries per region:
  - aurora-local: calls same-region Aurora app ALB directly
  - aurora-cross: calls `aurora-app.demo.internal` (resolves to active-region ALB via private hosted zone)
  - dsql-local: calls same-region DSQL app ALB directly
  - dsql-cross: calls `dsql-app.demo.internal` (resolves to active-region ALB via private hosted zone)
- Canary scripts exercise all CRUD endpoints and validate HTTP responses
- Configurable schedule (default: every 5 minutes)
- Canary artifact S3 bucket (KMS encrypted)
- CloudWatch alarms on canary SuccessPercent per canary (threshold: 100%)
- Deployed in VPC with Synthetics SG (outbound 80 to local ALB SG + cross-region CIDR)
- Cross-region ALB DNS names passed as props from opposite-region AppStacks

### 13. MonitoringStack (`aurora-dsql-monitoring-{region}`, per region)
- CloudWatch Alarms:
  - AuroraReplicaLag (threshold: 1000ms)
  - AuroraReplicaLagMaximum (threshold: 2000ms)
  - DatabaseConnections (threshold: configurable)
  - CPUUtilization (threshold: 80%)
  - FreeableMemory (threshold: low-water mark)
  - CommitLatency (threshold: configurable)
- SNS alarm topic (KMS encrypted) — ALARM + OK actions
- CloudWatch Dashboard:
  - RPO replication lag (AuroraReplicaLag) — line graph with threshold annotation
  - AuroraReplicaLagMaximum
  - RPO time series: CatalogMissingRows from both regions — FILL(REPEAT), safe because each datapoint is an atomic cross-region comparison
  - RPO single value: CatalogMissingRows latest per region — no FILL, quick glance
  - Heartbeat time series: CatalogRPOHeartbeat from both regions — no FILL, gaps immediately when Lambda stops (staleness indicator)
  - Database connections
  - CPU utilization
  - Commit latency (avg + p99)
  - Freeable memory
  - Read/write IOPS
  - Cross-region metric references
- RPO Monitor Lambda (runs every 5 min via EventBridge):
  - Connects to local Aurora (reader) + remote Aurora (reader/writer) in single invocation
  - Compares row IDs across tables, computes delta ("rows remote has that I don't")
  - Publishes CatalogMissingRows metric (delta count)
  - Publishes CatalogRPOHeartbeat metric (value=1)
  - VPC-deployed, cross-region DB connectivity, reserved concurrency 5

### 14. ReconciliationStack (`aurora-dsql-reconciliation`, deployed in both regions)
- **Snapshot & Copy SSM Document** (primary region):
  - Takes Aurora cluster snapshot, copies cross-region with KMS encryption
  - IAM role for SSM Automation with RDS snapshot + cross-region copy permissions
- **Restore & Reconcile SSM Document** (standby region):
  - Restores snapshot into temporary reconciliation cluster + instance
  - Waits for cluster availability
  - Invokes reconciliation Lambda
- Reconciliation Lambda (Python, VPC-deployed):
  - Connects to restored snapshot cluster and new primary cluster
  - Compares order IDs, produces missing transaction report
  - Secrets Manager access for DB credentials, reserved concurrency 5
- IAM roles scoped to RDS snapshot/restore/describe, KMS, Lambda invoke
- Outputs: SSM Document names

### 15. LoadGenStack (`aurora-dsql-loadgen`, us-east-1)
- Load generation Lambda (Python, 15-min timeout, 512MB, reserved concurrency 10)
- Generates CRUD traffic against Aurora and DSQL app ALB endpoints
- Configurable: RPS, duration, operation mix, target app
- Publishes CloudWatch metrics: requests sent, errors, latency (avg/p50/p99)
- SSM Automation Document with named String parameters for operator invocation
- VPC-deployed with access to ALB endpoints
- Outputs: Lambda ARN, SSM Document name

### 16. ChaosStack (`aurora-dsql-chaos-{region}`, per region)- FIS experiment templates:
  - Cross-region network disruption: `aws:network:route-table-disrupt-cross-region-connectivity` on subnets
  - Aurora cluster failover: `aws:rds:failover-db-cluster` on Aurora DB cluster
- FIS experiment IAM role with scoped policies (route table manipulation, RDS failover, tag resolution)
- ChaosAllowed tags on target subnets and DB clusters
- FIS log group (KMS encrypted, 7-day retention)
- Configurable duration (default: PT20M)
- Outputs: ExperimentTemplateIds

## Deployment Order (Makefile)

```
deploy-vpc                  (parallel: vpc-primary + vpc-secondary)
    │
deploy-vpc-peering          (sequential: peering connection + routes in both VPCs)
    │
deploy-database             (sequential: db-primary, then db-secondary joins global cluster)
    │
deploy-dsql                 (sequential or parallel depending on DSQL linking requirements)
    │
deploy-schema               (sequential: schema migration against primary writer)
    │
deploy-aurora-app           (parallel: aurora-app-primary + aurora-app-secondary)
    │
deploy-dsql-app             (parallel: dsql-app-primary + dsql-app-secondary)
    │
deploy-dns                  (sequential: private hosted zone + latency-based records, no health checks yet)
    │
deploy-failover-plan        (sequential: ARC Region Switch Plan, captures health check IDs)
    │
deploy-dns-with-healthchecks (sequential: re-deploy DNS stack with ARC health check IDs wired to records)
    │
deploy-synthetics           (parallel: synthetics-primary + synthetics-secondary)
    │
deploy-monitoring           (parallel: monitoring-primary + monitoring-secondary)
    │
deploy-reconciliation       (both regions: SSM docs + reconciliation Lambda)
    │
deploy-loadgen              (sequential: load generation Lambda + SSM doc)
    │
deploy-chaos                (parallel: chaos-primary + chaos-secondary)
```

Parallel deploys use separate `-o cdk.out.*` directories to avoid CDK lock conflicts.
Each parallel group uses PID-based `wait` to propagate failures.
Shell variables captured via `aws cloudformation describe-stacks` and exported for backgrounded processes.

## Cross-Stack Data Flow

- VPC IDs, subnet IDs, security group IDs: CloudFormation outputs from VpcStack, passed as CDK context or props
- Database endpoints: CloudFormation outputs from DatabaseStack
- Secret ARN: CloudFormation output from DatabaseStack, passed to AuroraAppStack and SchemaStack
- KMS key ARNs: CloudFormation outputs, passed to dependent stacks
- DSQL endpoints: CloudFormation outputs from DsqlStack, passed to DsqlAppStack
- ALB DNS names + ALB hosted zone IDs: CloudFormation outputs from AuroraAppStack/DsqlAppStack, passed to DnsStack and SyntheticsStack
- Hosted zone ID: CloudFormation output from DnsStack, passed to FailoverPlanStack
- ARC health check IDs: retrieved from ARC plan via `arc-region-switch list-route53-health-checks`, passed back to DnsStack on second deploy
- Global cluster identifier: convention-based, referenced by FailoverPlanStack
- Regional cluster ARNs: stored in SSM/Secrets Manager, resolved by FailoverPlanStack
- VPC peering connection ID: CloudFormation output from VpcPeeringStack
- Cross-region VPC CIDR: passed as CDK context for security group rules and route tables

## Database Schema

```sql
-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_orders_region ON orders(region);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- Replication tracking table
CREATE TABLE IF NOT EXISTS replication_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_region VARCHAR(20) NOT NULL,
    txn_id BIGINT NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replicated_at TIMESTAMPTZ
);

CREATE INDEX idx_repl_tracking_source ON replication_tracking(source_region);
CREATE INDEX idx_repl_tracking_committed ON replication_tracking(committed_at);
```

## Stored Procedures

```sql
-- Insert a new order
CREATE OR REPLACE FUNCTION sp_insert_order(
    p_region VARCHAR,
    p_status VARCHAR DEFAULT 'PENDING',
    p_payload JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO orders (region, status, payload)
    VALUES (p_region, p_status, p_payload)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Update order status
CREATE OR REPLACE FUNCTION sp_update_order_status(
    p_id UUID,
    p_status VARCHAR
) RETURNS VOID AS $$
BEGIN
    UPDATE orders SET status = p_status, updated_at = NOW()
    WHERE id = p_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Soft-delete an order
CREATE OR REPLACE FUNCTION sp_delete_order(
    p_id UUID
) RETURNS VOID AS $$
BEGIN
    UPDATE orders SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = p_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Query orders with optional filters
CREATE OR REPLACE FUNCTION sp_query_orders(
    p_region VARCHAR DEFAULT NULL,
    p_status VARCHAR DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL
) RETURNS SETOF orders AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM orders
    WHERE deleted_at IS NULL
      AND (p_region IS NULL OR region = p_region)
      AND (p_status IS NULL OR status = p_status)
      AND (p_since IS NULL OR created_at >= p_since);
END;
$$ LANGUAGE plpgsql;
```

## GitHub Actions Workflows

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `aurora-dsql: build` | Push to non-main branches (`aurora-dsql/**`) | compile + tests + synth |
| `aurora-dsql: e2e` | Pull requests + manual | Deploy → run Synthetics canaries → verify replication + metrics → cleanup on success |
| `aurora-dsql: cleanup` | Manual only | Run cleanup.sh |

- AWS OIDC authentication via `aws-actions/configure-aws-credentials`
- CDK bootstrap is a prerequisite (one-time manual setup per account/region)
- E2E skips cleanup on failure to preserve stacks for troubleshooting

## Security Compliance

- cdk-nag AwsSolutionsChecks enabled via `-c nag=true` in bin/app.ts
- Global NagSuppressions applied per stack in bin/app.ts with justification strings
- Checkov `.checkov.yaml` at project root with documented skip rules
- cfn_nag Metadata blocks on resources requiring inline suppression
- README Security section with suppression table (rule ID, cause, explanation) matching reference project format

## Projen Configuration

- `AwsCdkTypeScriptApp` with npm package manager
- `github: false` — workflows managed at repo root for monorepo compatibility
- `eslint: false` — disabled for consistency with other samples
- `srcdir: '.'`, `libdir: '.'` — source at project root
- `appEntrypoint: 'bin/app.ts'`
- Jest configuration managed by projen

## Cleanup

Standalone `cleanup.sh` script:
1. Delete stuck stacks (ROLLBACK_COMPLETE/ROLLBACK_FAILED)
2. Destroy chaos stacks (parallel)
3. Destroy reconciliation stacks (parallel, clean up any temp reconciliation clusters)
4. Destroy monitoring stacks (parallel)
3. Destroy synthetics stacks (parallel)
4. Destroy failover plan stack
5. Destroy DNS stack
7. Destroy DSQL app stacks (parallel)
8. Destroy Aurora app stacks (parallel)
9. Destroy schema stack
10. Destroy DSQL stack
11. Destroy database secondary (must leave global cluster before deletion)
12. Destroy database primary + global cluster
13. Destroy VPC peering stack
14. Destroy VPC stacks (parallel)
15. Destroy bootstrap stack
16. Clean orphaned S3 buckets
17. Remove local cdk.out directories

## Project Structure

```
aurora-dsql/
├── .projenrc.ts                  # Projen project configuration
├── .projen/                      # Projen-managed files
├── .specs/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
├── bin/
│   └── app.ts                    # CDK app entry point, cdk-nag opt-in
├── lib/
│   ├── bootstrap-stack.ts         # CodeBuild project + local CMK + build trigger
│   ├── vpc-stack.ts              # VPC per region
│   ├── vpc-peering-stack.ts      # Cross-region VPC peering + routes
│   ├── database-stack.ts         # Aurora Global DB primary cluster
│   ├── database-replica-stack.ts # Aurora Global DB secondary cluster
│   ├── dsql-stack.ts             # Aurora DSQL multi-region
│   ├── schema-stack.ts           # Schema migration custom resource
│   ├── app-stack.ts              # Test application Lambda
│   ├── aurora-app-stack.ts        # Aurora Global DB app: ALB + Lambda
│   ├── dsql-app-stack.ts          # Aurora DSQL app: ALB + Lambda
│   ├── dns-stack.ts               # Private hosted zone + latency-based DNS records
│   ├── failover-plan-stack.ts     # ARC Region Switch Plan (native Aurora + Route53 blocks)
│   ├── synthetics-stack.ts        # CloudWatch Synthetics canaries (both apps)
│   ├── monitoring-stack.ts        # Alarms + dashboard + RPO metrics
│   ├── reconciliation-stack.ts    # Post-failover snapshot/restore/reconcile SSM docs
│   ├── loadgen-stack.ts           # Load generation Lambda + SSM doc
│   └── chaos-stack.ts             # FIS experiment templates
├── lambda/
│   ├── build-trigger/index.py     # CodeBuild start + poll for completion
│   ├── schema-migration/index.py  # Database schema + stored procedures
│   ├── aurora-app/index.py        # Aurora Global DB CRUD handler (ALB target)
│   ├── dsql-app/index.py          # Aurora DSQL CRUD handler (ALB target)
│   ├── rpo-monitor/index.py       # RPO monitor: cross-region row comparison + heartbeat
│   ├── reconciliation/index.py    # Post-failover: compare rows, produce missing txn report
│   └── loadgen/index.py           # Load generation: sustained CRUD traffic via ALB
├── canaries/
│   ├── aurora-canary/index.py     # Synthetics canary: Aurora Global DB ALB endpoints
│   └── dsql-canary/index.py       # Synthetics canary: DSQL ALB endpoints
├── test/
│   ├── bootstrap.test.ts
│   ├── vpc.test.ts
│   ├── vpc-peering.test.ts
│   ├── database.test.ts
│   ├── dsql.test.ts
│   ├── schema.test.ts
│   ├── aurora-app.test.ts
│   ├── dsql-app.test.ts
│   ├── dns.test.ts
│   ├── failover-plan.test.ts
│   ├── synthetics.test.ts
│   ├── monitoring.test.ts
│   ├── chaos.test.ts
│   ├── reconciliation.test.ts
│   ├── loadgen.test.ts
│   └── integration.test.ts        # Cross-stack consistency tests
├── Makefile                      # Parallel deploys, variable capture
├── buildspec.yml                 # CodeBuild: npm ci, ts-node, make deploy
├── .checkov.yaml                 # Checkov skip rules with justifications
├── cleanup.sh
├── cdk.json
├── tsconfig.json
├── tsconfig.dev.json
├── package.json
├── LICENSE                       # MIT-0
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── README.md                     # Architecture, deployment, security suppressions table
```
