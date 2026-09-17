import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Status + Chaos Cockpit — PDD 2026-08-31-chaos-status-page.
 *
 * A single-page cockpit served through the existing us-west-2 operator access door as an
 * ALB Lambda target. STEPS 0-4: a NO-VPC Lambda that serves
 * the UI (GET /cockpit), a JSON status aggregate (GET /cockpit/api/status), and THREE
 * write actions — the L1 error knob (POST /cockpit/api/knob), FIS arm/start/stop
 * (POST /cockpit/api/fis) and the ARC failover trigger (POST /cockpit/api/failover).
 *
 * The write role is capped by `CockpitRoleBoundary`, which denies the privilege-escalation
 * set and allows `iam:PassRole` ONLY to fis.amazonaws.com — the single edge FIS requires.
 * Step 5 remains: the security-review/threat-model note on that PassRole edge, and replacing
 * runtime ARN discovery with threaded CfnParameters.
 *
 * ARN DISCOVERY IS AT RUNTIME (not CfnParameter-threaded): the handler resolves the ARC
 * plan, error-rate knobs, FIS template ids, cluster and node-group names itself from stack
 * outputs via cloudformation DescribeStacks. This is the fast path to a working cockpit;
 * Step 5 tightens it to threaded CfnParameters + a derived-contract test. Adding a
 * CfnParameter requires editing the deploy step in the SAME commit (docs/lessons.md #4),
 * which is why threading is its own step rather than smuggled in here.
 *
 * See docs/lessons.md #19/design/detailed-design.md.
 */
export interface CockpitProps {
  readonly appId: string;
  /** Primary region (us-east-2) — FIS templates, primary knob, and ALL EMF metrics live here. */
  readonly primaryRegion: string;
  /** Standby region (us-west-2) — where this cockpit is hosted. */
  readonly standbyRegion: string;
  /** The access door's ALB listener — the /cockpit* rule attaches here. */
  readonly listener: elbv2.ApplicationListener;
  /** Metric namespace the load generator emits to (MyResilienceDemo). */
  readonly metricNamespace: string;

  // ── STEP 5: threaded ARNs (was runtime cloudformation:DescribeStacks discovery) ──
  //
  // Every one of these arrives as a CfnParameter off the dotenv rail. Threading them is
  // not tidiness: it lets the role DROP `cloudformation:DescribeStacks`, and that grant
  // was one leg of a documented escalation chain. AWS privilege-escalation guidance
  // names it explicitly — "IAM principal accesses passed role via CloudFormation: IAM
  // principal allows iam:PassRole, cloudformation:CreateStack, and
  // cloudformation:DescribeStacks" — and this role held two of those three. It never held
  // CreateStack, so the chain was incomplete, but removing DescribeStacks removes the
  // partial pattern rather than relying on the missing third leg.
  //
  // Adding or removing any parameter here REQUIRES editing the deploy step in the SAME
  // commit (docs/lessons.md #4): a CfnParameter the deploy does not supply breaks the
  // DEPLOY, not the build. `test/cockpit.test.ts` derives the required set from the
  // synthesized template and compares it against the generated task, so that mismatch
  // fails at build time instead of at phase 6 of a live deploy.

  /** ARC Region switch plan ARN — scopes StartPlanExecution and is read by the handler. */
  readonly planArn: string;
  /** Error-rate SSM parameter NAME in the primary region (e.g. /eks-mr-demo-us-east-2/error-rate). */
  readonly primaryKnobParam: string;
  /** Error-rate SSM parameter NAME in the standby region. */
  readonly standbyKnobParam: string;
  /** FIS service role ARN — `iam:PassRole` is scoped to exactly this. */
  readonly fisRoleArn: string;
  /** Comma-separated per-AZ FIS template ids, one CSV per fault. */
  readonly fisPacketLossTemplateIds: string;
  readonly fisLatencyTemplateIds: string;
  /** az=templateId pairs for the single-AZ latency fault. Paired by NAME, never by index. */
  readonly fisLatencyTemplatesByAz: string;
  /** az=templateId pairs for the single-AZ packet-loss fault. */
  readonly fisPacketLossTemplatesByAz: string;
  /** az=templateId pairs for the single-AZ power-interruption fault (the AZ impairment). */
  readonly fisPowerTemplatesByAz: string;
  /** az=templateId pairs for the single-AZ brownout fault (the gray beat). */
  readonly fisBrownoutTemplatesByAz: string;
  /** Primary-region EKS cluster + managed node group (the FIS target set). */
  readonly primaryClusterName: string;
  readonly primaryNodeGroupName: string;
  /**
   * App NLB ARN (primary region) — scopes the arc-zonal-shift:ResourceIdentifier
   * condition key so the shift writes can act on exactly this one load balancer.
   * Kubernetes-created (LB Controller), so it is discovered by the installer and
   * threaded along the dotenv rail like the argocd NLB ARN — not a CFN attribute.
   */
  readonly appNlbArn: string;
  /**
   * AZ name=id pairs (us-east-2a=use2-az1,...) from the primary region stack.
   * StartZonalShift.awayFrom needs the ID; the FIS templates filter by the name.
   * Threaded as explicit pairs, never two positional lists (bug class 19).
   */
  readonly azNameIdPairs: string;
}

export class Cockpit extends Construct {
  constructor(scope: Construct, id: string, props: CockpitProps) {
    super(scope, id);

    // --- permissions boundary (the ceiling on everything below) -------------------
    //
    // Cloned in shape from `PlanRoleBoundary` (failover-stack.ts): Allow everything,
    // then DENY the privilege-escalation set explicitly, because an explicit Deny wins
    // over any Allow — including one a future step adds to this role in a hurry.
    //
    // ONE DELIBERATE DIFFERENCE from PlanRoleBoundary, and it is the whole reason this
    // is a separate policy: that one denies `iam:PassRole` outright, but the cockpit MUST
    // pass the FIS role to fis.amazonaws.com to start an experiment. A blanket PassRole
    // deny would intersect that grant away and every FIS start would fail with an
    // authorization error that points at the role policy, where the grant is present and
    // looks correct. So PassRole is denied EXCEPT to fis.amazonaws.com — the narrowest
    // form that still lets the one required edge through.
    //
    // least-privilege guidance (prefer specific actions over wildcards) and the
    // recommendation engine's "Least Privilege Design" / "Prevent Privilege Escalation"
    // guidance are what this enumeration comes from.
    const boundary = new iam.ManagedPolicy(this, 'CockpitRoleBoundary', {
      description: 'Ceiling for the cockpit role: no IAM/org/account writes; PassRole to FIS only.',
      statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['*'], resources: ['*'] }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          // Permission and credential mutation. ENUMERATED, not `iam:*`: a blanket deny
          // also blocks iam:SimulatePrincipalPolicy, which ARC plan evaluation calls and
          // which is read-only (that exact mistake left plan evaluation stuck in
          // actionRequired on 2026-08-26 — see failover-stack.ts).
          actions: [
            'iam:Add*', 'iam:Attach*', 'iam:Create*', 'iam:Delete*', 'iam:Detach*',
            'iam:Put*', 'iam:Remove*', 'iam:Set*', 'iam:Update*', 'iam:Tag*', 'iam:Untag*',
            'organizations:*',
            'account:*',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['iam:PassRole'],
          resources: ['*'],
          // Deny PassRole to ANY service other than FIS. The role policy separately
          // scopes the allow to the single FIS role ARN, so the two together mean: this
          // role may hand exactly one role to exactly one service.
          conditions: {
            StringNotEquals: { 'iam:PassedToService': 'fis.amazonaws.com' },
          },
        }),
      ],
    });

    // --- read + write IAM role ----------------------------------------------------
    // READS scoped to resource ARNs where the action supports it; `*` only for actions
    // AWS does not let you resource-scope (each justified inline), exactly as the
    // region-switch exec role's `ObserveAndReport`/`AuroraRead` do.
    // WRITES (Steps 2-4) are scoped per-action below and capped by the boundary above.
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: boundary,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // STEP 5 removed `cloudformation:DescribeStacks` here. It existed only so the handler
    // could discover ARNs at runtime; those now arrive as CfnParameters. Removing it also
    // removes two-thirds of the documented PassRole-via-CloudFormation escalation
    // pattern (PassRole + CreateStack + DescribeStacks) from this role.

    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ObserveArcAndAurora',
      // ARC read + RDS global-cluster describe + CW read: none are resource-scopable
      // (the exec role documents this verbatim for the same actions), so `*` with the
      // read-only justification carried here.
      actions: [
        'arc-region-switch:GetPlan',
        'arc-region-switch:GetPlanExecution',
        'arc-region-switch:ListPlans',
        'arc-region-switch:ListPlanExecutions',
        'arc-region-switch:GetPlanEvaluationStatus',
        'arc-region-switch:ListRoute53HealthChecks',
        'rds:DescribeGlobalClusters',
        'rds:DescribeDBClusters',
        'cloudwatch:GetMetricData',
        'cloudwatch:DescribeAlarms',
        // AZ DISCOVERY for the per-AZ availability lines and for traffic-derived AZ
        // eligibility (D3). The handler cannot know the AZ dimension VALUES ahead of time:
        // they are whatever AZs the scheduler actually placed pods in. ListMetrics answers
        // that with a documented response shape, and its documented `RecentlyActive=PT3H`
        // filter is exactly the "has this AZ served traffic recently" question D3 asks.
        //
        // Chosen over a GetMetricData SEARCH expression deliberately: SEARCH would need no
        // new action, but the FORMAT of the result labels it returns is not documented, and
        // this project has already been burned once by parsing an undocumented identifier
        // format (docs/lessons.md #18). A documented shape beats saving one grant.
        //
        // Takes no resource input at all — like `fis:List*` (bug class 22c), a
        // resource-scoped grant for it yields AccessDenied. It sits in THIS statement, which
        // is read-only by construction, so nothing mutating rides the wildcard (D4b).
        'cloudwatch:ListMetrics',
        'route53:GetHealthCheckStatus',
      ],
      resources: ['*'], // read-only; these actions do not support resource-level scoping
    }));

    // SSM knob READ (set-point display), scoped to the EXACT two parameter ARNs built from
    // the threaded names — no `-*/` wildcard segment any more.
    const knobArn = (region: string, paramName: string): string =>
      `arn:aws:ssm:${region}:${cdk.Aws.ACCOUNT_ID}:parameter${paramName}`;
    const knobArns = [
      knobArn(props.primaryRegion, props.primaryKnobParam),
      knobArn(props.standbyRegion, props.standbyKnobParam),
    ];
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadErrorKnob',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: knobArns,
    }));

    // EKS DescribeCluster (IAM half of the replica read; the Kubernetes half is the
    // view-only access entries added per-region in the region stacks — Step 1b/5. Until
    // both exist the handler degrades that one tile to "unavailable", never errors).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeClusters',
      actions: ['eks:DescribeCluster', 'eks:ListClusters'],
      resources: ['*'], // ListClusters is not scopable; DescribeCluster scoped at Step 5
    }));

    // ================================================================================
    // WRITES — Steps 2-4. Everything below is capped by CockpitRoleBoundary above.
    // ================================================================================

    // --- STEP 2: the L1 error knob ------------------------------------------------
    // PutParameter on EXACTLY the two error-rate parameter ARNs (threaded, Step 5 —
    // previously a `/<appId>-*/error-rate` name pattern). Nothing else in SSM is writable,
    // notably not ssm:SendCommand, which would be a code-execution path onto the nodes.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteErrorKnob',
      actions: ['ssm:PutParameter'],
      resources: knobArns,
    }));

    // --- STEP 3: FIS arm / start / stop -------------------------------------------
    // ARMING is a TAG, and that is the actual safety interlock rather than a formality:
    // the shipped templates select `aws:ec2:instance` by `ChaosAllowed=true`, and managed
    // node group instances live in an AWS-owned ASG that CloudFormation cannot tag. So an
    // experiment started against untagged nodes resolves ZERO targets and reports success
    // having done nothing (build/start-region-wide-injection.sh documents this). Tagging
    // is therefore both the arm and the thing that makes a start meaningful.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DiscoverNodeInstancesForArming',
      actions: [
        'eks:DescribeNodegroup',
        'autoscaling:DescribeAutoScalingGroups',
        // The SSM-registration precheck the wrapper script performs. Without it a start
        // against unregistered nodes is the same silent zero-target success.
        'ssm:DescribeInstanceInformation',
        'ec2:DescribeInstances',
        'ec2:DescribeTags',
      ],
      resources: ['*'], // none of these Describe/List actions support resource scoping
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ArmAndDisarmNodes',
      actions: ['ec2:CreateTags', 'ec2:DeleteTags'],
      // INSTANCES IN THE PRIMARY REGION ONLY. The FIS templates are primary-only
      // (region-stack.ts), so tagging anything in the standby would arm nothing while
      // still being a write. Scoped to instances — not `*` — so this cannot tag a VPC,
      // a security group or a snapshot.
      resources: [`arn:aws:ec2:${props.primaryRegion}:${cdk.Aws.ACCOUNT_ID}:instance/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ArmAndDisarmNodeGroupAsg',
      // THE ASG HALF OF THE ARMING GESTURE (power interruption). Its Pause-ASG-Scaling
      // action targets `aws:ec2:autoscaling-group` by ChaosAllowed=true, and it is
      // load-bearing: an untagged ASG relaunches the stopped AZ's instances within
      // minutes and the heal-race erases the beat. The ASG is EKS-owned so CloudFormation
      // cannot tag it — the arm action does, exactly the instances' reasoning. Scoped to
      // the primary region's `eks-*` ASG names (every EKS managed-node-group ASG carries
      // that prefix), so this cannot tag an unrelated ASG in the account.
      actions: ['autoscaling:CreateOrUpdateTags', 'autoscaling:DeleteTags'],
      resources: [
        `arn:aws:autoscaling:${props.primaryRegion}:${cdk.Aws.ACCOUNT_ID}:autoScalingGroup:*:autoScalingGroupName/eks-*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'RunFisExperiments',
      actions: [
        'fis:StartExperiment',
        'fis:StopExperiment',
        'fis:GetExperiment',
        'fis:GetExperimentTemplate',
        'fis:TagResource',
      ],
      // StartExperiment REQUIRES BOTH resource types per the FIS service authorization
      // reference (experiment* and experiment-template* are both marked required), so both
      // must be present or the call is denied.
      resources: [
        `arn:aws:fis:${props.primaryRegion}:${cdk.Aws.ACCOUNT_ID}:experiment-template/*`,
        `arn:aws:fis:${props.primaryRegion}:${cdk.Aws.ACCOUNT_ID}:experiment/*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ListFisExperiments',
      // SEPARATE STATEMENT ON `*`, AND IT MUST BE. `fis:ListExperiments` and
      // `fis:ListExperimentTemplates` declare NO resource type in the FIS service
      // authorization reference, so an ARN-scoped statement does not authorize them at all:
      // they failed live with "no identity-based policy allows the fis:ListExperiments
      // action" even though the action was granted, because it was granted on ARNs.
      // Found by reading the deployed cockpit's own status output — the deploy was green
      // and every stack complete while this read was broken.
      actions: ['fis:ListExperiments', 'fis:ListExperimentTemplates'],
      resources: ['*'], // not resource-scopable; both are read-only List operations
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'PassFisRoleToFisOnly',
      actions: ['iam:PassRole'],
      // STEP 5: the EXACT FIS role ARN, threaded from the region stack's FisRoleArn output.
      // This was a prefix wildcard on a CDK-generated role name (`...-FisFisRole*`), which
      // is the loosest form this grant ever took. Both the recommendation engine's
      // "Use IAM Roles and Scoped Down Policies" and least-privilege guidance ask for the
      // specific role plus the PassedToService condition — this is now both.
      resources: [props.fisRoleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'fis.amazonaws.com' } },
    }));

    // --- STEP 4: the ARC failover trigger -----------------------------------------
    // StartPlanExecution IS the authorization — the plan carries no approval gate
    // (region-switch/failover-stack.ts), so this grant is the whole control and the
    // typed confirmation in the handler is UI friction on top of it.
    // UpdatePlanExecutionStep is the step-recovery half: on a stuck step the operator can
    // take only `skip` or `switchToUngraceful` (there is NO retry — verified live twice),
    // and without this grant a timed-out EKS scale step would park the execution.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ExecuteFailover',
      actions: [
        'arc-region-switch:StartPlanExecution',
        'arc-region-switch:UpdatePlanExecutionStep',
      ],
      // STEP 5: the EXACT plan ARN, threaded from the failover stack's PlanArn output —
      // previously `:plan/*`, i.e. every plan in the account. A failover trigger scoped to
      // "any plan" is the difference between one demo's blast radius and the account's.
      resources: [props.planArn],
    }));

    // --- STEP 10: the zonal-shift control -----------------------------------------
    // READS: ListZonalShifts / ListManagedResources are account/Region-wide listers that
    // take NO resource input, so they cannot be resource-scoped — their own '*' statement,
    // exactly the fis:List* shape (bug class 22c). Kept SEPARATE from the writes below so
    // nothing mutating rides the wildcard (the D4b rule, same as ListFisExperiments).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ListZonalShiftResources',
      actions: [
        'arc-zonal-shift:ListZonalShifts',
        'arc-zonal-shift:ListManagedResources',
        'arc-zonal-shift:GetManagedResource',
      ],
      resources: ['*'],
    }));
    // WRITES: the service scopes by the arc-zonal-shift:ResourceIdentifier CONDITION KEY,
    // not by the Resource ARN element — an ARN in `resources` authorizes NOTHING here.
    // Resource stays '*' and the StringLike condition pinned to exactly the app NLB ARN is
    // the ONLY scoping layer: the CockpitRoleBoundary is allow-all + deny-list and does
    // not deny arc-zonal-shift, so it does escalation prevention, not least privilege.
    // That makes this condition key load-bearing (D4a). No iam:PassRole — zonal shift
    // passes no service role, so the FIS PassRole edge above is untouched.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'RunZonalShift',
      actions: [
        'arc-zonal-shift:StartZonalShift',
        'arc-zonal-shift:UpdateZonalShift',
        'arc-zonal-shift:CancelZonalShift',
      ],
      resources: ['*'],
      conditions: { StringLike: { 'arc-zonal-shift:ResourceIdentifier': props.appNlbArn } },
    }));

    // --- the Lambda (NO VPC) ------------------------------------------------------
    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(29), // < ALB idle; handler returns well under this
      memorySize: 256,
      role,
      environment: {
        APP_ID: props.appId,
        PRIMARY_REGION: props.primaryRegion,
        STANDBY_REGION: props.standbyRegion,
        METRIC_NAMESPACE: props.metricNamespace,
        // STEP 5: threaded, replacing runtime DescribeStacks discovery. The handler reads
        // these and never calls CloudFormation. Every one is REQUIRED at import time, so a
        // parameter the deploy fails to supply surfaces as an immediate Lambda import error
        // rather than as a tile that silently reads "unavailable" forever.
        PLAN_ARN: props.planArn,
        PRIMARY_KNOB_PARAM: props.primaryKnobParam,
        STANDBY_KNOB_PARAM: props.standbyKnobParam,
        FIS_PACKET_LOSS_TEMPLATE_IDS: props.fisPacketLossTemplateIds,
        FIS_LATENCY_TEMPLATE_IDS: props.fisLatencyTemplateIds,
        FIS_LATENCY_TEMPLATES_BY_AZ: props.fisLatencyTemplatesByAz,
        FIS_PACKET_LOSS_TEMPLATES_BY_AZ: props.fisPacketLossTemplatesByAz,
        FIS_POWER_TEMPLATES_BY_AZ: props.fisPowerTemplatesByAz,
        FIS_BROWNOUT_TEMPLATES_BY_AZ: props.fisBrownoutTemplatesByAz,
        PRIMARY_CLUSTER_NAME: props.primaryClusterName,
        PRIMARY_NODE_GROUP_NAME: props.primaryNodeGroupName,
        // STEP 10: the zonal-shift control. Both REQUIRED at import time, same rule as above.
        APP_NLB_ARN: props.appNlbArn,
        AZ_NAME_ID_PAIRS: props.azNameIdPairs,
      },
    });

    // --- ALB Lambda target + /cockpit* listener rule ------------------------------
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'Targets', {
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2Targets.LambdaTarget(fn)], // auto-adds the elb invoke permission
      // No port/protocol/vpc for a LAMBDA target group — CDK synth errors if supplied.
    });

    new elbv2.ApplicationListenerRule(this, 'Rule', {
      listener: props.listener,
      priority: 10, // unused positive int; the default action stays the Argo target group
      conditions: [elbv2.ListenerCondition.pathPatterns(['/cockpit', '/cockpit/*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // NO ungated /health behavior. An earlier revision added one so the page could read
    // the active region "client's-eye" by probing /health through the access door. That
    // was WRONG on two counts, both found by checking the live account:
    //
    //   1. This ALB's default action is the ARGO target group — the app is not behind it
    //      at all — so /health reached argocd-server, not src/app/server.py. The pill
    //      read "probe failed", and the behavior was an unintended path into the Argo
    //      server for that path.
    //   2. Even routed to the app it could not answer the question. The private-zone
    //      record is LATENCY-routed with one record per region, so DNS has no single
    //      global answer — each resolver gets its own nearest healthy region, and an ALB
    //      target group holds one region's fixed IPs and can never follow a failover.
    //
    // The active region now comes from OBSERVED CLIENT TRAFFIC (RegionSuccess/RegionError
    // per Region) in handler.py::_region_traffic — see that docstring. The access door is
    // reached only through the observer bastion over SSM (build/tunnel.sh).
  }
}
