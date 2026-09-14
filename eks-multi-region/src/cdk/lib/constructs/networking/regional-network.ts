import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ParameterizedVpc, SubnetSpec } from './parameterized-vpc.js';

/**
 * Generalized from five-nines-app:
 *   src/cdk/lib/nested-stacks/network-stack.ts:1-144
 *
 * Key generalizations vs the five-nines NetworkStack:
 *   - Plain `Construct` (not a `NestedStack`) — each region is its own top-level
 *     RegionStack in the green skeleton, so no nested template is needed. It
 *     still composes inside a parent stack if a demo wants to embed it.
 *     (network-stack.ts:50 was a cdk.NestedStack.)
 *   - The two named topology presets ('isolated' | 'public-egress', tuned to
 *     client-vs-app roles, network-stack.ts:15,60-74) become a caller-supplied
 *     `subnets: SubnetSpec[]` (default single PRIVATE_ISOLATED tier). The presets
 *     survive as the `isolated()` / `publicEgress()` static factories.
 *   - Gateway endpoints are a prop, default [S3, DYNAMODB] (free) — was hardcoded
 *     at network-stack.ts:89-90.
 *   - Interface endpoints are a prop, default [] (each costs money) — was driven
 *     only by `additionalInterfaceEndpoints` at network-stack.ts:93-95.
 *   - The APIGATEWAY-specific scoped-SG carve-out (network-stack.ts:97-142) is
 *     generalized to `scopedIngress: ScopedIngress[]`, preserving the raw
 *     CfnSecurityGroupIngress token-safe mechanism (network-stack.ts:111-118).
 *   - peeringRouteTableIds is collected generically from all non-public subnet
 *     tiers (the workload-bearing tiers that originate cross-region traffic),
 *     replacing the topology branch at network-stack.ts:78-81.
 */

export interface ScopedIngress {
  /** The interface endpoint service whose SG should be scoped. */
  readonly service: ec2.InterfaceVpcEndpointAwsService;
  /** CIDR allowed to reach it on 443. May be a CfnParameter token. */
  readonly allowCidr: string;
}

export interface RegionalNetworkProps {
  /** VPC CIDR for THIS region. Usually a CfnParameter token. */
  readonly vpcCidr: string;
  /** Subnet tiers. Default: a single PRIVATE_ISOLATED tier. */
  readonly subnets?: SubnetSpec[];
  /** AZ count. Default 3. */
  readonly azCount?: number;
  /** Provision a single NAT (requires a PUBLIC tier). Default false. */
  readonly includeNatGateway?: boolean;
  /** Force an IGW even with no public subnets (CloudFront VPC origins). Default false. */
  readonly includeInternetGateway?: boolean;
  /** Gateway endpoints. Default [S3, DYNAMODB] (free). */
  readonly gatewayEndpoints?: ec2.GatewayVpcEndpointAwsService[];
  /** Interface endpoints. Default [] (each costs money — opt in). */
  readonly interfaceEndpoints?: ec2.InterfaceVpcEndpointAwsService[];
  /** Scope a named interface endpoint's SG to a CIDR (token-safe raw ingress). */
  readonly scopedIngress?: ScopedIngress[];
}

/** Default subnet topology: a single private-isolated tier (cheap, no NAT/IGW). */
const DEFAULT_SUBNETS: SubnetSpec[] = [
  { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
];

/** Default gateway endpoints — both free, so always on by default. */
const DEFAULT_GATEWAY_ENDPOINTS = [
  ec2.GatewayVpcEndpointAwsService.S3,
  ec2.GatewayVpcEndpointAwsService.DYNAMODB,
];

/**
 * A region's network: a deploy-time-CIDR VPC + gateway/interface endpoints, with
 * the set of route tables that should receive cross-region peering routes
 * collected for M5 (`PeeringMesh`) to consume.
 *
 * Defaults are tuned to be cheap to leave running (isolated subnets, free S3/DDB
 * gateway endpoints, no NAT, no interface endpoints).
 */
export class RegionalNetwork extends Construct {
  public readonly vpc: ec2.IVpc;
  /** Route tables that should receive cross-region peering routes (consumed by M5). */
  public readonly peeringRouteTableIds: string[];
  /** Interface endpoints, keyed by service shortName, for downstream consumers. */
  public readonly interfaceEndpoints: Record<string, ec2.IInterfaceVpcEndpoint> = {};

  constructor(scope: Construct, id: string, props: RegionalNetworkProps) {
    super(scope, id);

    const subnets = props.subnets ?? DEFAULT_SUBNETS;

    const vpcHelper = new ParameterizedVpc(this, 'Vpc', {
      vpcCidr: props.vpcCidr,
      subnets,
      azCount: props.azCount,
      includeNatGateway: props.includeNatGateway,
      includeInternetGateway: props.includeInternetGateway,
    });

    this.vpc = vpcHelper.vpc;

    // Peering routes go on the workload-bearing (non-public) tiers — the tiers
    // that originate cross-region traffic. Public subnets route to the IGW, not
    // to peers. (network-stack.ts:78-81 picked private-for-egress / isolated-
    // otherwise; this generic form covers both and any custom topology.)
    this.peeringRouteTableIds = [
      ...vpcHelper.privateSubnets,
      ...vpcHelper.isolatedSubnets,
    ].map((s) => s.routeTable.routeTableId);

    // Interface endpoints attach to the workload-bearing tier. Prefer
    // private-with-egress, then isolated, then public (best-effort).
    const endpointSubnetType = this.endpointSubnetType(subnets);

    // --- Gateway endpoints (free by default) --------------------------------
    const gatewayEndpoints = props.gatewayEndpoints ?? DEFAULT_GATEWAY_ENDPOINTS;
    gatewayEndpoints.forEach((service) => {
      // shortName is e.g. 's3', 'dynamodb'; capitalize for a stable logical id.
      const idPart = service.name.split('.').pop() ?? service.name;
      this.vpc.addGatewayEndpoint(`${idPart}GatewayVpce`, { service });
    });

    // --- Scoped ingress SGs (token-safe) ------------------------------------
    // Built ahead of the interface-endpoint loop so a scoped service gets its
    // dedicated SG instead of the default open one.
    const scopedSgByService = new Map<ec2.InterfaceVpcEndpointAwsService, ec2.ISecurityGroup>();
    (props.scopedIngress ?? []).forEach((scoped) => {
      const sg = new ec2.SecurityGroup(this, `${scoped.service.shortName}ScopedSg`, {
        vpc: this.vpc,
        description: `Allow HTTPS from ${scoped.allowCidr} to ${scoped.service.shortName}`,
        allowAllOutbound: false,
      });
      // CfnSecurityGroupIngress instead of ec2.Peer.ipv4(): the L2 helper
      // validates the CIDR at synth time and rejects CfnParameter tokens, but
      // we're passing a token here. CFN does the validation at deploy time
      // against the resolved value. (network-stack.ts:111-118.)
      new ec2.CfnSecurityGroupIngress(this, `${scoped.service.shortName}ScopedSgIngress`, {
        groupId: sg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrIp: scoped.allowCidr,
        description: 'HTTPS from scoped CIDR',
      });
      scopedSgByService.set(scoped.service, sg);
    });

    // --- Interface endpoints (empty by default — opt in) --------------------
    const interfaceEndpoints = props.interfaceEndpoints ?? [];
    interfaceEndpoints.forEach((service) => {
      const scopedSg = scopedSgByService.get(service);
      const endpoint = this.vpc.addInterfaceEndpoint(`${service.shortName}Vpce`, {
        service,
        subnets: { subnetType: endpointSubnetType },
        // The stale five-nines AGENTS.md claims private DNS is disabled; the
        // code enables it (network-stack.ts:121,128,135). Keep it enabled.
        privateDnsEnabled: true,
        ...(scopedSg ? { securityGroups: [scopedSg] } : { open: true }),
      });
      this.interfaceEndpoints[service.shortName] = endpoint;
    });
  }

  /** Convenience: isolated-only topology (app regions). */
  static isolated(
    scope: Construct,
    id: string,
    props: Omit<RegionalNetworkProps, 'subnets'>,
  ): RegionalNetwork {
    return new RegionalNetwork(scope, id, {
      ...props,
      subnets: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
  }

  /** Convenience: public + private-with-egress + NAT (client/load-gen region). */
  static publicEgress(
    scope: Construct,
    id: string,
    props: Omit<RegionalNetworkProps, 'subnets' | 'includeNatGateway'>,
  ): RegionalNetwork {
    return new RegionalNetwork(scope, id, {
      ...props,
      includeNatGateway: true,
      subnets: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });
  }

  /** Pick the workload-bearing tier interface endpoints should attach to. */
  private endpointSubnetType(subnets: SubnetSpec[]): ec2.SubnetType {
    const types = new Set(subnets.map((s) => s.subnetType));
    if (types.has(ec2.SubnetType.PRIVATE_WITH_EGRESS)) {
      return ec2.SubnetType.PRIVATE_WITH_EGRESS;
    }
    if (types.has(ec2.SubnetType.PRIVATE_WITH_NAT)) {
      return ec2.SubnetType.PRIVATE_WITH_NAT;
    }
    if (types.has(ec2.SubnetType.PRIVATE_ISOLATED)) {
      return ec2.SubnetType.PRIVATE_ISOLATED;
    }
    return ec2.SubnetType.PUBLIC;
  }
}
