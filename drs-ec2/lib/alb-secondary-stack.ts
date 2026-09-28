import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface AlbSecondaryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly recordName: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  /** The private zone created by the primary app stack; the SECONDARY record is created when set. */
  readonly hostedZoneId?: string;
  readonly arcHealthCheckId?: string;
  readonly demoClientCidr?: string;
}

/**
 * The secondary app tier at rest: an INTERNAL ALB with an EMPTY target group and the security
 * group DRS launches recovered instances into. The target group is filled by the plan's
 * `register-target` step and emptied again by `drs-retire`. The SECONDARY half of the failover
 * record pair lives here so each region owns its own alias target.
 */
export class AlbSecondaryStack extends cdk.Stack {
  public readonly alb: elbv2.CfnLoadBalancer;
  public readonly targetGroup: elbv2.CfnTargetGroup;
  public readonly recoveredAppSecurityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: AlbSecondaryStackProps) {
    super(scope, id, props);
    const { project } = props;

    const albIngress: ec2.CfnSecurityGroup.IngressProperty[] = [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: '10.0.0.0/8' }];
    if (props.demoClientCidr) albIngress.push({ ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: props.demoClientCidr });
    const albSg = new ec2.CfnSecurityGroup(this, 'AlbSecurityGroup', {
      groupDescription: `${project} secondary alb sg`, vpcId: props.vpcId, securityGroupIngress: albIngress,
      tags: [{ key: 'Name', value: `${project}-secondary-alb-sg` }],
    });
    this.recoveredAppSecurityGroup = new ec2.CfnSecurityGroup(this, 'RecoveredAppSecurityGroup', {
      groupDescription: `${project} recovered app sg (DRS launch target)`, vpcId: props.vpcId,
      securityGroupIngress: [{ ipProtocol: 'tcp', fromPort: 8080, toPort: 8080, sourceSecurityGroupId: albSg.ref }],
      tags: [{ key: 'Name', value: `${project}-secondary-app-sg` }],
    });

    this.alb = new elbv2.CfnLoadBalancer(this, 'Alb', {
      name: `${project}-secondary-alb`, type: 'application', scheme: 'internal',
      securityGroups: [albSg.ref], subnets: props.subnetIds,
    });
    this.targetGroup = new elbv2.CfnTargetGroup(this, 'TargetGroup', {
      name: `${project}-secondary-tg`, port: 8080, protocol: 'HTTP', targetType: 'instance', vpcId: props.vpcId,
      healthCheckPath: '/health', healthCheckIntervalSeconds: 10, healthyThresholdCount: 2, unhealthyThresholdCount: 3,
    });
    new elbv2.CfnListener(this, 'Listener', {
      loadBalancerArn: this.alb.ref, port: 80, protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: this.targetGroup.ref }],
    });

    if (props.hostedZoneId) {
      new route53.CfnRecordSet(this, 'SecondaryFailoverRecord', {
        hostedZoneId: props.hostedZoneId, name: props.recordName, type: 'A',
        failover: 'SECONDARY', setIdentifier: `secondary-${this.region}`,
        ...(props.arcHealthCheckId ? { healthCheckId: props.arcHealthCheckId } : {}),
        aliasTarget: { dnsName: this.alb.attrDnsName, hostedZoneId: this.alb.attrCanonicalHostedZoneId, evaluateTargetHealth: true },
      });
    }

    const out = (key: string, value: string, exp: string) => new cdk.CfnOutput(this, key, { value, exportName: `${project}-${exp}` });
    out('RecoveredAppSecurityGroupId', this.recoveredAppSecurityGroup.ref, 'RecoveredAppSgId');
    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.attrDnsName });
    out('SecondaryTargetGroupArn', this.targetGroup.ref, 'SecondaryTargetGroupArn');
    out('SecondaryAlbSecurityGroupId', albSg.ref, 'SecondaryAlbSgId');
  }
}
