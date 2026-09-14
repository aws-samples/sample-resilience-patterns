/**
 * IAM for the AWS Load Balancer Controller (single-AZ / zonal-shift feature).
 *
 * WHY THE CONTROLLER EXISTS. The in-tree Kubernetes service controller creates an NLB with
 * `instance` targets and cannot enable cross-zone load balancing or ARC zonal shift on it. A
 * zonal shift against that NLB reports ACTIVE and moves nothing measurable — the worst
 * outcome for a demo whose claim is that the shift recovered the AZ. The LBC creates an NLB
 * with `ip` targets (pods as targets), which is what makes draining one AZ observable.
 *
 * WHY THIS IS A SEPARATE FILE FROM karpenter-iam.ts. Both are IRSA roles off the same OIDC
 * provider, but their policies and blast radius are unrelated: Karpenter launches and
 * terminates EC2 instances; this controller manages load balancers and target groups.
 * Merging them would produce one role holding both, which is strictly worse than two.
 *
 * THE OIDC PROVIDER IS PASSED IN, NOT CREATED. `iam.CfnOIDCProvider` is per-issuer-URL and
 * IAM rejects a duplicate for the same URL — creating a second one here would fail the
 * deploy with EntityAlreadyExists, which reads as a stack-naming problem rather than a
 * duplicate provider.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** Namespace and service account the rendered chart uses. Must match src/lbc/render.sh. */
export const LBC_NAMESPACE = 'kube-system';
export const LBC_SERVICE_ACCOUNT = 'aws-load-balancer-controller';

export interface LbcIamProps {
  /** Literal cluster name — used in the role name, so it must resolve at synth. */
  readonly clusterName: string;
  /**
   * ARN of the OIDC provider already created for this cluster (Karpenter's). Passed rather
   * than created: IAM allows exactly one provider per issuer URL.
   */
  readonly oidcProviderArn: string;
  /** The cluster's OIDC issuer URL, for the trust-policy condition keys. */
  readonly oidcIssuerUrl: string;
}

export class LbcIam extends Construct {
  /** The IRSA role the controller's service account annotation points at. */
  public readonly controllerRole: iam.Role;

  constructor(scope: Construct, id: string, props: LbcIamProps) {
    super(scope, id);

    // The trust policy matches the issuer host WITHOUT the scheme, which is how IAM records
    // the provider. Fn::select on '//' so it stays correct for a URL unknown until deploy.
    const issuerHost = cdk.Fn.select(1, cdk.Fn.split('//', props.oidcIssuerUrl));

    // CfnJson because the condition KEY is `<issuerHost>:sub` and CDK refuses a token as a
    // map key — «KeyMustResolveToString». Same precedent as karpenter-iam.ts.
    const trustConditions = new cdk.CfnJson(this, 'ControllerTrustConditions', {
      value: {
        // StringEquals on BOTH sub and aud, never StringLike. A wildcard `sub` would let ANY
        // service account in the cluster assume a role that can create and delete load
        // balancers and rewrite target groups — including the app's own front door.
        [`${issuerHost}:sub`]:
          `system:serviceaccount:${LBC_NAMESPACE}:${LBC_SERVICE_ACCOUNT}`,
        [`${issuerHost}:aud`]: 'sts.amazonaws.com',
      },
    });

    this.controllerRole = new iam.Role(this, 'ControllerRole', {
      roleName: `${props.clusterName}-lbc-controller`,
      assumedBy: new iam.FederatedPrincipal(
        props.oidcProviderArn,
        { StringEquals: trustConditions.value },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description:
        'AWS Load Balancer Controller (IRSA). Manages the app NLB and its target groups.',
    });

    // ── Policy: VENDORED from upstream, not hand-written ────────────────────────────────
    //
    // 63 actions across ec2, elasticloadbalancing and iam. Hand-transcribing that is how a
    // spec value that does not exist in reality gets introduced (AGENTS.md bug class 3), and
    // a MISSING action fails only at runtime: the controller logs AccessDenied, the Service
    // never gets an NLB, and synth, cfn-lint and every unit test stay green.
    //
    // src/lbc/iam_policy.json is the upstream policy at the pinned controller version with
    // ONE whole statement removed — the 17 acm / cognito-idp / shield / waf-regional / wafv2
    // actions, all of which serve Ingress/ALB features this demo does not use. See that
    // file's $comment for the full reasoning and the removed action list.
    const policyPath = path.join(__dirname, '..', '..', 'lbc', 'iam_policy.json');
    const vendored = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      Statement: unknown[];
    };
    new iam.CfnPolicy(this, 'ControllerPolicy', {
      policyName: `${props.clusterName}-lbc-controller`,
      roles: [this.controllerRole.roleName],
      // $comment is documentation for humans and is NOT a valid policy element — IAM
      // rejects the document with MalformedPolicyDocument if it is passed through.
      policyDocument: { Version: '2012-10-17', Statement: vendored.Statement },
    });
  }
}
