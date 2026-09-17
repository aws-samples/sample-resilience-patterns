import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { FLUENTBIT_SERVICE_ACCOUNT, LOGGING_NAMESPACE, podLogGroupName } from '../k8s';

export interface FluentBitIamProps {
  /** Application id prefix, e.g. `eks-mr-demo`. Names the log group. */
  readonly appId: string;
  /** EKS cluster name — used only to name the role region-uniquely. */
  readonly clusterName: string;
  /**
   * ARN of the cluster's IRSA OIDC provider, taken from `KarpenterIam.oidcProviderArn`.
   *
   * NOT created here. IAM allows exactly ONE provider per issuer URL, so a construct that
   * made its own would fail the deploy with EntityAlreadyExists -- a message that reads
   * like a stack-naming collision rather than a duplicate provider. LbcIam takes it the
   * same way for the same reason.
   */
  readonly oidcProviderArn: string;
  /** The cluster's OIDC issuer URL, e.g. `https://oidc.eks.<region>.amazonaws.com/id/ABC`. */
  readonly oidcIssuerUrl: string;
}

/**
 * IAM and the destination log group for cluster-wide pod log shipping (k8s/fluent-bit.yaml).
 *
 * ── WHY THE CONSTRUCT OWNS BOTH ─────────────────────────────────────────────────────────
 *
 * The role's entire purpose is to write to ONE log group. Creating the group somewhere else
 * and passing an ARN in invites the two to drift, and the failure mode is quiet: fluent-bit
 * runs `auto_create_group false`, so a mismatched group name yields
 * `ResourceNotFoundException` inside the shipper's own stderr -- which nothing is collecting,
 * because the thing that would collect it is the shipper. Co-locating them means the grant
 * and its target cannot disagree.
 *
 * ── THE GRANT IS THE WHOLE POINT ────────────────────────────────────────────────────────
 *
 * fluent-bit is a DaemonSet, and EKS security guidance is explicit that a DaemonSet
 * must not hold excessive cluster-wide Kubernetes permissions "or AWS permissions (via
 * IRSA)", because it runs on every node and a container breakout on any one of them inherits
 * whatever it holds. Collecting cluster-wide logs sharpens that: the pod now reads every
 * namespace's output.
 *
 * The conventional attachment for this job is the AWS managed policy
 * CloudWatchAgentServerPolicy, which carries logs:CreateLogGroup, cloudwatch:PutMetricData,
 * ec2:DescribeTags and ssm:GetParameter on "*". That is precisely the shape the guidance
 * warns about, and the recommendation engine's "Use IAM Roles and Scoped Down Policies"
 * (BEST_PRACTICE) says to avoid managed policies and scope to exact actions plus resource
 * ARNs. So: two actions, one resource, nothing else.
 *
 * The two actions are written out EXPLICITLY rather than via `logGroup.grantWrite(role)`.
 * grantWrite happens to resolve to the same pair today, but the security claim being made
 * here is "this role can do nothing but append to one log group", and that claim should be
 * auditable by reading this file rather than by knowing what a CDK helper expands to. A test
 * pins the exact action set so a future CDK release widening grantWrite -- or a well-meaning
 * addition here -- fails the build rather than the review.
 *
 * Notably absent: logs:CreateLogGroup. The group is created below, so the pod never needs
 * to create one. That single omission is what keeps a wildcard resource out of the policy,
 * since CreateLogGroup cannot be scoped to a group that does not exist yet.
 *
 * ── IRSA, NOT POD IDENTITY (a recorded deviation) ───────────────────────────────────────
 *
 * AWS guidance prefers EKS Pod Identity over IRSA. Adopting it here would require the
 * `eks-pod-identity-agent` managed addon, and this cluster runs ZERO managed addons and has
 * no NAT -- so it would mean introducing the first addon on a working demo cluster PLUS
 * another mirrored image, to replace a mechanism the repo already uses correctly twice
 * (KarpenterIam, LbcIam). Staying on IRSA and implementing the mandated mitigation instead
 * -- trust scoped to the exact service account -- is the deliberate trade. Recorded here
 * rather than left silent, the way the operator-access TLS deviation is.
 */
export class FluentBitIam extends Construct {
  /** Role the shipper assumes via IRSA. The ServiceAccount is annotated with this ARN. */
  public readonly shipperRole: iam.Role;

  /** Destination for every pod's stdout/stderr in this region. */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: FluentBitIamProps) {
    super(scope, id);

    // ── Destination log group ─────────────────────────────────────────────────────────────
    //
    // ONE group for the whole cluster, not one per namespace, so a single Logs Insights
    // query can correlate across components during a failover -- which is the entire reason
    // collection is cluster-wide. `namespace` is a real field on every record (the shipper's
    // parser filter mines it out of the container log path), so narrowing to one component
    // is a filter clause rather than a different group.
    //
    // Retention is set HERE and not by the shipper: log_retention_days on the
    // cloudwatch_logs plugin only applies when it creates the group itself, which would
    // require the CreateLogGroup grant this design exists to avoid.
    this.logGroup = new logs.LogGroup(this, 'PodLogs', {
      logGroupName: podLogGroupName(props.appId),
      // Two weeks: long enough that a failover can still be investigated days later (the
      // metrics outlive the incident, so the logs should too), short enough that a demo
      // running a load generator continuously does not accumulate storage cost forever.
      retention: logs.RetentionDays.TWO_WEEKS,
      // A demo teardown should leave nothing behind that costs money.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Trust policy ──────────────────────────────────────────────────────────────────────
    //
    // The condition keys are `<issuerHost>:sub` / `<issuerHost>:aud`, where issuerHost is a
    // deploy-time token. CDK refuses a token as a map key (KeyMustResolveToString), so the
    // whole object is deferred with CfnJson -- the same reason KarpenterIam and LbcIam do.
    const issuerHost = cdk.Fn.select(1, cdk.Fn.split('//', props.oidcIssuerUrl));

    const trustConditions = new cdk.CfnJson(this, 'ShipperTrustConditions', {
      value: {
        // StringEquals on BOTH sub and aud, never StringLike. best practice requires IRSA trust be
        // scoped to the service account level -- cluster, then namespace, then service
        // account -- so that no OTHER pod in this namespace can assume the role. A wildcard
        // `sub` is a privilege-escalation path out of any compromised pod.
        [`${issuerHost}:sub`]:
          `system:serviceaccount:${LOGGING_NAMESPACE}:${FLUENTBIT_SERVICE_ACCOUNT}`,
        [`${issuerHost}:aud`]: 'sts.amazonaws.com',
      },
    });

    this.shipperRole = new iam.Role(this, 'ShipperRole', {
      roleName: `${props.clusterName}-fluent-bit`,
      assumedBy: new iam.FederatedPrincipal(
        props.oidcProviderArn,
        { StringEquals: trustConditions.value },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description:
        'fluent-bit pod log shipper (IRSA). Appends to one log group; holds nothing else.',
    });

    this.shipperRole.attachInlinePolicy(
      new iam.Policy(this, 'ShipperPolicy', {
        statements: [
          new iam.PolicyStatement({
            // EXACTLY these two. See the class docstring: no CreateLogGroup, no
            // PutMetricData, no DescribeTags, no wildcard resource.
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            // CDK's logGroupArn already carries the trailing `:*`, which is what covers the
            // log STREAMS inside the group -- PutLogEvents acts on a stream, not the group.
            resources: [this.logGroup.logGroupArn],
          }),
        ],
      }),
    );
  }
}
