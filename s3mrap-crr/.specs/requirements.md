# Requirements: S3 MRAP + CRR Demo

## Purpose

Demonstrate S3 Multi-Region Access Points with Cross-Region Replication, CloudWatch observability, and ARC-based region failover — deployed entirely from CodeBuild to minimize local dependencies.

## Functional Requirements

### FR-1: S3 Buckets (One Per Region)
- Versioned S3 bucket in us-east-1
- Versioned S3 bucket in us-west-2
- Public access blocked on both buckets
- Bucket names include account ID for global uniqueness
- SNS topic per bucket for replication failure event notifications (s3:Replication:OperationFailedReplication)

### FR-2: S3 Multi-Region Access Point
- MRAP spanning both regional buckets
- Provides single endpoint for S3 access regardless of active region
- Initial routing set to primary=100%, secondary=0% on creation (active/passive)

### FR-3: Bidirectional Cross-Region Replication
- CRR from us-east-1 → us-west-2
- CRR from us-west-2 → us-east-1
- Replication Time Control enabled (15-min SLA)
- Replication metrics enabled

### FR-4: CloudWatch Alarms (Per Region)
- ReplicationLatency alarm (threshold: 900s)
- BytesPendingReplication alarm (threshold: 1GB)
- OperationsPendingReplication alarm (threshold: >1000 for 3 periods)
- OperationsFailedReplication alarm (threshold: >= 1)
- All alarms use "treat missing data as ignore" per AWS recommendation
- All alarms notify via SNS topic (ALARM + OK actions)
- Destination-region metrics (Latency, BytesPending, OpsPending) deployed in destination region
- Source-region metric (OpsFailed) uses reverse direction dimensions

### FR-5: CloudWatch Dashboards (Per Region)
- Dashboard per region showing:
  - MRAP Traffic Dial (%) — SingleValueWidget showing active/passive status per region
  - ReplicationLatency over time
  - BytesPendingReplication over time
  - OperationsPendingReplication over time
  - Replication Operations graph (OperationsPendingReplication + OperationsFailedReplication)

### FR-6: ARC Region Switch Plan
- AWS::ARCRegionSwitch::Plan resource
- Invokes MRAP routing Lambda (one per region) to switch traffic dial (100/0)
- Active/passive failover approach
- Execution role for arc-region-switch.amazonaws.com

### FR-7: MRAP Routing Lambda (Per Region)
- Lambda function that calls SubmitMultiRegionAccessPointRoutes
- Uses MRAP ARN (with alias) passed as env var at deploy time — not the MRAP name
- Sets active region to 100%, passive to 0%
- Deployed in both us-east-1 and us-west-2 (separate RoutingLambdaStack per region)
- ARC plan references both regional Lambda ARNs

### FR-8: CodeBuild Bootstrap
- Single CDK stack deployed locally that creates CodeBuild project
- Source uploaded automatically via CDK BucketDeployment asset
- CodeBuild triggered automatically via Lambda-backed custom resource
- `cdk deploy` blocks until CodeBuild completes all child stack deployments
- Cleanup via standalone cleanup.sh script (not CodeBuild)
- Minimizes local dependencies to: AWS CLI, CDK, Node

### FR-9: Load Test
- Lambda function that uploads objects to S3 and polls destination region for replication
- Configurable via event payload: object count, object size, source region, destination region
- Measures per-object replication latency (upload time → appearance in destination)
- Outputs summary: min/max/avg/p50/p99 latency, total objects, failures
- Can target either region as source to test both CRR directions
- Triggerable via SSM Document (console/CLI friendly with named parameters) or direct Lambda invoke
- Deployed as infrastructure, not a local script

### FR-10: MRAP Monitor Lambda (Per Region)
- Lambda function deployed in each monitoring stack (one per region)
- Reads MRAP traffic dial routes via GetMultiRegionAccessPointRoutes
- MRAP alias passed as environment variable at deploy time (no runtime lookup)
- Publishes MrapTrafficDial custom metric per region to local CloudWatch
- Runs every 1 minute via EventBridge schedule
- Feeds the MRAP Traffic Dial dashboard widget

## Non-Functional Requirements

### NFR-1: Infrastructure as Code
- All infrastructure defined in CDK (TypeScript)
- Makefile for cross-region deployment orchestration
- No manual console steps for deployment

### NFR-2: Security
- S3 buckets encrypted (SSE-S3)
- Public access blocked
- Least-privilege IAM roles
- No hardcoded credentials

### NFR-3: Reproducibility
- Deployable from CodeBuild with no local state
- Parameterized (project name, regions)
- Clean teardown via cleanup.sh

### NFR-4: CDK Assertion Tests
- Jest-based tests using aws-cdk-lib/assertions
- Unit tests per stack verifying CloudFormation template correctness
- Integration tests verifying cross-stack consistency (bucket names, Lambda ARNs, metric namespaces)
- Run via `npm test`

## Out of Scope
- VPCs, VPC endpoints, NAT gateways
- DynamoDB Global Tables / active region tracking
- Step Functions / batch processing
- SES email notifications
- FIS chaos experiments
- Reconciliation logic
- S3 request metrics (future improvement)
- Cross-region unified dashboard (future improvement)
