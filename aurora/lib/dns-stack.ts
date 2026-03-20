import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';

export interface DnsStackProps extends cdk.StackProps {
  readonly project: string;
  readonly domainName: string;
  readonly primaryVpcId: string;
  readonly secondaryVpcId: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly primaryAuroraAlbDns: string;
  readonly primaryAuroraAlbHostedZoneId: string;
  readonly secondaryAuroraAlbDns: string;
  readonly secondaryAuroraAlbHostedZoneId: string;
  readonly primaryHealthCheckId?: string;
  readonly secondaryHealthCheckId?: string;
}

export class DnsStack extends cdk.Stack {
  public readonly hostedZoneId: string;

  constructor(scope: cdk.App, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const hostedZone = new route53.CfnHostedZone(this, 'HostedZone', {
      name: props.domainName,
      vpcs: [
        { vpcId: props.primaryVpcId, vpcRegion: props.primaryRegion },
        { vpcId: props.secondaryVpcId, vpcRegion: props.secondaryRegion },
      ],
    });

    this.hostedZoneId = hostedZone.attrId;

    // Aurora app: latency-based records
    this.addLatencyRecord('AuroraPrimary', `aurora-app.${props.domainName}`, props.primaryRegion,
      props.primaryAuroraAlbDns, props.primaryAuroraAlbHostedZoneId, 'PrimaryRegion', props.primaryHealthCheckId);
    this.addLatencyRecord('AuroraSecondary', `aurora-app.${props.domainName}`, props.secondaryRegion,
      props.secondaryAuroraAlbDns, props.secondaryAuroraAlbHostedZoneId, 'StandbyRegion', props.secondaryHealthCheckId);

    new cdk.CfnOutput(this, 'HostedZoneIdOutput', { value: this.hostedZoneId });
  }

  private addLatencyRecord(logicalId: string, recordName: string, region: string,
    albDns: string, albHostedZoneId: string, setIdentifier: string, healthCheckId?: string) {
    new route53.CfnRecordSet(this, logicalId, {
      hostedZoneId: this.hostedZoneId,
      name: recordName,
      type: 'A',
      region,
      setIdentifier,
      aliasTarget: {
        dnsName: albDns,
        hostedZoneId: albHostedZoneId,
        evaluateTargetHealth: true,
      },
      ...(healthCheckId ? { healthCheckId } : {}),
    });
  }
}
