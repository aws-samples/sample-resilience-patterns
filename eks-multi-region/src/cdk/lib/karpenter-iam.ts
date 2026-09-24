import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Namespace and service account Karpenter's chart installs into. These are NOT free
 * choices: the IRSA trust policy pins `sub` to this exact
 * `system:serviceaccount:<namespace>:<name>` pair, and the rendered chart must agree. A
 * mismatch produces a controller whose every AWS call fails `WebIdentityErr`, which reads
 * like a network or endpoint problem rather than a naming one.
 */
export const KARPENTER_NAMESPACE = 'kube-system';
export const KARPENTER_SERVICE_ACCOUNT = 'karpenter';

/** Tag key Karpenter uses for subnet and security-group discovery. */
export const KARPENTER_DISCOVERY_TAG = 'karpenter.sh/discovery';

export interface KarpenterIamProps {
  /** EKS cluster name — the discovery tag VALUE and the IAM condition key both use it. */
  readonly clusterName: string;
  /** The cluster's OIDC issuer URL, e.g. `https://oidc.eks.<region>.amazonaws.com/id/ABC`. */
  readonly oidcIssuerUrl: string;
  /**
   * The NETWORK CONSTRUCT whose subnet subtree gets the discovery tag — not a list of
   * `ISubnet`.
   *
   * This is deliberate and the repo has already been bitten by the alternative.
   * `ParameterizedVpc` creates raw `CfnSubnet` resources and exposes the VPC through
   * `Vpc.fromVpcAttributes`, so `vpc.isolatedSubnets` yields IMPORTED subnet objects that
   * are not the real constructs. `Tags.of()` on those is a SILENT no-op: zero tags, no
   * error, and synth stays green. Tagging the subtree with a resource-type filter is the
   * pattern that actually works, and it is what the internal-elb tag already uses.
   */
  readonly networkScope: Construct;
}

/**
 * IAM, instance profile and discovery tagging for Karpenter (step 11a).
 *
 * WHY THIS IS A SEPARATE CONSTRUCT rather than more lines in RegionStack: it is the piece
 * whose correctness is hardest to eyeball, and keeping it addressable lets the tests assert
 * against it directly.
 *
 * ── The constraint that shapes everything here ──────────────────────────────────────────
 *
 * Karpenter normally MANAGES the EC2 instance profile itself, calling
 * `iam:CreateInstanceProfile` and friends. It cannot here. IAM interface VPC endpoints can
 * only be created in each partition's IAM control-plane region — us-east-1 for `aws`,
 * cn-north-1 for `aws-cn`, us-gov-west-1 for `aws-us-gov` — and this demo runs in us-east-2
 * and us-west-2. (That is three regions, not just us-east-1, and the distinction matters:
 * a customer whose private cluster IS in us-east-1 can use `spec.role` and skip all of
 * this.) Karpenter documents the workaround as mandatory for our case:
 *
 *   "For private clusters without access to their AWS region's IAM API endpoint, using
 *    spec.instanceProfile is required. spec.role cannot be used since Karpenter needs to
 *    access IAM endpoints to manage a generated instance profile."
 *
 * So the instance profile is created HERE, by CloudFormation, and the EC2NodeClass will
 * reference it by name. CloudFormation runs outside the VPC, so it reaches IAM fine — only
 * the in-cluster controller is constrained.
 *
 * ── IRSA, not EKS Pod Identity ──────────────────────────────────────────────────────────
 *
 * IRSA needs STS, and AWS STS supports VPC endpoints in ~30 regions including both of ours
 * (step 3a already created it). EKS Pod Identity would need a NEW `eks-auth` interface
 * endpoint — the `eks` endpoint we have is a different service — so it would add an endpoint
 * for no gain.
 */
export class KarpenterIam extends Construct {
  /** Role the controller assumes via IRSA. The chart annotates its SA with this ARN. */
  public readonly controllerRole: iam.Role;

  /**
   * ARN of the cluster's IRSA OIDC provider, exposed so OTHER IRSA roles can reuse it.
   *
   * IAM allows exactly ONE provider per issuer URL, so a second construct creating its own
   * would fail the deploy with EntityAlreadyExists -- which reads as a stack-naming problem
   * rather than a duplicate provider. This construct happens to create it first; ownership
   * is incidental, and any future consumer should take it from here rather than re-create it.
   */
  public readonly oidcProviderArn: string;
  /** Role Karpenter-launched nodes assume. */
  public readonly nodeRole: iam.Role;
  /** Pre-created instance profile — EC2NodeClass `spec.instanceProfile` names this. */
  public readonly instanceProfile: iam.CfnInstanceProfile;

  constructor(scope: Construct, id: string, props: KarpenterIamProps) {
    super(scope, id);

    // ── OIDC provider for IRSA ──────────────────────────────────────────────────────────
    //
    // L1 CfnOIDCProvider with thumbprintList OMITTED, deliberately.
    //
    // The CDK L2 `iam.OpenIdConnectProvider` looks friendlier but is strictly worse here:
    // its docs still say "You must provide at least one thumbprint", which is why it ships
    // a Lambda-backed custom resource to fetch one. This project already rejected the EKS
    // L2 for depending on a kubectl Lambda; adding a custom resource here for a value
    // CloudFormation can resolve on its own would repeat that mistake.
    //
    // CfnOIDCProvider's contract: "This property is optional. If it is not included, IAM
    // will retrieve and use the top intermediate certificate authority (CA) thumbprint of
    // the OpenID Connect identity provider server certificate." So IAM fetches it. The
    // alternative — hardcoding a 40-char SHA-1 hex string — is a magic value that breaks
    // silently whenever the CA rotates, and the failure mode is every IRSA call returning
    // WebIdentityErr.
    const oidcProvider = new iam.CfnOIDCProvider(this, 'OidcProvider', {
      url: props.oidcIssuerUrl,
      clientIdList: ['sts.amazonaws.com'],
    });

    // The trust policy matches on the issuer host WITHOUT the scheme, which is how IAM
    // records the provider. Derived with Fn::select on '//' so it stays correct for a URL
    // that is unknown until deploy time.
    this.oidcProviderArn = oidcProvider.attrArn;

    const issuerHost = cdk.Fn.select(1, cdk.Fn.split('//', props.oidcIssuerUrl));

    // CfnJson, for the same reason step 8's ARC scalingResources needed it: the condition
    // KEY is `<issuerHost>:sub`, and CDK refuses a token as a map key —
    // «KeyMustResolveToString». CfnJson defers the whole object to deploy time.
    //
    // Karpenter's own CloudFormation template hits this and says so out loud: "The
    // PolicyDocument must be in JSON string format because we use a StringEquals condition
    // that uses an interpolated value in one of its key parameters which isn't natively
    // supported by CloudFormation." Their workaround is a !Sub'd JSON string; CfnJson is
    // the CDK-native equivalent and this repo already carries the precedent.
    const trustConditions = new cdk.CfnJson(this, 'ControllerTrustConditions', {
      value: {
        // StringEquals on BOTH sub and aud, never StringLike. A wildcard `sub` would let
        // ANY service account in the cluster assume a role that can launch and terminate
        // EC2 instances — a privilege-escalation path out of any compromised pod.
        [`${issuerHost}:sub`]:
          `system:serviceaccount:${KARPENTER_NAMESPACE}:${KARPENTER_SERVICE_ACCOUNT}`,
        [`${issuerHost}:aud`]: 'sts.amazonaws.com',
      },
    });

    // ── Controller role (IRSA) ──────────────────────────────────────────────────────────
    this.controllerRole = new iam.Role(this, 'ControllerRole', {
      roleName: `${props.clusterName}-karpenter-controller`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.attrArn,
        { StringEquals: trustConditions.value },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Karpenter controller (IRSA). Provisions and terminates EC2 capacity.',
    });

    // ── Node role ───────────────────────────────────────────────────────────────────────
    //
    // Same four managed policies the managed node group uses, so nodes from either source
    // behave identically. SSMManagedInstanceCore is not optional here: step 6's FIS
    // experiments reach instances through SSM, and Karpenter's own AMI resolution needs
    // ssm:GetParameter from the CONTROLLER side (granted separately below).
    this.nodeRole = new iam.Role(this, 'NodeRole', {
      roleName: `${props.clusterName}-karpenter-node`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        'AmazonEKSWorkerNodePolicy',
        'AmazonEKS_CNI_Policy',
        'AmazonEC2ContainerRegistryReadOnly',
        'AmazonSSMManagedInstanceCore',
      ].map((n) => iam.ManagedPolicy.fromAwsManagedPolicyName(n)),
      description: 'Identity for Karpenter-launched nodes.',
    });

    // The instance profile Karpenter is forbidden from creating. Named explicitly so the
    // EC2NodeClass can reference it as a synth-time constant rather than a deploy-time
    // lookup the controller would have to make against an unreachable IAM API.
    this.instanceProfile = new iam.CfnInstanceProfile(this, 'NodeInstanceProfile', {
      instanceProfileName: `${props.clusterName}-karpenter-node`,
      roles: [this.nodeRole.roleName],
    });

    // ── Controller permissions ──────────────────────────────────────────────────────────
    this.controllerRole.attachInlinePolicy(
      new iam.Policy(this, 'ControllerPolicy', {
        document: iam.PolicyDocument.fromJson(
          loadControllerPolicy({
            clusterName: props.clusterName,
            nodeRoleName: this.nodeRole.roleName,
            nodeRoleArn: this.nodeRole.roleArn,
          }),
        ),
      }),
    );

    // ── Access entry so Karpenter nodes may join the cluster ────────────────────────────
    //
    // Managed node groups get this implicitly; nodes launched by Karpenter do not. Under
    // authenticationMode API_AND_CONFIG_MAP the modern path is an access entry of type
    // EC2_LINUX, which carries the node permissions itself -- so NO access-policy
    // association is attached, and adding one is an error for this type.
    //
    // Without this entry every Karpenter node boots, registers nothing, and never appears
    // as a Kubernetes Node. The EC2 console shows healthy instances while pods stay
    // Pending, which points the operator at scheduling rather than at authentication.
    new eks.CfnAccessEntry(this, 'NodeAccessEntry', {
      clusterName: props.clusterName,
      principalArn: this.nodeRole.roleArn,
      type: 'EC2_LINUX',
    });

    // ── Discovery tags ──────────────────────────────────────────────────────────────────
    //
    // Karpenter resolves subnets from `subnetSelectorTerms`. Tagging them keeps the
    // EC2NodeClass free of deploy-time subnet IDs.
    //
    // Applied to the network SUBTREE with a resource-type filter, never by iterating
    // `vpc.isolatedSubnets` — those are imported objects and `Tags.of()` on them is a
    // silent no-op. Same reason the internal-elb tag is applied this way.
    //
    // Security groups are NOT tagged here. The security group Karpenter nodes need is the
    // one EKS creates for the cluster, which EKS owns — CloudFormation cannot add tags to
    // it. The EC2NodeClass therefore selects it by the tag EKS itself applies
    // (`aws:eks:cluster-name`). Inventing our own node security group instead would mean
    // reproducing the control-plane ingress rules by hand.
    cdk.Tags.of(props.networkScope).add(KARPENTER_DISCOVERY_TAG, props.clusterName, {
      includeResourceTypes: ['AWS::EC2::Subnet'],
    });
  }
}

/**
 * Read the vendored controller policy and substitute the CloudFormation pseudo-parameters
 * it was written against.
 *
 * The document is ported VERBATIM from Karpenter's own CloudFormation template rather than
 * hand-written, because several statements carry conditions keyed on interpolated tag
 * values (`aws:ResourceTag/kubernetes.io/cluster/<name>`, `aws:RequestTag/...`). Getting
 * one of those subtly wrong produces a controller that reports healthy and silently cannot
 * launch nodes -- and the CloudTrail AccessDenied names an action, not the condition that
 * rejected it.
 */
function loadControllerPolicy(vars: {
  clusterName: string;
  nodeRoleName: string;
  nodeRoleArn: string;
}): Record<string, unknown> {
  const file = path.join(__dirname, '..', '..', 'karpenter', 'controller-policy.json');
  const raw = fs.readFileSync(file, 'utf8');

  // The template references the node role in BOTH forms: `${KarpenterNodeRole}` for the
  // name and `${KarpenterNodeRole.Arn}` for the ARN (a CloudFormation GetAtt-style
  // substitution). Handling only the bare form leaves a literal "${KarpenterNodeRole.Arn}"
  // inside the iam:PassRole resource -- which the guard below now catches, because it did
  // exactly that on the first run.
  const substituted = raw
    .replace(/\$\{AWS::Partition\}/g, cdk.Aws.PARTITION)
    .replace(/\$\{AWS::Region\}/g, cdk.Aws.REGION)
    .replace(/\$\{AWS::AccountId\}/g, cdk.Aws.ACCOUNT_ID)
    .replace(/\$\{ClusterName\}/g, vars.clusterName)
    .replace(/\$\{KarpenterNodeRole\.Arn\}/g, vars.nodeRoleArn)
    .replace(/\$\{KarpenterNodeRole\}/g, vars.nodeRoleName);

  // Fail loudly on an unsubstituted placeholder. Left in place it becomes a LITERAL
  // "${Something}" inside an ARN or a condition key, which IAM accepts happily -- the
  // policy then simply never matches, and the only symptom is nodes that never launch.
  const leftover = substituted.match(/\$\{(?!Token)[^}]+\}/g);
  if (leftover) {
    throw new Error(
      `karpenter controller-policy.json has unsubstituted placeholders: ${[
        ...new Set(leftover),
      ].join(', ')}`,
    );
  }

  const doc = JSON.parse(substituted) as Record<string, unknown>;
  // Strip the documentation keys; PolicyDocument.fromJson rejects unknown top-level keys.
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_')) delete doc[key];
  }
  return doc;
}
