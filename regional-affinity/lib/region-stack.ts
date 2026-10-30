import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { RecordNames, regionLabel } from './names';

export interface RegionStackProps extends cdk.StackProps {
  readonly project: string;
  readonly names: RecordNames;
  /** Name of the global table; this stack's functions use this Region's replica only. */
  readonly tableName: string;
  /** This VPC's CIDR. */
  readonly cidr: string;
  readonly peer: {
    readonly region: string;
    readonly cidr: string;
    /** Set in the first Region once the other VPC exists: creates the peering connection. */
    readonly vpcId?: string;
    /** Set in the second Region once the connection exists: adds the return route. */
    readonly peeringConnectionId?: string;
  };
}

/**
 * One Region: an isolated VPC (no internet gateway, no NAT gateway), an internal Application Load
 * Balancer (ALB), and three AWS Lambda functions.
 *
 *   router  behind the ALB for the region-less name: redirects to the customer's home Region name
 *   app     behind the ALB for every other name: the stand-in for the application
 *   probe   inside the VPC: DNS queries and HTTP requests, for scripts/demo.py
 *
 * The router and app run outside the VPC (the ALB invokes them directly) and can reach only this
 * Region's replica of the global table. The VPCs are peered so a client in either VPC can reach
 * whichever Region's ALB a DNS answer names. Peering is added on a second deploy pass, once both
 * VPCs exist (see the Makefile).
 */
export class RegionStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly peering?: ec2.CfnVPCPeeringConnection;

  constructor(scope: Construct, id: string, props: RegionStackProps) {
    super(scope, id, props);
    const { project, names, peer } = props;
    const label = regionLabel(this.region);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${project}-${label}`,
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: 2, // an ALB needs subnets in two Availability Zones
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      // Both stay on (the default): a private hosted zone resolves in a VPC only with both enabled.
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // ---- peering: the first Region requests it, the second Region routes back -------------------
    let peeringId: string | undefined;
    if (peer.vpcId) {
      // Both VPCs are in this account, so CloudFormation accepts the connection as it creates it.
      this.peering = new ec2.CfnVPCPeeringConnection(this, 'Peering', {
        vpcId: this.vpc.vpcId,
        peerVpcId: peer.vpcId,
        peerRegion: peer.region,
        tags: [{ key: 'Name', value: `${project}-peering` }],
      });
      peeringId = this.peering.ref;
    } else if (peer.peeringConnectionId) {
      peeringId = peer.peeringConnectionId;
    }
    if (peeringId) {
      this.vpc.isolatedSubnets.forEach((subnet, i) => new ec2.CfnRoute(this, `PeerRoute${i + 1}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: peer.cidr,
        vpcPeeringConnectionId: peeringId,
      }));
    }

    // ---- the internal ALB -----------------------------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Internal ALB, HTTP from the two sample VPCs only',
      // The ALB invokes its Lambda targets directly, not over the network: no egress needed.
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.ipv4(props.cidr), ec2.Port.tcp(80), 'Clients in this VPC');
    albSg.addIngressRule(ec2.Peer.ipv4(peer.cidr), ec2.Port.tcp(80), 'Clients in the peer VPC, over the peering connection');

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      dropInvalidHeaderFields: true,
    });
    // open: false, or CDK adds an ingress rule from 0.0.0.0/0 to the security group.
    const listener = this.alb.addListener('Http', { port: 80, protocol: elbv2.ApplicationProtocol.HTTP, open: false });

    // ---- router and app -------------------------------------------------------------------------
    const tableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: props.tableName });
    const regionalNames = JSON.stringify(names.regional);
    const code = (dir: string) => lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', dir), {
      exclude: ['__pycache__', '*.pyc'], // byte-code the unit tests leave next to the modules
    });
    const fn = (id: string, name: string, description: string, handler: string, actions: string[]) => {
      const role = new iam.Role(this, `${id}Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
      role.addToPolicy(new iam.PolicyStatement({ actions, resources: [tableArn] }));
      return new lambda.Function(this, id, {
        functionName: `${project}-${name}`,
        description,
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.ARM_64,
        code: code(name),
        handler,
        memorySize: 128,
        timeout: cdk.Duration.seconds(10),
        role,
        environment: { TABLE: props.tableName, REGIONAL_NAMES: regionalNames },
        logGroup: this.logGroup(`${id}Logs`, `${project}-${name}`),
      });
    };
    const router = fn('Router', 'router', 'Redirects a region-less request to the home Region name of the customer in its body',
      'router.handler', ['dynamodb:GetItem']);
    const app = fn('App', 'app', 'Stand-in for the application: reads and writes customer items in this Region replica',
      'ingest_app.handler', ['dynamodb:GetItem', 'dynamodb:PutItem']);

    // Every name except the region-less one (the regional names, the app names) goes to the app;
    // the routing layer is the one rule that sends the region-less name to the router.
    listener.addTargets('App', { targets: [new targets.LambdaTarget(app)] });
    listener.addTargets('Router', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.hostHeaders([names.regionLess])],
      targets: [new targets.LambdaTarget(router)],
    });

    // The ELB documentation recommends limiting the permission that lets the load balancer invoke a
    // function to the target group's account (aws:SourceAccount) and ARN (aws:SourceArn). CDK's
    // LambdaTarget sets neither, so add the account to the permissions it generated. The ARN cannot
    // be added: the permission has to exist before CloudFormation registers the function with the
    // target group, so a SourceArn naming the target group would make each wait for the other.
    for (const fn of [router, app]) {
      for (const permission of fn.node.findAll().filter((c): c is lambda.CfnPermission => c instanceof lambda.CfnPermission)) {
        if (permission.principal === 'elasticloadbalancing.amazonaws.com') {
          permission.addPropertyOverride('SourceAccount', this.account);
        }
      }
    }

    // ---- probe ----------------------------------------------------------------------------------
    const probeSg = new ec2.SecurityGroup(this, 'ProbeSecurityGroup', {
      vpc: this.vpc,
      description: 'Probe, DNS to the VPC resolver and HTTP to the two sample ALBs',
      allowAllOutbound: false,
    });
    probeSg.addEgressRule(ec2.Peer.ipv4(props.cidr), ec2.Port.udp(53), 'VPC resolver (UDP)');
    probeSg.addEgressRule(ec2.Peer.ipv4(props.cidr), ec2.Port.tcp(53), 'VPC resolver (TCP)');
    probeSg.addEgressRule(ec2.Peer.ipv4(props.cidr), ec2.Port.tcp(80), 'The ALB in this VPC');
    probeSg.addEgressRule(ec2.Peer.ipv4(peer.cidr), ec2.Port.tcp(80), 'The ALB in the peer VPC, over the peering connection');

    const probe = new lambda.Function(this, 'Probe', {
      functionName: `${project}-probe`,
      description: 'From inside this VPC, queries the Route 53 Resolver or sends HTTP requests that follow redirects',
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      code: code('probe'),
      handler: 'probe.handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(60),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [probeSg],
      environment: { VPC_CIDR: props.cidr },
      logGroup: this.logGroup('ProbeLogs', `${project}-probe`),
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcCidr', { value: props.cidr });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbHostedZoneId', {
      description: 'Canonical hosted zone ID of the ALB, for the alias record',
      value: this.alb.loadBalancerCanonicalHostedZoneId,
    });
    new cdk.CfnOutput(this, 'ProbeFunctionName', { value: probe.functionName });
    if (this.peering) {
      new cdk.CfnOutput(this, 'PeeringConnectionId', { value: this.peering.ref });
    }
  }

  /** A log group the stack owns, so cleanup removes it with the function. */
  private logGroup(id: string, functionName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
