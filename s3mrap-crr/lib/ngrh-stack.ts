import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface NgrhStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  /**
   * ARN of the global-routing CloudFormation stack. The S3 Multi-Region Access Point
   * (AWS::S3::MultiRegionAccessPoint) has no CFN `Tags` property and cannot participate
   * in tag-based discovery, so it is discovered via a CloudFormation-stack input source.
   */
  readonly globalRoutingStackArn?: string;
}

/**
 * Next-Gen Resilience Hub (ResilienceHubV2 / NGRH) model for the S3 MRAP + CRR
 * pattern.
 *
 * aws-cdk-lib ships no L2 constructs for AWS::ResilienceHubV2 (and this repo's
 * pinned version predates the generated L1 module), so the NGRH resources are
 * authored via the `CfnResource` escape hatch — the same approach used by the
 * sibling aurora pattern's ngrh-stack.
 *
 * Model shape:
 *   - 1 System: `s3mrap-storage`
 *   - 1 Service: `s3mrap` (MRAP + bidirectional CRR over two regional buckets)
 *   - 2 User Journeys: PutObject (write via MRAP), GetObject (read via MRAP)
 *   - 1 Resiliency Policy: RTO 30m / RPO 15m (RTC SLA) / WARM_STANDBY / 99.9% SLO
 *   - Tag-based input source (`service` in {s3mrap, shared}), DependencyDiscovery ENABLED
 *   - No assertions (bare canonical arm).
 */
export class NgrhStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: NgrhStackProps) {
    super(scope, id, props);

    const { project, primaryRegion, secondaryRegion, globalRoutingStackArn } = props;

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

    const invokerRole = new iam.Role(this, 'InvokerRole', {
      roleName: `${project}-ngrh-invoker`,
      assumedBy: new iam.ServicePrincipal('resiliencehub.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSResilienceHubV2AssessmentExecutionPolicy'),
      ],
    });
    bucket.grantReadWrite(invokerRole);

    // Active-passive S3 MRAP: data fully replicated to the standby via CRR (RTC 15-min SLA),
    // promoted by flipping the MRAP traffic dial. Warm standby with a 15-min RPO.
    const tier = new cdk.CfnResource(this, 'TierPolicy', {
      type: 'AWS::ResilienceHubV2::Policy',
      properties: {
        Name: `${project}-tier1`,
        Description: 'S3 MRAP + CRR storage: RTO 30m / RPO 15m (S3 CRR Replication Time Control) / warm standby',
        AvailabilitySlo: { Target: 99.9 },
        MultiAz: {},
        MultiRegion: {
          RtoInMinutes: 30,
          RpoInMinutes: 15,
          DisasterRecoveryApproach: 'WARM_STANDBY',
        },
      },
    });

    const system = new cdk.CfnResource(this, 'System', {
      type: 'AWS::ResilienceHubV2::System',
      properties: {
        Name: `${project}-storage`,
        Description: 'Multi-region S3 storage via a Multi-Region Access Point with bidirectional cross-region replication',
      },
    });
    const systemArn = system.getAtt('SystemArn').toString();

    const putObject = new cdk.CfnResource(this, 'PutObjectJourney', {
      type: 'AWS::ResilienceHubV2::UserJourney',
      properties: {
        SystemIdentifier: systemArn,
        Name: 'PutObject',
        Description: 'Write path: PUT through the Multi-Region Access Point to the active regional bucket',
      },
    });
    const getObject = new cdk.CfnResource(this, 'GetObjectJourney', {
      type: 'AWS::ResilienceHubV2::UserJourney',
      properties: {
        SystemIdentifier: systemArn,
        Name: 'GetObject',
        Description: 'Read path: GET through the Multi-Region Access Point from the active regional bucket',
      },
    });

    // Tag-based discovery seeds most of the topology (buckets, CRR + routing Lambdas, KMS).
    // The MRAP has no CFN Tags property, so the global-routing stack is added as a
    // CloudFormation-stack input source to pull the MRAP (and its CRR wiring) into the model.
    const inputSources: any[] = [
      { ResourceConfiguration: { ResourceTags: [{ Key: 'service', Values: [`${project}`, 'shared'] }] } },
    ];
    if (globalRoutingStackArn && !globalRoutingStackArn.startsWith('PLACEHOLDER')) {
      inputSources.push({ ResourceConfiguration: { CfnStackArn: globalRoutingStackArn } });
    }

    const service = new cdk.CfnResource(this, 'S3mrapService', {
      type: 'AWS::ResilienceHubV2::Service',
      properties: {
        Name: `${project}`,
        Regions: [primaryRegion, secondaryRegion],
        PolicyArn: tier.getAtt('PolicyArn').toString(),
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
              putObject.getAtt('UserJourneyId').toString(),
              getObject.getAtt('UserJourneyId').toString(),
            ],
          },
        ],
        InputSources: inputSources,
      },
    });

    new cdk.CfnOutput(this, 'SystemArn', { value: systemArn });
    new cdk.CfnOutput(this, 'SystemName', { value: `${project}-storage` });
    new cdk.CfnOutput(this, 'ServiceName', { value: `${project}` });
    new cdk.CfnOutput(this, 'ServiceArn', { value: service.getAtt('ServiceArn').toString() });
    new cdk.CfnOutput(this, 'TierPolicyArn', { value: tier.getAtt('PolicyArn').toString() });
    new cdk.CfnOutput(this, 'NgrhBucketName', { value: bucket.bucketName });
  }
}
