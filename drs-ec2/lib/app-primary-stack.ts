import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface VpcRef {
  readonly vpcId: string;
  readonly region: string;
}

export interface AppPrimaryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly hostedZoneName: string;
  readonly recordName: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly writerEndpoint: string;
  readonly appInstanceRoleArn?: string;
  /** Bucket holding app/app.py and app/ui.html (uploaded by the Makefile). */
  readonly appCodeBucket?: string;
  /** ARC-vended health check for the PRIMARY record; set on the final deploy pass. */
  readonly arcHealthCheckId?: string;
  /** Extra private-zone associations; set on the final deploy pass once those VPCs exist. */
  readonly secondaryVpc?: VpcRef;
  readonly observerVpc?: VpcRef;
  /** CIDR allowed to reach the internal ALB on :80 (the observer VPC by default). */
  readonly demoClientCidr?: string;
  readonly secondaryRegion?: string;
}

/**
 * The primary app tier: the private hosted zone and its failover record pair's PRIMARY half, the
 * app's DB-endpoint SSM parameter, an INTERNAL ALB, and the single EC2 the demo protects with DRS.
 *
 * The instance is t2.small on purpose: DRS "launch into source instance" (fail back onto this very
 * instance, keeping id, tags and target-group membership) requires BIOS boot on Linux, and the
 * AL2023 AMI boots UEFI on Nitro. It carries the AWSDRS opt-in tag for the same reason.
 * App code is fetched from S3 at boot (UserData is capped at 16 KB); `make deploy` refreshes a
 * running instance in place via SSM rather than replacing it (replacement costs a DRS re-protect).
 */
export class AppPrimaryStack extends cdk.Stack {
  public readonly zone: route53.CfnHostedZone;
  public readonly alb: elbv2.CfnLoadBalancer;
  public readonly targetGroup: elbv2.CfnTargetGroup;
  public readonly instance: ec2.CfnInstance;
  public readonly appSecurityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: AppPrimaryStackProps) {
    super(scope, id, props);
    const { project } = props;
    const secondaryRegion = props.secondaryRegion ?? 'us-west-2';

    const vpcs: route53.CfnHostedZone.VPCProperty[] = [{ vpcId: props.vpcId, vpcRegion: this.region }];
    if (props.secondaryVpc) vpcs.push({ vpcId: props.secondaryVpc.vpcId, vpcRegion: props.secondaryVpc.region });
    if (props.observerVpc) vpcs.push({ vpcId: props.observerVpc.vpcId, vpcRegion: props.observerVpc.region });
    this.zone = new route53.CfnHostedZone(this, 'PrivateHostedZone', { name: props.hostedZoneName, vpcs });

    new ssm.CfnParameter(this, 'DbEndpointParam', {
      name: `/${project}/db-writer-endpoint`, type: 'String', value: props.writerEndpoint,
    });

    const albIngress: ec2.CfnSecurityGroup.IngressProperty[] = [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: '10.0.0.0/8' }];
    if (props.demoClientCidr) albIngress.push({ ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: props.demoClientCidr });
    const albSg = new ec2.CfnSecurityGroup(this, 'AlbSecurityGroup', {
      groupDescription: `${project} primary alb sg`, vpcId: props.vpcId, securityGroupIngress: albIngress,
      tags: [{ key: 'Name', value: `${project}-primary-alb-sg` }],
    });
    this.appSecurityGroup = new ec2.CfnSecurityGroup(this, 'AppSecurityGroup', {
      groupDescription: `${project} primary app sg`, vpcId: props.vpcId,
      securityGroupIngress: [{ ipProtocol: 'tcp', fromPort: 8080, toPort: 8080, sourceSecurityGroupId: albSg.ref }],
      tags: [{ key: 'Name', value: `${project}-primary-app-sg` }],
    });

    this.alb = new elbv2.CfnLoadBalancer(this, 'Alb', {
      name: `${project}-primary-alb`, type: 'application', scheme: 'internal',
      securityGroups: [albSg.ref], subnets: props.subnetIds,
    });

    const ami = ec2.MachineImage.fromSsmParameter('/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64');
    const bucket = props.appCodeBucket ?? 'appcode-bucket-placeholder';
    const userData = `#!/bin/bash
set -euxo pipefail
dnf install -y postgresql15
# The app's Python deps go in their own venv. On AL2023 the AWS CLI is a system Python package
# whose python-dateutil (2.8.1 RPM) is older than what pg8000 requires; a bare 'pip3 install'
# upgrades it out from under the CLI and every later 'aws' call in this script dies with
# "No module named 'dateutil'" (seen live 2026-09-16). Never pip into the system interpreter.
python3 -m venv /opt/app/venv
/opt/app/venv/bin/pip install --quiet flask pg8000 boto3

REGION="${this.region}"
PROJECT="${project}"
DB_ENDPOINT=$(aws ssm get-parameter --region "$REGION" --name "/$PROJECT/db-writer-endpoint" --query Parameter.Value --output text)
SECRET_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$PROJECT/aurora/master" --query SecretString --output text)
DB_USER=$(echo "$SECRET_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["username"])')
DB_PASS=$(echo "$SECRET_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')

aws s3 cp "s3://${bucket}/app/app.py"  /opt/app/app.py  --region "$REGION"
aws s3 cp "s3://${bucket}/app/ui.html" /opt/app/ui.html --region "$REGION"

cat > /etc/systemd/system/drsapp.service <<EOF
[Unit]
Description=${project} app
After=network.target
[Service]
Environment=AWS_REGION=$REGION
Environment=DB_ENDPOINT=$DB_ENDPOINT
Environment=DB_PARAM_NAME=/${project}/db-writer-endpoint
Environment=DB_NAME=${project}
Environment=PROJECT=${project}
Environment=PRIMARY_REGION=${this.region}
Environment=SECONDARY_REGION=${secondaryRegion}
Environment=DB_USER=$DB_USER
Environment=DB_PASSWORD=$DB_PASS
ExecStart=/opt/app/venv/bin/python /opt/app/app.py
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now drsapp.service
`;

    this.instance = new ec2.CfnInstance(this, 'AppInstance', {
      imageId: ami.getImage(this).imageId,
      instanceType: 't2.small',
      iamInstanceProfile: `${project}-app-instance-profile`, // EC2 wants the NAME, not the ARN
      subnetId: props.subnetIds[0],
      securityGroupIds: [this.appSecurityGroup.ref],
      tags: [{ key: 'AWSDRS', value: 'AllowLaunchingIntoThisInstance' }, { key: 'Name', value: `${project}-app` }],
      userData: cdk.Fn.base64(userData),
    });

    this.targetGroup = new elbv2.CfnTargetGroup(this, 'TargetGroup', {
      name: `${project}-primary-tg`, port: 8080, protocol: 'HTTP', targetType: 'instance', vpcId: props.vpcId,
      healthCheckPath: '/health', healthCheckIntervalSeconds: 10, healthyThresholdCount: 2, unhealthyThresholdCount: 3,
      targets: [{ id: this.instance.ref }],
    });
    new elbv2.CfnListener(this, 'Listener', {
      loadBalancerArn: this.alb.ref, port: 80, protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: this.targetGroup.ref }],
    });

    new route53.CfnRecordSet(this, 'PrimaryFailoverRecord', {
      hostedZoneId: this.zone.ref, name: props.recordName, type: 'A',
      failover: 'PRIMARY', setIdentifier: `primary-${this.region}`,
      ...(props.arcHealthCheckId ? { healthCheckId: props.arcHealthCheckId } : {}),
      aliasTarget: { dnsName: this.alb.attrDnsName, hostedZoneId: this.alb.attrCanonicalHostedZoneId, evaluateTargetHealth: true },
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.attrDnsName });
    const out = (key: string, value: string, exp: string) => new cdk.CfnOutput(this, key, { value, exportName: `${project}-${exp}` });
    out('AppRecordName', props.recordName, 'AppRecordName');
    out('HostedZoneId', this.zone.ref, 'HostedZoneId');
    out('AppInstanceId', this.instance.ref, 'AppInstanceId');
    out('PrimaryTargetGroupArn', this.targetGroup.ref, 'PrimaryTgArn');
    out('AppSecurityGroupId', this.appSecurityGroup.ref, 'PrimaryAppSgId');
  }
}
