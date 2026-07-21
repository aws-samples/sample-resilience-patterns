import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface NgrhStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
}

/**
 * Next-Gen Resilience Hub (ResilienceHubV2 / NGRH) model for the Aurora Global
 * Database multi-region pattern.
 *
 * aws-cdk-lib does not ship L2 constructs for AWS::ResilienceHubV2 (and this
 * repo's pinned aws-cdk-lib predates even the generated L1 module), so the NGRH
 * resources are authored via the `CfnResource` escape hatch — the same pattern
 * this repo already uses for ARC Region Switch in failover-plan-stack.ts. The
 * resource shapes mirror the CloudFormation reference used by dep-003.
 *
 * Model shape:
 *   - 1 System: `aurora-global-db`
 *   - 1 Tier-1 Service: `aurora-app` (ALB -> Lambda -> Aurora Global DB)
 *   - 2 User Journeys: PlaceOrder (write path), ViewOrders (read path)
 *   - 1 Resiliency Policy: RTO 15m / RPO 1m / ACTIVE_ACTIVE / 99.99% SLO
 *     (RPO is intentionally non-zero: Aurora Global DB replicates asynchronously)
 *   - Tag-based input source (`service` in {aurora-app, shared}), DependencyDiscovery ENABLED
 *   - No assertions (bare canonical arm) — the benchmark applies assertion/design
 *     arms separately; a bare model surfaces all config-observable gaps.
 */
export class NgrhStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: NgrhStackProps) {
    super(scope, id, props);

    const { project, primaryRegion, secondaryRegion } = props;

    // ── Shared NGRH bucket: assessment reports under /reports/ ──
    const bucket = new s3.Bucket(this, 'NgrhBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsPrefix: 'access-logs/',
      lifecycleRules: [
        { id: 'expire-reports-90d', prefix: 'reports/', expiration: cdk.Duration.days(90), noncurrentVersionExpiration: cdk.Duration.days(7) },
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
    });

    // ── Invoker role NGRH assumes to discover resources / run assessments ──
    const invokerRole = new iam.Role(this, 'InvokerRole', {
      roleName: `${project}-ngrh-invoker`,
      assumedBy: new iam.ServicePrincipal('resiliencehub.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSResilienceHubV2AssessmentExecutionPolicy'),
      ],
    });
    bucket.grantReadWrite(invokerRole);

    // ── Resiliency policy: Tier-1, Aurora Global async → RPO non-zero ──
    const tierOne = new cdk.CfnResource(this, 'TierOnePolicy', {
      type: 'AWS::ResilienceHubV2::Policy',
      properties: {
        Name: `${project}-tier1`,
        Description: 'Tier-1 order management: RTO 15m / RPO 1m (Aurora Global async replication) / active-active',
        AvailabilitySlo: { Target: 99.99 },
        MultiAz: {},
        MultiRegion: {
          RtoInMinutes: 15,
          RpoInMinutes: 1,
          DisasterRecoveryApproach: 'ACTIVE_ACTIVE',
        },
      },
    });

    // ── System (application container) ──
    const system = new cdk.CfnResource(this, 'System', {
      type: 'AWS::ResilienceHubV2::System',
      properties: {
        Name: `${project}-global-db`,
        Description: 'Multi-region active-active order management on Aurora Global Database',
      },
    });
    const systemArn = system.getAtt('SystemArn').toString();

    // ── User Journeys ──
    const placeOrder = new cdk.CfnResource(this, 'PlaceOrderJourney', {
      type: 'AWS::ResilienceHubV2::UserJourney',
      properties: {
        SystemIdentifier: systemArn,
        Name: 'PlaceOrder',
        Description: 'POST /orders — write path to the Aurora Global writer endpoint',
      },
    });
    const viewOrders = new cdk.CfnResource(this, 'ViewOrdersJourney', {
      type: 'AWS::ResilienceHubV2::UserJourney',
      properties: {
        SystemIdentifier: systemArn,
        Name: 'ViewOrders',
        Description: 'GET /orders — read path against the local reader endpoint',
      },
    });

    // ── Service: aurora-app (spans both regions) ──
    const service = new cdk.CfnResource(this, 'AuroraAppService', {
      type: 'AWS::ResilienceHubV2::Service',
      properties: {
        Name: `${project}-app`,
        Regions: [primaryRegion, secondaryRegion],
        PolicyArn: tierOne.getAtt('PolicyArn').toString(),
        DependencyDiscovery: 'ENABLED',
        PermissionModel: { InvokerRoleName: invokerRole.roleName },
        ReportConfiguration: {
          ReportOutput: [
            { S3: { BucketPath: `${bucket.bucketName}/reports/`, BucketOwner: this.account } },
          ],
        },
        AssociatedSystems: [
          {
            SystemArn: systemArn,
            UserJourneyIds: [
              placeOrder.getAtt('UserJourneyId').toString(),
              viewOrders.getAtt('UserJourneyId').toString(),
            ],
          },
        ],
        InputSources: [
          { ResourceConfiguration: { ResourceTags: [{ Key: 'service', Values: [`${project}-app`, 'shared'] }] } },
        ],
        // No Assertions: bare canonical arm (assertion/design arms applied by the benchmark run.py).
      },
    });

    new cdk.CfnOutput(this, 'SystemArn', { value: systemArn });
    new cdk.CfnOutput(this, 'TierOnePolicyArn', { value: tierOne.getAtt('PolicyArn').toString() });
    new cdk.CfnOutput(this, 'ServiceArn', { value: service.getAtt('ServiceArn').toString() });
    new cdk.CfnOutput(this, 'ServiceName', { value: `${project}-app` });
    new cdk.CfnOutput(this, 'SystemName', { value: `${project}-global-db` });
    new cdk.CfnOutput(this, 'NgrhBucketName', { value: bucket.bucketName });
  }
}
