import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ClientAlarms } from './client-alarms';
import { LoadGenerator } from './constructs/load-generation';
import { DemoObservability } from './constructs/observability';
import { APP_RECORD_NAME, OBSERVER_REGION, REGIONS } from '../regions';

export interface LoadGenStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * The synthetic users (step 4c). Locust on Fargate in the OBSERVER VPC — the third
 * region, outside both workload regions, next to the operator's bastion.
 *
 * WHY THE OBSERVER REGION. The users used to run in the primary region's isolated
 * subnets. That put the demo's only client, and therefore its only view of an outage, in
 * the region the failover exists to evacuate: a real loss of us-east-2 would have taken
 * the availability graph down with the app. Clients belong where the customer's clients
 * are, outside the blast radius, and the observer VPC already peers to both workload
 * VPCs. Nothing about the measurements moves with them: per-AZ and per-region
 * attribution comes from the app's own response body, not from where the client sits,
 * and the extra ~10-15 ms per request between us-east-1 and us-east-2 is well inside
 * the 2 s SLO and the 5 s request timeout.
 *
 * TARGET. `http://app.eks-mr-demo.internal` — the Route 53 failover record, as a
 * SYNTH-TIME CONSTANT from `regions.ts`, shared with the failover stack that creates the
 * records and the ARC plan that flips them. `LoadGenerator.targetUrl` requires a
 * synth-time string, and this is why threading the raw NLB hostname instead would be
 * wrong twice over: it is a deploy-time value, and users pinned to one region's load
 * balancer can never follow the failover. The private zone is associated with this VPC
 * by the dns stack so the name resolves here.
 *
 * WORKLOAD. `src/locust/` overlays the construct's build context: reads (GET /orders)
 * and writes (POST /orders), emitting ClientSuccess/ClientError/ClientLatency — the
 * exact names the availability alarm reads — plus Region- and Az-dimensioned metrics
 * attributed from the app's own response. The stock workload's Success/Error names
 * would leave the alarm in INSUFFICIENT_DATA forever.
 *
 * THE ALARMS LIVE HERE TOO. EMF metrics materialize in the region of the log group, so
 * every metric this demo has now lands in the observer region — and CloudWatch alarms
 * cannot read across regions. The decision signal and the ARC plan's two
 * application-health alarms are therefore declared in this stack (ClientAlarms), and
 * their ARNs go onto the dotenv rail for the failover stack. Dashboards CAN read across
 * regions, so the two workload-region dashboards stay in their regions and stamp their
 * widgets with this region; this stack adds a third, the client's view, which survives
 * anything done to either workload region.
 *
 * PLACEMENT. Its own stack, deployed AFTER `dns` (factory Phase 6): the region stacks
 * deploy before the app or the DNS records exist, and a load generator started then
 * would hammer an unresolvable name — flooding the availability alarm with
 * deploy-sequencing noise dressed up as an outage.
 *
 * NETWORK PATH. Task → VPC peering → the active region's internal NLB → pod. The NLB
 * uses IP targets with client IP preservation off, so the pods see the load balancer's
 * address and no node rule depends on this client's CIDR (the region stacks still admit
 * it on the NodePort range for symmetry with the other client sources). The observer
 * subnet has no internet route; the ECR, CloudWatch Logs and S3 gateway endpoints the
 * construct documents as required are declared by ObserverStack.
 */
export class LoadGenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LoadGenStackProps) {
    super(scope, id, props);

    // build/deploy-stack.sh appends these to EVERY deploy unconditionally and
    // CloudFormation rejects a changeset carrying parameters the template does not
    // declare. Required in every deployable stack.
    new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Run-scoped key prefix inside the assets bucket.',
    });

    // The observer VPC's placement values, threaded off the dotenv rail from the
    // observer stack's outputs (same region, but a parameter keeps the two stacks
    // independently deployable and matches every other stack's contract with the rail).
    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      description: 'VPC id of the observer stack the load generator runs in.',
    });
    const subnetId = new cdk.CfnParameter(this, 'SubnetId', {
      type: 'String',
      description: 'The observer private subnet id.',
    });
    const subnetAz = new cdk.CfnParameter(this, 'SubnetAz', {
      type: 'String',
      description: 'Availability zone of SubnetId.',
    });

    // The observer VPC has ONE private subnet in ONE AZ, so no Fn.select over AZ_COUNT
    // here: a single explicit id is what `Vpc.fromVpcAttributes` needs.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ObserverVpc', {
      vpcId: vpcId.valueAsString,
      availabilityZones: [subnetAz.valueAsString],
      isolatedSubnetIds: [subnetId.valueAsString],
    });

    new LoadGenerator(this, 'LoadGen', {
      vpc,
      // The construct defaults to PRIVATE_WITH_EGRESS, which this VPC does not have.
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      targetUrl: `http://${APP_RECORD_NAME}`,
      // Documentation only — the overlay locustfile defines its own /orders tasks.
      targetPath: '/orders',
      // The demo workload: reads + writes + the emf_helper the alarms depend on.
      workloadDirectory: path.join(__dirname, '..', '..', 'locust'),
      // Defaults kept explicit where they are contracts:
      //   architecture ARM64 — matches the CI runners; kaniko cannot cross-build, the
      //   same constraint that moved the EKS nodes to Graviton in step 3b.
      //   emfNamespace default — the shared DEMO_METRIC_NAMESPACE constant both this
      //   container's helper and DemoObservability read.
      requestTimeoutSeconds: 5,
      users: 10,
      spawnRate: 10,
      desiredCount: 1,
    });

    // The client's view: a dashboard in THIS region, stamped with this region because it
    // is where the EMF lands, and the baseline availability alarm, which is the
    // operator's decision signal. The literal rather than the AWS::Region token so the
    // rendered dashboard body carries a checkable region stamp, as the region stacks do.
    const obs = new DemoObservability(this, 'Observability', {
      demoName: `${props.appId}-${OBSERVER_REGION}`,
      metricsRegion: OBSERVER_REGION,
      headerMarkdown:
        'The client view. These metrics are emitted by the load generator in the ' +
        `observer region and survive a loss of either workload region (${REGIONS.map((r) => r.name).join(', ')}).`,
      createBaselineAlarms: true,
    });
    const alarms = new ClientAlarms(this, 'ClientAlarms', { observability: obs });

    // ARNs onto the dotenv rail for the failover stack, which consumes alarm STATE:
    // the app-health pair is step 8's associatedAlarms. The decision alarm is exported
    // for the runbook's console deep-link ONLY — wiring it to anything is the C-001
    // violation.
    new cdk.CfnOutput(this, 'DecisionAlarmArn', {
      value: alarms.decisionAlarm.alarmArn,
      description: 'Operator decision signal. Wired to NOTHING by design (C-001).',
    });
    REGIONS.forEach((r, i) => {
      new cdk.CfnOutput(this, `AppHealthAlarmArn${i}`, {
        value: alarms.appHealthAlarms.get(r.name)!.alarmArn,
        description: `ARC associatedAlarms (step 8): availability served by ${r.name}.`,
      });
    });

    new cdk.CfnOutput(this, 'TargetRecordName', { value: APP_RECORD_NAME });
  }
}
