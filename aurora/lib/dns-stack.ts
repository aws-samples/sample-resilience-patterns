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

    // Region-aligned simple A-alias records
    const primaryRecordName = `aurora-app-use1.${props.domainName}`;
    const secondaryRecordName = `aurora-app-usw2.${props.domainName}`;

    new route53.CfnRecordSet(this, 'AuroraPrimaryRegion', {
      hostedZoneId: this.hostedZoneId,
      name: primaryRecordName,
      type: 'A',
      aliasTarget: { dnsName: props.primaryAuroraAlbDns, hostedZoneId: props.primaryAuroraAlbHostedZoneId, evaluateTargetHealth: true },
    });

    new route53.CfnRecordSet(this, 'AuroraSecondaryRegion', {
      hostedZoneId: this.hostedZoneId,
      name: secondaryRecordName,
      type: 'A',
      aliasTarget: { dnsName: props.secondaryAuroraAlbDns, hostedZoneId: props.secondaryAuroraAlbHostedZoneId, evaluateTargetHealth: true },
    });

    new cdk.CfnOutput(this, 'HostedZoneIdOutput', { value: this.hostedZoneId });
    new cdk.CfnOutput(this, 'PrimaryRegionRecordName', { value: primaryRecordName });
    new cdk.CfnOutput(this, 'SecondaryRegionRecordName', { value: secondaryRecordName });
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
