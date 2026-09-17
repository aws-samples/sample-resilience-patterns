import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { CfnPlan } from 'aws-cdk-lib/aws-arcregionswitch';
import { Construct } from 'constructs';
import { APP_DEPLOYMENT_NAME, APP_HPA_NAME, APP_NAMESPACE } from '../k8s';
import { APP_RECORD_NAME, PRIMARY_REGION, REGIONS, recordSetIdentifier } from '../regions';

/**
 * The access policy ARC Region Switch requires — its OWN purpose-built policy, not the
 * general-purpose AmazonEKSEditPolicy.
 *
 * Grants exactly what the scaling block does, per the developer guide's table: get and
 * update on the `scale` subresource of any kind, get on the `status` subresource, and get
 * plus patch on `autoscaling/horizontalpodautoscalers`.
 *
 * Using AmazonEKSEditPolicy instead is not merely over-broad — plan EVALUATION checks for
 * this specific policy: "Region switch also validates that the IAM role is associated to
 * the correct Access Entry policy." So the wrong policy fails evaluation while IAM, synth
 * and deploy all look correct.
 */
const ARC_SCALING_POLICY_ARN =
  'arn:aws:eks::aws:cluster-access-policy/AmazonARCRegionSwitchScalingPolicy';

export interface FailoverStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * The ARC Region Switch plan, its two roles, and the primary cluster's access entry
 * (step 7 — the SKELETON; step 8 fills in the real failover sequence).
 *
 * Translated from `aws-samples/sample-resilience-patterns` `aurora/lib/failover-plan-stack.ts`
 * (MIT-0, provenance recorded here rather than copied). Raw L1 `CfnPlan` because
 * aws-cdk-lib 2.248.0 ships no L2 — and every property shape below was read off the
 * installed `.d.ts`, not from a design doc. That matters: `executionBlockType` and
 * `alarmType` are typed as bare `string`, so a wrong literal compiles, synthesizes and
 * deploys, then fails when a human presses the button.
 *
 * WHY THE BODY IS DELIBERATELY TINY. Two blocks, not five. A wrong block-type string
 * fails against a skeleton in seconds rather than against a full sequence where the
 * failure could be any of five steps.
 *
 *   deactivate : one EKSResourceScaling
 *   activate   : one Route53HealthCheck
 *
 * C-001 (a HUMAN authorizes the failover) is enforced AT INVOCATION ONLY. The
 * ManualApproval gate was REMOVED 2026-08-26 so the demo executes end to end unattended,
 * which means the operator's StartPlanExecution call IS the authorization. The two points
 * below therefore stop being defence in depth behind a gate and become the whole control.
 * `triggers` is omitted — but that alone is insufficient, because `associatedAlarms`
 * accepts `alarmType: 'trigger'`, so a plan with no triggers can still be handed a
 * trigger alarm through the alarm map. Every entry here is `applicationHealth`, and a
 * test asserts both halves against the synthesized template.
 *
 * WHAT THE GATE'S REMOVAL COST: the two-identity separation. An approver previously
 * assumed PlanApprovalRole, distinct from the execution role, so one identity could not
 * both authorize and perform the failover. Anyone who can call StartPlanExecution now
 * does both. Acceptable in a demo account; reinstate the gate for anything real.
 *
 * DEPLOY POSITION: after `dns` (a post-deploy stack). The activate workflow's
 * Route53HealthCheck block needs a real `hostedZoneId`, and that zone is created by the
 * DNS stack, which itself cannot exist until the Kubernetes-created load balancers do.
 */
export class FailoverStack extends cdk.Stack {
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: FailoverStackProps) {
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

    const hostedZoneId = new cdk.CfnParameter(this, 'HostedZoneId', {
      type: 'String',
      description: 'Private hosted zone holding the latency records the plan shifts.',
    });
    const primaryClusterName = new cdk.CfnParameter(this, 'PrimaryClusterName', {
      type: 'String',
      description: 'Primary EKS cluster name, for this region\'s access entry.',
    });
    const clusterArns = REGIONS.map(
      (r, i) =>
        new cdk.CfnParameter(this, `R${i}ClusterArn`, {
          type: 'String',
          description: `EKS cluster ARN in ${r.name} — scopes the execution role.`,
        }),
    );
    const appHealthAlarmArns = REGIONS.map(
      (r, i) =>
        new cdk.CfnParameter(this, `R${i}AppHealthAlarmArn`, {
          type: 'String',
          description: `Application-health alarm for traffic served by ${r.name}.`,
        }),
    );
    const globalClusterId = new cdk.CfnParameter(this, 'GlobalClusterIdentifier', {
      type: 'String',
      description: 'Aurora global cluster the plan switches over (step 8).',
    });
    const dbClusterArns = REGIONS.map(
      (r, i) =>
        new cdk.CfnParameter(this, `R${i}DbClusterArn`, {
          type: 'String',
          description: `Aurora member cluster ARN in ${r.name} (step 8).`,
        }),
    );

    // ---- permissions boundary ------------------------------------------------------
    //
    // Caps what the execution role can EVER do, independently of its own policy. A
    // failover role that can edit IAM can grant itself anything; one that can touch
    // Organizations or account settings can act outside the blast radius the plan
    // describes. Explicit deny wins over any allow, including a future one someone adds
    // to the role in a hurry during an incident.
    const boundary = new iam.ManagedPolicy(this, 'PlanRoleBoundary', {
      description: 'Ceiling for the ARC Region Switch roles: no IAM writes, org or account writes.',
      statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['*'], resources: ['*'] }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          // ENUMERATED rather than `iam:*`, and the reason is concrete: ARC Region
          // Switch's plan evaluation calls iam:SimulatePrincipalPolicy against these very
          // roles to check they can perform their steps, and an explicit DENY on `iam:*`
          // cannot be allowed past -- so a blanket deny left plan evaluation permanently
          // in `actionRequired` with "missing policies [iam:SimulatePrincipalPolicy]"
          // (live 2026-08-26). Simulate is READ-ONLY: it evaluates policy and mutates
          // nothing, so permitting it grants no new authority.
          //
          // The list below is the privilege-escalation set from the recommendation
          // engine's "Use IAM Roles and Scoped Down Policies" / "Prevent Privilege
          // Escalation" guidance -- permission mutation, credential mutation, and
          // PassRole. Naming actions instead of a wildcard is also what AWS least-privilege
          // guidance asks for ("prefer resource-level and specific actions"). A failover
          // role that can edit IAM can grant itself anything, and that is still denied.
          actions: [
            'iam:Add*',
            'iam:Attach*',
            'iam:Create*',
            'iam:Delete*',
            'iam:Detach*',
            'iam:Put*',
            'iam:Remove*',
            'iam:Set*',
            'iam:Update*',
            'iam:Tag*',
            'iam:Untag*',
            'iam:PassRole',
            'organizations:*',
            'account:*',
          ],
          resources: ['*'],
        }),
      ],
    });

    // ---- the execution role ---------------------------------------------------------
    //
    // Region Switch supports neither service-linked nor service roles, so this one is
    // customer-managed. It is what ARC assumes to perform the steps.
    //
    // A second role lived here until 2026-08-26 -- PlanApprovalRole, the identity a human
    // assumed to release the ManualApproval gate, deliberately separate so that one
    // identity could not both authorize and perform the failover. Removing the gate
    // removed that separation too; see the C-001 note in the file header.
    this.executionRole = new iam.Role(this, 'PlanExecutionRole', {
      roleName: `${props.appId}-arc-execution`,
      description: 'Assumed by ARC Region Switch to execute the failover plan.',
      // arc-region-switch.amazonaws.com, NOT any r53recovery principal — the older
      // Route 53 ARC principals belong to routing controls and readiness, which are
      // different capabilities.
      assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
      permissionsBoundary: boundary,
    });
    // ---- execution role permissions ------------------------------------------------
    //
    // Scoped to the specific clusters, the specific global cluster and the specific
    // hosted zone. No wildcard resource on a mutating action, with ONE documented
    // exception below.
    const globalClusterArn = cdk.Arn.format(
      { service: 'rds', region: '', resource: 'global-cluster', resourceName: globalClusterId.valueAsString, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME },
      this,
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AuroraGlobalSwitchover',
        actions: ['rds:FailoverGlobalCluster', 'rds:SwitchoverGlobalCluster'],
        resources: [
          globalClusterArn,
          ...dbClusterArns.map((p) => p.valueAsString),
        ],
      }),
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AuroraRead',
        actions: ['rds:DescribeGlobalClusters', 'rds:DescribeDBClusters'],
        // Read-only, and RDS describe calls do not accept resource-level scoping for
        // global clusters.
        resources: ['*'],
      }),
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EksScaling',
        actions: [
          'eks:DescribeCluster',
          'eks:ListNodegroups',
          'eks:DescribeNodegroup',
          'eks:UpdateNodegroupConfig',
        ],
        resources: clusterArns.flatMap((p) => [
          p.valueAsString,
          // Node groups are children of the cluster ARN.
          `${p.valueAsString}/*`,
        ]),
      }),
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'Route53RecordShift',
        // ListResourceRecordSets is required to READ the record set before rewriting it;
        // plan evaluation flagged the DNS steps (then shift-dns-away and restore-dns,
        // now the single shift-dns-to-target) without
        // it (live 2026-08-26). Its resource IS the hosted zone, so it scopes exactly
        // like the change action -- no wildcard needed.
        actions: [
          'route53:ChangeResourceRecordSets',
          'route53:ListResourceRecordSets',
          'route53:GetChange',
        ],
        resources: [
          cdk.Arn.format(
            { service: 'route53', region: '', account: '', resource: 'hostedzone', resourceName: hostedZoneId.valueAsString },
            this,
          ),
          // GetChange's resource is a change id, not a zone.
          'arn:aws:route53:::change/*',
        ],
      }),
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'Route53HealthChecks',
        // THE ONE WILDCARD ON MUTATING ACTIONS, and it is unavoidable rather than lazy.
        // ARC Region Switch CREATES and service-manages the health checks its
        // Route53HealthCheck block flips — they are not resources we declare, so there is
        // no ARN to scope to at synth time, and Route 53 health-check actions do not
        // support resource-level permissions in the first place. The permissions boundary
        // is what bounds this.
        actions: [
          'route53:CreateHealthCheck',
          'route53:UpdateHealthCheck',
          'route53:DeleteHealthCheck',
          'route53:GetHealthCheck',
          'route53:GetHealthCheckStatus',
          'route53:ChangeTagsForResource',
        ],
        resources: ['*'],
      }),
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ObserveAndReport',
        actions: [
          'cloudwatch:DescribeAlarms',
          // ARC reads alarm HISTORY as well as current state when it evaluates the
          // associated alarms -- flagged by plan evaluation 2026-08-26. Same read-only
          // character as DescribeAlarms, so it belongs in the same statement.
          'cloudwatch:DescribeAlarmHistory',
          'cloudwatch:GetMetricData',
          'arc-region-switch:GetPlan',
          'arc-region-switch:GetPlanExecution',
          'arc-region-switch:ListPlans',
          'arc-region-switch:ListPlanExecutions',
          'arc-region-switch:ListRoute53HealthChecks',
        ],
        resources: ['*'], // read-only
      }),
    );

    // ---- plan-evaluation self-check --------------------------------------------------
    //
    // ARC Region Switch's plan evaluation calls iam:SimulatePrincipalPolicy against the
    // roles named in the plan to decide whether each step CAN run, and it reports
    // "missing policies [iam:SimulatePrincipalPolicy]" when it cannot. Without this the
    // plan sits in evaluationState=actionRequired and the pre-flight gate the runbook
    // depends on (Day 2 step 2.0) can never come back clean -- so the one check that
    // protects against a scale-nothing-report-success failover is itself unusable.
    //
    // Read-only: Simulate evaluates policy and changes nothing. Scoped to the execution
    // role's OWN ARN, per least-privilege guidance on resource-level restrictions --
    // not `Resource: *`.
    //
    // This was a pair of statements, one per role, until the ManualApproval gate was
    // removed (2026-08-26). The approval role's copy went with it, along with its
    // `arc-region-switch:ApprovePlanExecutionStep` grant -- keeping a role whose only
    // purpose was a deleted gate would leave standing permissions with no caller.
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PlanEvaluationSelfCheck',
        actions: ['iam:SimulatePrincipalPolicy'],
        resources: [this.executionRole.roleArn],
      }),
    );

    // ---- Kubernetes access for the execution role (PRIMARY cluster) -----------------    //
    // WITHOUT THIS THE SCALING STEP FAILS AT EXECUTION TIME while IAM, synth, deploy and
    // even ARC's own plan evaluation all look correct. IAM lets ARC call the EKS API;
    // scaling a Deployment is a KUBERNETES authorization decision, and the cluster knows
    // nothing about this role until an access entry says so. The cluster's
    // authenticationMode is API_AND_CONFIG_MAP (step 2) precisely so access entries work
    // at all — under the CloudFormation default of CONFIG_MAP they are silently ignored.
    //
    // Namespace-scoped Edit, not cluster admin: the plan's job is to scale a Deployment
    // in one namespace.
    //
    // The STANDBY cluster's entry cannot live here — an access entry is a REGIONAL
    // resource and must be created in the cluster's own region. It is in
    // StandbyAccessStack, which deploys after this one so the role exists first.
    new eks.CfnAccessEntry(this, 'PrimaryClusterAccess', {
      clusterName: primaryClusterName.valueAsString,
      principalArn: this.executionRole.roleArn,
      accessPolicies: [
        {
          policyArn: ARC_SCALING_POLICY_ARN,
          accessScope: { type: 'namespace', namespaces: [APP_NAMESPACE] },
        },
      ],
    });

    // ---- audit reports (step 8) ----------------------------------------------------
    //
    // ARC writes a PDF per plan execution. For a regulated audience that artifact is a
    // large part of the point: it is the evidence that a failover was authorized, by
    // whom, and what each step did. Opting in therefore needs a bucket.
    //
    // The bucket is created HERE rather than added to the operator's prerequisite list
    // because it has security properties that should not be left to a hand-created
    // bucket: a customer-managed key, TLS-only access, versioning, and no public access.
    const reportsKey = new kms.Key(this, 'ReportsKey', {
      description: 'Encrypts ARC Region Switch execution reports.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo: torn down after use
    });
    const reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: reportsKey,
      enforceSSL: true, // adds the aws:SecureTransport deny
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const REPORTS_PREFIX = 'region-switch-reports';
    // BOTH grants, not just the S3 one. `s3:PutObject` alone against a CMK-encrypted
    // bucket fails as "Access to KMS is not allowed" — a grant that is necessary but not
    // sufficient, and one this project has already been bitten by. grantWrite on the
    // bucket handles the key because the bucket knows its own encryption key.
    reportsBucket.grantWrite(this.executionRole, `${REPORTS_PREFIX}/*`);

    // ---- the plan -------------------------------------------------------------------
    //
    // The DNS block config is shared by BOTH workflows: deactivate shifts traffic away,
    // activate shifts it back, and they operate on the same records. Defined once so the
    // two can never drift — a mismatched recordSetIdentifier would leave the plan
    // reporting success while flipping nothing.
    const dnsBlockConfig = {
      hostedZoneId: hostedZoneId.valueAsString,
      recordName: APP_RECORD_NAME,
      // An ARRAY of objects, not a keyed map (verified in the .d.ts). The identifiers
      // must match the DNS stack's setIdentifier strings exactly.
      recordSets: REGIONS.map((r) => ({
        recordSetIdentifier: recordSetIdentifier(r.name),
        region: r.name,
      })),
      timeoutMinutes: 5,
    };

    const plan = new CfnPlan(this, 'Plan', {
      name: `${props.appId}-region-switch`,
      description:
        'Human-approved multi-region failover: approve, scale the standby, switch the ' +
        'Aurora writer, shift traffic.',
      executionRole: this.executionRole.roleArn,
      // activeActive describes the RECOVERY APPROACH — both regions serve reads. It does
      // NOT mean multi-writer Aurora; the global database has exactly one writer.
      // activePassive, not activeActive: one region serves and the other stands by, so
      // ACTIVATING the standby IS deactivating the primary -- one sequenced cutover, not
      // two workflows an operator has to run in the right order. Declaring activeActive
      // also made the plan self-inconsistent with its own warm-standby story.
      recoveryApproach: 'activePassive',
      regions: REGIONS.map((r) => r.name),
      primaryRegion: PRIMARY_REGION,
      // Actual recovery is measured against this: plan execution time plus the time the
      // application-health alarms take to reach OK.
      recoveryTimeObjectiveMinutes: 30,
      // A KEYED MAP, not an array (verified in the .d.ts). Every entry is
      // applicationHealth — see the C-001 note in the class docstring.
      associatedAlarms: Object.fromEntries(
        REGIONS.map((r, i) => [
          `appHealth${recordSetIdentifier(r.name)}`,
          {
            alarmType: 'applicationHealth',
            resourceIdentifier: appHealthAlarmArns[i].valueAsString,
          },
        ]),
      ),
      // Audit PDFs per execution — the artifact a regulated audience asks for. bucketPath
      // carries the bucket NAME plus an optional prefix ("bucket" or "bucket/prefix");
      // there is no separate bucketName property. reportOutput is an ARRAY.
      reportConfiguration: {
        reportOutput: [
          {
            s3Configuration: {
              bucketPath: `${reportsBucket.bucketName}/${REPORTS_PREFIX}`,
              // Pins the expected owner so a bucket that changed hands between deploy
              // and execution cannot silently receive the audit trail.
              bucketOwner: this.account,
            },
          },
        ],
      },
      // triggers: DELIBERATELY ABSENT. Populating it would let an alarm start the
      // failover with no human in the loop, which is the opposite of this demo's premise.
      workflows: [
        {
          // ONE workflow, and DELIBERATELY NO workflowTargetRegion. The schema makes
          // that property optional, and StartPlanExecution REQUIRES --target-region and
          // --action, so leaving it unset is what makes this plan bidirectional: the
          // operator names the region to activate at execution time and the same three
          // blocks run in either direction. Failing back is the same workflow with the
          // other region, not a second workflow with a different name.
          //
          // Every block config below enumerates BOTH regions (scalingResources is keyed
          // appId -> region, globalAuroraConfig lists both cluster ARNs, and the Route 53
          // config covers both records), which is what lets one workflow be symmetric.
          workflowTargetAction: 'activate',
          workflowDescription:
            'Activate the target region: raise its capacity, move the Aurora writer to ' +
            'it, then shift traffic to it. Under activePassive this deactivates the other.',
          steps: [
            {
              // STEP 1 OF 3, AND THE ORDER IS THE WHOLE POINT. Compute is raised BEFORE the
              // database moves and before traffic shifts. Shifting DNS first would move
              // the outage rather than end it: requests would land on a standby with
              // pods that are not there yet. The positional test on these four is the
              // most valuable assertion in the suite precisely because this order looks
              // like something worth tidying.
              // Region-neutral name: this workflow runs in both directions, and
              // "standby" would be simply wrong on a fail-back.
              name: 'scale-target-capacity',
              description: 'Raise capacity in the region being activated, BEFORE any traffic arrives.',
              executionBlockType: 'EKSResourceScaling',
              executionBlockConfiguration: {
                eksResourceScalingConfig: {
                  // Objects with clusterArn, NOT bare ARN strings, and a minimum of two.
                  eksClusters: clusterArns.map((p) => ({ clusterArn: p.valueAsString })),
                  kubernetesResourceType: { apiVersion: 'apps/v1', kind: 'Deployment' },
                  // WHICH workload to scale. There is no scale-everything-of-this-kind
                  // mode: kubernetesResourceType states only the KIND, and without
                  // scalingResources the block has nothing to act on — it would report
                  // success while shifting traffic to an unscaled standby.
                  //
                  // Shape: an ARRAY of nested maps, region -> CLUSTER ARN -> resource.
                  // Verified in the .d.ts, and the developer guide's console fields
                  // confirm the nesting ("Resource for Region: for each Region, enter
                  // information for the EKS cluster, including the EKS cluster ARN,
                  // resource namespace").
                  //
                  // WRAPPED IN CfnJson, and that is forced rather than chosen. The inner
                  // key is a cluster ARN, which arrives as a CfnParameter — and CDK
                  // rejects a token in a map KEY outright:
                  //   «KeyMustResolveToString» ... resolves to {"Ref":"R0ClusterArn"}
                  // CfnJson defers the whole structure to deploy time so the real ARN
                  // becomes the key. The cost is one CloudFormation custom resource in
                  // this stack; it is not VPC-attached, so it has the egress it needs to
                  // answer the CloudFormation callback. The alternative — computing the
                  // ARN at synth time — would need the account number at synth, which
                  // would make the build account-specific.
                  //
                  // The workload names come from src/cdk/k8s.ts, the SAME module the
                  // manifests are asserted against, so the plan cannot drift from the
                  // Deployment it scales.
                  //
                  // SHAPE, read off the DEPLOYED resource schema (cloudformation
                  // describe-type AWS::ARCRegionSwitch::Plan), NOT the SDK/CFN docs --
                  // those say only "array of maps" and the CDK type is a nested
                  // Record<string, Record<string, ...>> that does not say which key is
                  // which:
                  //   ScalingResources -> [ KubernetesScalingApplication ]
                  //   KubernetesScalingApplication -> { ".+": RegionalScalingResource }
                  //   RegionalScalingResource -> { "^[a-z]{2}-[a-z-]+-\d+$": KubernetesScalingResource }
                  // So it is APPLICATION-id first, then REGION -- and the inner key is
                  // pattern-constrained to a region name.
                  //
                  // We had it inverted (region -> cluster ARN -> resource). It synthesized
                  // and passed 207 tests; the deploy failed at CREATE with
                  //   ScalingResources/0/us-east-2: extraneous key [arn:aws:eks:...]
                  // because the ARN cannot match the region pattern. Live 2026-08-26.
                  //
                  // The cluster ARNs do NOT belong in here at all -- eksClusters above
                  // already names them, and ARC resolves cluster-per-region from that.
                  // Which also means NO CfnJson: both keys are now plain literals (the
                  // Deployment name and the region names from regions.ts), so there is no
                  // token in a map key and the custom resource this used to need is gone.
                  scalingResources: [
                    {
                      [APP_DEPLOYMENT_NAME]: Object.fromEntries(
                        REGIONS.map((r) => [
                          r.name,
                          {
                            name: APP_DEPLOYMENT_NAME,
                            namespace: APP_NAMESPACE,
                            // STEP 10e. One field, and it does more than it looks like.
                            //
                            // ARC scales the DEPLOYMENT via the scale subresource whether
                            // or not this is set. What hpaName adds is a patch to the HPA:
                            //   {"spec":{"behavior":{"scaleDown":{"selectPolicy":"Disabled"}}}}
                            // which stops the autoscaler undoing the scale-up on its next
                            // ~15-second cycle. It never touches minReplicas -- an earlier
                            // design assumed it did, and would have excluded the wrong
                            // field in Argo.
                            //
                            // Omitted, the failure is quiet and quick: ARC scales to 4, the
                            // HPA sees low CPU, decides 2 is enough, and scales back --
                            // with Argo not involved at all and the plan reporting success.
                            //
                            // The name comes from k8s.ts so the plan, the manifest that
                            // creates the HPA, and Argo's ignoreDifferences entry cannot
                            // drift apart. A wrong name here is a silently skipped patch.
                            hpaName: APP_HPA_NAME,
                          },
                        ]),
                      ),
                    },
                  ],
                  // 150, down from 200 (2026-09-14). THIS NUMBER COMPOUNDS.
                  //
                  // ARC sizes the target from the SOURCE region's max replica count over the
                  // last 24 hours (sampledMaxInLast24Hours, the only approach EKS offers; no
                  // reset, no shorter window) times targetPercent. So every execution inside
                  // one window feeds the next: at 200 a fail-over asked 3 -> 6, the fail-back
                  // then asked 6 -> 12 -- past the 10-pod ceiling (HPA maxReplicas 10 = 2
                  // managed nodes + 16 vCPU of Karpenter at one pod per node) -- and the
                  // execution sat in scale-target-capacity for its full timeout before being
                  // cancelled (2026-09-09, us-east-2/0e76faf068eeec41).
                  //
                  // 150 keeps genuine headroom for one region absorbing both regions'
                  // traffic and lets ONE full round trip fit inside a window: 3 -> 5 -> 8.
                  // A THIRD execution in the same 24 hours asks ceil(8 x 1.5) = 12 and stalls
                  // again; that is a documented operating limit, not a defect, and
                  // topology.test.ts pins the arithmetic against the real HPA / NodePool /
                  // node-group values so the ceiling cannot drift under it silently. 100
                  // would remove the compounding entirely at the cost of the headroom.
                  targetPercent: 150,
                  // capacityMonitoringApproach deliberately OMITTED: only one value is
                  // documented and it was never verified, so leaving it unset takes the
                  // service default rather than asserting a literal that may not exist.
                  ungraceful: {
                    // EKS shape: minimumSuccessPercentage. The Aurora block's ungraceful
                    // is a completely different shape (a single string), so cross-copying
                    // between them fails — tested both ways.
                    minimumSuccessPercentage: 90,
                  },
                  // 8, down from 20 (2026-09-14) -- now a MEASUREMENT, not headroom.
                  //
                  // Node provisioning is a SERIAL PREREQUISITE of this block: the app carries
                  // required one-pod-per-node anti-affinity, so the surge replicas go Pending
                  // until Karpenter batches them, calls CreateFleet, an instance boots, the
                  // kubelet joins, the image pulls from ECR and the readiness probe passes.
                  // The 20 written before any live run was headroom for that path.
                  //
                  // Four live executions have now timed it. When capacity exists the whole
                  // step completes in 3-6 minutes (2026-09-09 22:31Z failover: 9 min for the
                  // full 3-step plan; 2026-09-10 11:38Z fail-back: 6 min for all three). When
                  // capacity CANNOT exist -- a request above the pod ceiling -- the step does
                  // nothing useful for however long this says, and the operator can neither
                  // skip nor cancel until it expires. At 20 that cost the 2026-09-09 fail-back
                  // twenty silent minutes. 8 covers the measured path with margin and turns a
                  // mis-sized request into an 8-minute failed step plus a
                  // `--action-to-take skip`, rather than a twenty-minute wait on stage.
                  //
                  // Aurora's block stays at 20 (a global writer switchover has its own clock);
                  // Route53's is 5. Three different steps, three measured numbers.
                  //
                  // Note the interaction with minimumSuccessPercentage above: if capacity
                  // never arrives, 3 of 4 ready is 75% and this block FAILS rather than
                  // shifting traffic onto a standby that cannot serve it. That is the
                  // intended behaviour and it is the thing being demonstrated.
                  timeoutMinutes: 8,
                },
              },
            },
            {
              // STEP 2 OF 3, where data-loss risk becomes real. There is no approval gate
              // ahead of it any more (removed 2026-08-26): the operator's
              // StartPlanExecution call is the authorization, and the plan carries no
              // triggers, so nothing reaches this step unattended.
              name: 'switch-aurora-writer',
              description: 'Move the Aurora global writer to the region being activated.',
              executionBlockType: 'AuroraGlobalDatabase',
              executionBlockConfiguration: {
                globalAuroraConfig: {
                  globalClusterIdentifier: globalClusterId.valueAsString,
                  databaseClusterArns: dbClusterArns.map((p) => p.valueAsString),
                  // GRACEFUL FIRST. switchoverOnly is the zero-data-loss path, and the
                  // gray-failure premise is what makes it available: the region is still
                  // up and replication is still flowing, so the writer can be handed over
                  // cleanly rather than promoted out from under it. A hard outage would
                  // not offer this choice, and that contrast is the demo's best moment.
                  behavior: 'switchoverOnly',
                  ungraceful: {
                    // Aurora shape: a single string. Falls back to a promotion if the
                    // graceful switchover cannot complete, so a real outage is not
                    // stranded waiting for a clean handover that will never come.
                    ungraceful: 'failover',
                  },
                  timeoutMinutes: 20,
                },
              },
            },
            {
              // STEP 3 OF 3, LAST. Traffic moves only after there is somewhere healthy for
              // it to go and a writer to accept it.
              name: 'shift-dns-to-target',
              description: 'Shift the latency records toward the region being activated.',
              executionBlockType: 'Route53HealthCheck',
              executionBlockConfiguration: {
                route53HealthCheckConfig: dnsBlockConfig,
              },
            },
          ],
        },
        // NO postRecovery workflow — DELIBERATELY, and it was not an oversight: one was
        // built, deployed (plan v4) and executed live on 2026-08-27, then REMOVED by
        // operator decision. The deployed schema supports it (WorkflowTargetAction enum
        // includes postRecovery; CustomActionLambda steps with regionToRun
        // activeRegion/inactiveRegion are the documented post-recovery pattern), so
        // re-adding it is feasible — but the judgment was that two kubectl verbs of
        // cleanup should not be coupled to ARC's execution model. The cleanup lives in
        // build/restore-steady-state.sh (runbook §7b); what the ARC version validated
        // (the buildspec, the KUBECTL_S3_URI per-run override, selectPolicy-not-
        // minReplicas) survives there, pinned by tests.
      ],
    });

    // ---- the DNS records this plan shifts -------------------------------------------
    //
    // WHY THE RECORDS LIVE IN THIS STACK AND NOT THE dns STACK. The plan and these records
    // are a MUTUAL contract: the plan's Route53HealthCheck block names them by
    // { hostedZoneId, recordName, recordSetIdentifier }, and they in turn must carry the
    // health check ids the plan vends. Splitting that contract across two stacks meant the
    // ids could only reach the records out-of-band -- they were attached by hand twice
    // (2026-08-27, 2026-08-31) because nothing in the templates owned them, and a
    // CloudFormation DELETE of a record then failed to match its live shape. Co-located,
    // the whole contract is intra-stack and CloudFormation-enforced. The hosted ZONE stays
    // in the dns stack: it is long-lived infrastructure, whereas these records are part of
    // the failover mechanism.
    //
    // HEALTH CHECK SELECTION. `PlanHealthChecks` is the only GetAtt attribute the
    // CloudFormation reference documents for AWS::ARCRegionSwitch::Plan, and it gives no
    // description -- the shape was established by deploying it. Each entry is a
    // colon-delimited composite that carries its OWN region:
    //   <hostedZoneId>:<recordName>:<region>:<healthCheckId>
    // Selecting by matching that region field would make the pairing order-independent, and
    // that IS the right design -- but CloudFormation rejects the only construct that can
    // express it (see the long note on `healthCheckFor` below: Conditions cannot reference a
    // resource). So the index is positional and the pairing is enforced AFTER deploy by
    // build/verify-arc-health-checks.py, which fails loudly on a mis-bind. That guard is not
    // optional: ordering here is undocumented, and attaching the standby's check to the
    // primary record is SILENT (the plan reports success and shifts traffic the wrong way).
    const lb = REGIONS.map((r, i) => ({
      region: r.name,
      dns: new cdk.CfnParameter(this, `R${i}LbDns`, {
        type: 'String',
        description: `DNS name of the ${r.name} app NLB (a Kubernetes value, read post-install).`,
      }),
      zoneId: new cdk.CfnParameter(this, `R${i}LbZoneId`, {
        type: 'String',
        description: `Canonical hosted zone id of the ${r.name} app NLB (from elbv2 describe-load-balancers).`,
      }),
    }));

    const hcEntries = cdk.Token.asList(plan.getAtt('PlanHealthChecks'));
    const ID_FIELD = 3;
    // Entry i of PlanHealthChecks -> its <healthCheckId> field. POSITIONAL, and that is a
    // deliberate, guarded compromise. Read this before changing it.
    //
    // Each entry is self-describing (<hostedZoneId>:<recordName>:<region>:<healthCheckId>), so
    // the CORRECT thing would be to select by matching the region FIELD rather than by index.
    // An earlier revision did exactly that with a CfnCondition doing Fn::Equals on the region
    // field. CloudFormation REJECTS it at CreateChangeSet:
    //
    //   Template format error: Unresolved dependencies [Plan]. Cannot reference resources in
    //   the Conditions block of the template
    //
    // The Conditions block may only reference parameters, pseudo-parameters and mappings --
    // never a resource attribute. CDK synthesizes it without complaint, so this is invisible
    // until deploy (proven live 2026-08-31). Fn::Select/Fn::Split are fine HERE, inside
    // Resources; only the condition was illegal.
    //
    // So the index is an assumption: entry 0 is REGIONS[0]. Ordering is undocumented, and a
    // wrong binding is SILENT at the CloudFormation level -- the plan would report success and
    // shift traffic the wrong way. What makes this acceptable is that the assumption is CHECKED
    // at deploy time, loudly: build/verify-arc-health-checks.py runs as the final deploy step,
    // re-derives the true region->id pairing from `arc-region-switch
    // list-route53-health-checks`, and FAILS the deploy if either record carries the wrong id.
    // Do not remove that step, and do not silence it -- it is the only thing standing between
    // this index and a demo that fails over backwards.
    const healthCheckFor = (i: number): string =>
      cdk.Fn.select(ID_FIELD, cdk.Fn.split(':', cdk.Fn.select(i, hcEntries)));

    // ONE RecordSetGroup, never two RecordSets: Route 53 refuses same-name+type records
    // under different routing policies, so a routing-policy change is legal only as a
    // SINGLE change batch -- and CloudFormation updates separate RecordSet resources
    // individually, which Route 53 rejects. Proven live 2026-08-31, experiments A-D in
    // docs/lessons.md #17. Do not split this up.
    //
    // FAILOVER, not latency: latency routing resolves per-resolver, so both regions served
    // their local clients -- active-active behaviour under an activePassive plan.
    //
    // setIdentifier is a CONTRACT with the plan's Route53HealthCheck block above; the
    // literal pairing (PRIMARY carries recordSetIdentifier(REGIONS[0])) is what the block is
    // written against.
    new route53.CfnRecordSetGroup(this, 'AppRecords', {
      hostedZoneId: hostedZoneId.valueAsString,
      recordSets: lb.map((p, i) => ({
        name: APP_RECORD_NAME,
        type: 'A',
        failover: i === 0 ? 'PRIMARY' : 'SECONDARY',
        setIdentifier: recordSetIdentifier(p.region),
        healthCheckId: healthCheckFor(i),
        aliasTarget: {
          dnsName: p.dns.valueAsString,
          hostedZoneId: p.zoneId.valueAsString,
          // Route 53 consults the NLB's own target health too, so a region whose targets are
          // all unhealthy stops answering even before ARC flips its check.
          evaluateTargetHealth: true,
        },
      })),
    });

    // The ARC-vended Route 53 health checks, exposed for the DNS records to consume.
    //
    // ARC CREATES these checks but does NOT attach them to any record -- the AWS docs put
    // that on the caller -- and until they are attached an execution flips check state while
    // the records reference nothing: the plan reports SUCCESS and shifts NO traffic.
    //
    // `PlanHealthChecks` is the only GetAtt attribute the CloudFormation reference documents
    // for this resource (Arn / Owner / PlanHealthChecks / Version). Its description there is
    // literally "Property description not available", so the shape below was established by
    // deploying it and reading the value (2026-08-31). Each list entry is a COLON-DELIMITED
    // composite that is self-describing -- it carries its own region, so nothing here depends
    // on list ordering:
    //
    //   <hostedZoneId>:<recordName>:<region>:<healthCheckId>
    //   Z1019...:app.eks-mr-demo.internal:us-east-2:3783b1ae-c713-4894-8627-1686b2d6563d
    //
    // Joined with `|` because ':' is the field separator inside each entry. The two shapes
    // that the live resource schema also marks read-only (`Route53HealthChecks`,
    // `HealthChecksForPlan`) are NOT GetAtt-addressable: CloudFormation rejects any nested
    // path with "Requested attribute ... must be a readonly property in schema", verified by
    // a failed deploy. See docs/lessons.md #18.
    new cdk.CfnOutput(this, 'PlanHealthChecks', {
      // Joined with ',' -- NOT '|'. Stack outputs are written into dist/<stack>.env, which
      // later deploy phases SOURCE with `. dist/<stack>.env`, so a '|' in the value made
      // bash treat it as a pipe and try to execute the second entry as a command. That
      // failed the deploy one phase LATER, reporting a health check id as
      // "command not found" with nothing pointing at quoting. deploy-stack.sh now
      // shlex-quotes every output value, which is the real fix; a comma keeps the value
      // safe even somewhere that quoting is not applied. ':' is the intra-entry separator,
      // so it cannot double as the between-entry one.
      value: cdk.Fn.join(',', cdk.Token.asList(plan.getAtt('PlanHealthChecks'))),
    });

    new cdk.CfnOutput(this, 'PlanArn', { value: plan.ref });
    new cdk.CfnOutput(this, 'ExecutionRoleArn', { value: this.executionRole.roleArn });
  }
}
