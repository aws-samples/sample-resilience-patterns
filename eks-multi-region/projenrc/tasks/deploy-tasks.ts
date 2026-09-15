import type { awscdk } from 'projen';

/**
 * One region in a multi-region (M5 peering) deploy. Mirrors the skeleton's
 * `src/cdk/regions.ts` `RegionConfig` (networking-changeset §4.1) so a demo can pass
 * its `REGIONS` array straight into `createDeployTasks`.
 */
export interface RegionConfig {
  /** AWS region name, e.g. 'us-east-1'. */
  readonly name: string;
  /** VPC CIDR for this region's RegionStack, e.g. '10.0.0.0/16'. */
  readonly cidr: string;
}

/**
 * Provider-AGNOSTIC deploy orchestration for the green CRE demo skeleton.
 *
 * Lives once in `skeleton/_shared/projenrc/tasks/` and is copied verbatim into BOTH
 * provider trees. Both CIs invoke the SAME entry point: `npx projen deploy`.
 *
 * Ported (generalized) from the predecessor project-app/projenrc/tasks/deploy-tasks.ts. It replaces
 * projen's native `cdk deploy` with the proven the predecessor project mechanism: per-stack
 * `aws cloudformation deploy` driven by `build/deploy-stack.sh` against templates
 * uploaded to a per-region S3 prefix, capturing each stack's outputs to a
 * `dist/<STACK_NAME>.env` dotenv, then SOURCING those dotenvs into downstream stacks'
 * `STACK_PARAMETERS` (CfnParameters) in topological order. This is NOT a single CDK app
 * with `crossRegionReferences` — it is the dotenv→CfnParameter thread the multi-region
 * networking (`PeeringMesh`, M5) and PDD demos extend.
 *
 * ──────────────────────────────────────────────────────────────────────────────────
 * TWO MODES (backward-compatible). The SINGLE-REGION mode is the default and is
 * BIT-FOR-BIT the original green baseline — `createDeployTasks(project)` with no
 * `regions` arg (or with fewer than 2 regions) emits exactly the original Phase 0/1/2
 * that deploys the one `$PROJECT_NAME-demo` stack. Nothing about the green skeleton
 * changes. The peering phase is NEVER emitted below two regions.
 *
 *   SINGLE-REGION (default, `regions` omitted / length < 2):
 *     Phase 0  compute the run-scoped S3 prefix once → dist/assets_prefix
 *     Phase 1  publish assets (deploy:upload → deploy:s3 only; NO deploy:docker)
 *     Phase 2  deploy the one `$PROJECT_NAME-demo` stack via deploy-stack.sh
 *
 *   MULTI-REGION (opt-in, `regions.length >= 2` — networking-changeset §3, §6):
 *     Phase 0  compute the run-scoped S3 prefix once → dist/assets_prefix
 *     Phase 1  publish assets
 *     Phase 2  per-region loop: deploy `$PROJECT_NAME-region-<name>` into <name>,
 *              OUTPUTS_PREFIX=REGION_<i>, capturing REGION_<i>_{VPCID,VPCCIDR,
 *              ROUTETABLEIDS,REGION} to dist/<stack>.env
 *     Phase 3  CONDITIONAL peering phase (only when regions.length >= 2): source all
 *              region dotenvs, deploy `$PROJECT_NAME-peering` into regions[0], passing
 *              per-peer CfnParameters (R<i>Region/R<i>VpcId/R<i>VpcCidr/R<i>RouteTableIds)
 *              sourced from the dotenvs.
 *
 * A demo opts into multi-region by (a) switching `src/cdk/app.ts` to instantiate a
 * `RegionStack` per region + a `PeeringStack` (networking-changeset §4.2-4.4) and
 * (b) passing its `REGIONS` array to `createDeployTasks(project, REGIONS)`. The
 * always-on single-region `app.ts` stub is unaffected.
 *
 * The full machinery (the `deployStackStep` helper that sources prior dotenvs, the
 * per-task `requiredEnv` fail-fast, the topological multi-phase order) is present and
 * proven. `deploy:docker` is gated behind enableLoadGen (M7) and is NOT emitted here.
 *
 * Required env for `deploy`:
 *   ASSETS_BUCKET_PREFIX   Common prefix; the regional bucket is `<prefix>-<region>`.
 *   AWS_REGION             Single-region mode only: target region for the demo stack.
 *                          Multi-region mode derives regions from `regions[].name`.
 *
 * Optional env:
 *   ASSETS_PREFIX          Defaults to $PROJECT_NAME/$(UTC timestamp)/.
 *   VPC_CIDR               Single-region: defaults to 10.0.0.0/16 (VpcCidr param).
 *   REGION_<i>_VPC_CIDR    Multi-region: overrides regions[i].cidr for region i.
 *
 * @param project  The projen app.
 * @param regions  Optional multi-region config. Omit (or pass < 2 regions) for the
 *                 unchanged single-region green baseline.
 * @param opts     Optional load-gen toggle (changeset §4b). When `enableLoadGen` is
 *                 true, a `deploy:docker` task (crane push, build/deploy-docker.sh) is
 *                 registered and folded into `deploy:upload` so the CI path pushes
 *                 the image to ECR. When false (green default), `deploy:upload` is the
 *                 S3-only publish — no ECR/crane work, no behavior change vs baseline.
 */
/**
 * A stack deployed AFTER the per-region loop — one that exists once for the whole demo
 * rather than once per region, and that usually depends on region-stack outputs.
 *
 * Kept generic on purpose: the factory is shared skeleton code, so it should not know
 * about any particular demo's stacks. A demo declares its own singletons and their
 * dependencies.
 */
export interface SingletonStackPhase {
  /** Stack suffix; the stack is `$PROJECT_NAME-<suffix>`. Must appear in STACK_SUFFIXES. */
  readonly suffix: string;
  /** Region to deploy into. */
  readonly region: string;
  /**
   * Suffixes of stacks whose dotenv files this stack sources, so their outputs are in
   * scope for `stackParameters`. Region stacks are `region-<name>`. Like
   * {@link PostDeployPhase.sourceFiles}, plain paths (anything containing a `/`) pass
   * through unchanged, for dotenvs a post-deploy step wrote itself — which is how a
   * {@link DeployTaskOptions.postDeployStacks} stack consumes values discovered
   * post-install.
   *
   * Each becomes `. dist/$PROJECT_NAME-<suffix>.env`. Order matters — later wins.
   */
  readonly sourceSuffixes?: readonly string[];
  /** Prefix for THIS stack's captured outputs. Keys become `<PREFIX>_<OUTPUTKEY>`. */
  readonly outputsPrefix?: string;
  /** CloudFormation parameters, as `Name=value` pairs. Values may reference sourced vars. */
  readonly stackParameters?: Record<string, string>;
}

/**
 * A step run after every CloudFormation stack, for work CloudFormation cannot do.
 */
export interface PostDeployPhase {
  /** Short label for the progress line. */
  readonly name: string;
  /** Region the AWS CLI calls in this step target. */
  readonly region: string;
  /**
   * Stack suffixes whose dotenvs to source, so their outputs are in scope. Also accepts
   * plain paths (anything containing a `/`) for dotenvs an earlier post-deploy step
   * wrote itself.
   */
  readonly sourceFiles?: readonly string[];
  /** Inline environment for the command, as `NAME=value`. Values may reference sourced vars. */
  readonly env?: Record<string, string>;
  /**
   * The command. Runs inside `bash -c`, so real bash applies — but it MUST NOT contain a
   * single quote, which would terminate the wrapper early and fail with `unexpected EOF`
   * many phases into a deploy. That is asserted at synth time.
   */
  readonly run: string;
}

export interface DeployTaskOptions {
  readonly enableLoadGen?: boolean;
  /**
   * Arbitrary steps run AFTER every stack, in declaration order.
   *
   * Two kinds of work genuinely cannot be a CloudFormation stack and need this:
   *
   *   - Reading a value that no resource exposes as an attribute. Aurora's
   *     `CfnGlobalCluster` surfaces nothing at all — not even an ARN — so the global
   *     writer endpoint only exists via `aws rds describe-global-clusters` after the
   *     cluster is up.
   *   - Installing Kubernetes objects. Those are owned by the cluster's API server, not
   *     by CloudFormation.
   *
   * Kept generic, like {@link SingletonStackPhase}: the factory is shared skeleton code
   * and should not know what any demo does here. Each step gets the same dotenv-sourcing
   * wrapper the stack steps get, so prior stacks' outputs are in scope.
   */
  readonly postDeploy?: readonly PostDeployPhase[];
  /**
   * Singleton stacks to deploy, in order, after every region stack.
   *
   * Ordering here is not cosmetic. Aurora Global Database, for example, forces
   *   RegionStack(primary) → global cluster → secondary member
   * because a member joins a global cluster by declaring `globalClusterIdentifier`,
   * which requires that cluster to already exist, while the cluster itself adopts the
   * primary member. A singleton listed before its dependency fails at deploy time only.
   */
  readonly singletons?: readonly SingletonStackPhase[];
  /**
   * Singleton stacks deployed AFTER the {@link postDeploy} phases, for stacks whose
   * parameters only exist once post-deploy work has run.
   *
   * The motivating case is DNS: Route 53 alias records target load balancers that
   * KUBERNETES creates, so their DNS names and canonical hosted zone ids are not
   * CloudFormation outputs of anything — they are discovered by the installer phases
   * and written onto the dotenv rail. A stack consuming them cannot deploy at the
   * {@link singletons} position, which precedes every post-deploy phase.
   *
   * Same shape as {@link singletons}; only the position differs.
   */
  readonly postDeployStacks?: readonly SingletonStackPhase[];
  /**
   * Post-deploy work that must run AFTER the {@link postDeployStacks} — Phase 7.
   * Used for verifications and touch-ups that depend on a post-deploy stack having
   * landed (for example confirming the ARC health checks are attached). Same shape and
   * builder as {@link postDeploy}, later position.
   */
  readonly finalSteps?: readonly PostDeployPhase[];
  /**
   * Emit the Phase 3 peering step. Defaults to `true`, preserving existing behaviour.
   *
   * The phase is otherwise gated on region COUNT alone (`regions.length >= 2`) with no
   * way to decline it, so any 2+ region demo that does NOT need a cross-region VPC path
   * gets a deploy step for a `$PROJECT_NAME-peering` stack it never authored. That is a
   * green build and a failed deploy: packaging iterates `STACK_SUFFIXES` (which
   * correctly omits `peering`) while the deploy asks for a template nobody produced.
   *
   * Pass `false` when nothing in the demo is VPC-routed across regions — Aurora Global
   * Database replication rides the AWS network, ARC Region switch uses per-region
   * service endpoints, and DNS-based traffic shifting needs no peer.
   */
  readonly peering?: boolean;
  /**
   * HOW images are published (changeset §4c/§4d). `'kaniko'` (CI) registers
   * `deploy:docker` (crane push, build/deploy-docker.sh) and folds it into
   * `deploy:upload`. `'cdk-assets'` (GitHub) registers nothing — the deploy workflow's
   * `cdk-assets publish` step pushes the image and `build/deploy-docker.sh` is not
   * vendored. Ignored when `enableLoadGen` is false. Defaults to `'kaniko'`.
   */
  readonly containerBuild?: 'kaniko' | 'cdk-assets';
  /**
   * Register `deploy:mirror` (build/mirror-images.sh) and fold it into
   * `deploy:upload`, copying the digest-pinned third-party images in
   * src/mirror/images.json into private ECR (step 10a).
   *
   * Requires `regions` to be supplied — the mirror names its target regions
   * explicitly and refuses to guess, because the standby cluster runs its own Argo
   * CD and needs every image locally.
   *
   * @default false
   */
  readonly mirrorImages?: boolean;
}

export function createDeployTasks(
  project: awscdk.AwsCdkTypeScriptApp,
  regions?: RegionConfig[],
  loadGenOpts: DeployTaskOptions = {},
): void {
  // Sync the unpacked dist/content.zip to EVERY target region's assets bucket.
  //
  // TEMPLATE GAP (7th, live-proven 2026-08-26): the template's single sync uses
  // $AWS_REGION — the pipeline-global CI default — so in a multi-region demo the
  // second region's bucket receives NOTHING and the region-1 stack fails at
  // create-change-set with "S3 object does not exist ... NoSuchKey". It survived
  // attempt 1 unseen only because that run died in region 0, before the region-1
  // deploy step ever executed. deploy:docker, deploy:mirror and the kubectl
  // stager already fan out per region; this brings deploy:s3 in line.
  //
  // One explicit exec per region (literal region names, no shell loop): projen's
  // dax shell passes ${VAR} braces through literally and the bash -c wrapper
  // pattern forbids inner single quotes, so per-region literal steps are the
  // only shape that is both dax-safe and testable. When no regions are supplied
  // the original single-$AWS_REGION step is emitted BIT-FOR-BIT (green-baseline
  // invariant, see the parity note near the bottom of this file).
  // EVERY REGION A STACK DEPLOYS INTO, not just regions[]. The 7th gap was fixed
  // for the workload regions only; the observer stack (a singleton in a THIRD
  // region) hit the identical failure on 2026-09-15 -- "S3 error: The specified
  // bucket does not exist" at create-change-set, after five stacks had already
  // deployed. CloudFormation reads the template from the bucket in the STACK's
  // region, so the set of buckets to populate is the set of regions any singleton
  // or post-deploy stack names, unioned with regions[]. Derived here so a future
  // stack in a fourth region cannot repeat this; the Makefile's `buckets` target
  // and cleanup.sh read the same set from the generated task (a test pins all
  // three to it).
  const syncRegions = [
    ...new Set([
      ...(regions ?? []).map((r) => r.name),
      ...(loadGenOpts.singletons ?? []).map((s) => s.region),
      ...(loadGenOpts.postDeployStacks ?? []).map((s) => s.region),
    ]),
  ];
  const syncSteps =
    syncRegions.length >= 2
      ? syncRegions.map((name) => ({
        exec: [
          `echo "Syncing dist/content/ → s3://$ASSETS_BUCKET_PREFIX-${name}/$ASSETS_PREFIX";`,
          `aws s3 sync --no-progress --region "${name}" --exclude "containers/*" dist/content "s3://$ASSETS_BUCKET_PREFIX-${name}/$ASSETS_PREFIX"`,
        ].join(' '),
      }))
      : [
        // --region is explicit so we don't rely on the CLI's auto-discovery HEAD
        // call (which some scoped IAM policies don't permit). containers/ is
        // excluded for forward-compat with the M7 docker path; harmless when absent.
        {
          exec: [
            'echo "Syncing dist/content/ → s3://$ASSETS_BUCKET_PREFIX-$AWS_REGION/$ASSETS_PREFIX";',
            'aws s3 sync --no-progress --region "$AWS_REGION" --exclude "containers/*" dist/content "s3://$ASSETS_BUCKET_PREFIX-$AWS_REGION/$ASSETS_PREFIX"',
          ].join(' '),
        },
      ];
  const deployS3 = project.addTask('deploy:s3', {
    description: 'Sync dist/content.zip contents to the regional assets buckets.',
    requiredEnv: ['ASSETS_BUCKET_PREFIX', 'ASSETS_PREFIX', 'AWS_REGION'],
    steps: [
      { say: 'Unpacking dist/content.zip...' },
      { exec: 'rm -rf dist/content && mkdir -p dist/content && unzip -q dist/content.zip -d dist/content' },
      ...syncSteps,
    ],
  });

  // Composite publish task the deploy stage invokes. Only the S3 half in the
  // green skeleton — deploy:docker is added on demand by load-gen (M7) and
  // spawned here behind the enableLoadGen flag.
  const deployUpload = project.addTask('deploy:upload', {
    description: 'Publish build artifacts: S3 content (containers added on demand by load-gen).',
  });
  deployUpload.spawn(deployS3);

  // Load-gen container publish (gated; changeset §4b/§4c). When enableLoadGen is true,
  // crane pushes the pre-built image tarballs (unpacked from dist/content/containers/)
  // to ECR in every target region. Folded into deploy:upload so the CI deploy:upload
  // job publishes BOTH channels (S3 + ECR) in one task. build/deploy-docker.sh is carried
  // verbatim from the predecessor project into a demo's build/ on pull-in; the green skeleton ships
  // none, so this task must never register when the flag is off.
  if (loadGenOpts.enableLoadGen && (loadGenOpts.containerBuild ?? 'kaniko') === 'kaniko') {
    const deployDocker = project.addTask('deploy:docker', {
      description: 'Push pre-built image tarballs to ECR via crane (build/deploy-docker.sh).',
      steps: [{ exec: 'bash build/deploy-docker.sh' }],
    });
    deployUpload.spawn(deployDocker);
  }

  // Third-party image mirror (step 10a). Copies the digest-pinned images in
  // src/mirror/images.json into PRIVATE ECR in every target region, so pods in the
  // isolated subnets can pull Argo CD, metrics-server and nginx over the step-3a
  // interface endpoints.
  //
  // Folded into deploy:upload rather than given its own phase because it belongs to
  // the same job as deploy:docker — Phase 1, "publishing assets" — and must complete
  // before any stack deploys or the in-VPC installer runs. Placing it later would let
  // the installer apply manifests whose images are not in ECR yet, which surfaces as
  // ImagePullBackOff long after the step that should have failed.
  //
  // MIRROR_REGIONS is threaded from the caller's region list (ultimately regions.ts)
  // rather than defaulted to AWS_REGION: the standby cluster runs its own Argo CD, so
  // every image is needed in BOTH regions. Falling back to the single deploy region
  // would leave the standby unable to pull precisely when it is promoted.
  if (loadGenOpts.mirrorImages) {
    const mirrorRegions = (regions ?? []).map((r) => r.name).join(',');
    if (!mirrorRegions) {
      throw new Error(
        'createDeployTasks: mirrorImages was requested but no regions were supplied. ' +
          'The mirror must name its target regions explicitly — silently falling back ' +
          'to AWS_REGION would mirror into the primary only and leave the standby ' +
          'unable to pull its images when promoted.',
      );
    }
    const deployMirror = project.addTask('deploy:mirror', {
      description:
        'Mirror pinned third-party images into private ECR via crane (build/mirror-images.sh).',
      env: { MIRROR_REGIONS: mirrorRegions },
      steps: [{ exec: 'bash build/mirror-images.sh' }],
    });
    deployUpload.spawn(deployMirror);
  }

  // Deploy one CFN stack from the uploaded content. requiredEnv gives fail-fast
  // (gotcha 10) before deploy-stack.sh runs. Reused per-stack/region as M5 / PDD
  // add deploy phases.
  project.addTask('deploy:stack', {
    description: 'Deploy one CFN stack from the uploaded content (once per stack/region).',
    requiredEnv: ['AWS_REGION', 'STACK_NAME', 'TEMPLATE_NAME', 'ASSETS_BUCKET', 'ASSETS_PREFIX'],
    steps: [{ exec: 'bash build/deploy-stack.sh' }],
  });

  // --- `deploy` top-level --------------------------------------------------
  //
  // AwsCdkTypeScriptApp ships a `deploy` task that runs `cdk deploy`. We don't
  // use `cdk deploy` (templates go to AWS via `aws cloudformation` against an
  // uploaded S3 prefix), so REMOVE it (gotcha 8) and re-author an orchestration.
  //
  // Each stack's deploy-stack.sh writes dist/<STACK_NAME>.env (the same dotenv
  // files the CI consumes as a dotenv artifact), so later steps just
  // source them before invoking deploy-stack.sh. Every exec step runs in its own
  // bash invocation, so the source+export+run pattern stays inside each step.
  project.tasks.removeTask('deploy');

  /**
   * Wrap a payload in ONE real bash invocation, asserting the single-quote invariant.
   *
   * Shared by the stack steps and the post-deploy steps so there is exactly one place
   * that knows this rule. See the long note in `deployStackStep` for why the payload
   * cannot simply be handed to projen's own shell.
   */
  const wrapInBash = (payload: string, label: string): string => {
    // The payload is single-quoted, so a single quote anywhere inside terminates the
    // wrapper early and the shell dies with `unexpected EOF` — a failure that surfaces
    // mid-deploy, many phases in, far from its cause. Assert at SYNTH time so a bad
    // value fails `npx projen` instead of a live deploy.
    if (payload.includes("'")) {
      throw new Error(
        `${label}: single quote in bash -c payload would break the wrapper. ` +
          `Offending step: ${payload}`,
      );
    }
    return `bash -c '${payload}'`;
  };

  /**
   * Build an inline `exec` that sets the per-stack env + runs deploy-stack.sh.
   *
   * `sourceFiles` lists prior stacks' dotenv files to source (order matters;
   * later files win) so this step sees the outputs from earlier deploy-stack
   * runs — `$<PREFIX>_VPCID` etc. then expand into the next stack's
   * STACK_PARAMETERS. This is the literal dotenv→CfnParameter thread. The green
   * skeleton's single stack sources nothing; the helper is the proven seam M5
   * extends.
   *
   * `env` is emitted as `VAR="value"` inline so bash expands `$VAR` references in
   * values (e.g. `AWS_REGION="$AWS_REGION"`). ASSETS_PREFIX is read from
   * dist/assets_prefix (written by Phase 0) per-step — projen's outer RunTask
   * resolves task env once at startup, before that file exists, so reading it
   * inline inside each step sidesteps the stale-evaluation problem.
   */
  const deployStackStep = (opts: {
    sourceFiles?: string[];
    env: Record<string, string>;
  }): string => {
    const sourceCmds = (opts.sourceFiles ?? []).map((f) => `. ${f}`).join(' && ');
    const escape = (v: string): string => v.replace(/([\\"])/g, '\\$1');
    const envAssignments = Object.entries(opts.env)
      .map(([k, v]) => `${k}="${escape(v)}"`)
      .join(' ');
    const inner = `ASSETS_PREFIX="$(cat dist/assets_prefix)" ${envAssignments} bash build/deploy-stack.sh`;

    // No dotenv to source (single-region green baseline): emit the ORIGINAL
    // unwrapped form, bit-for-bit. Keeps the green gate byte-identical.
    if (!sourceCmds) return inner;

    // ── Dotenv-sourcing form. Read this before changing it. ────────────────
    //
    // The previous implementation was `set -a && ${sourceCmds} && set +a && ` and
    // it DOES NOT WORK. projen's built-in dax shell is not bash and rejects
    // `set -a` outright:
    //
    //     set: invalid option: -a
    //
    // Proven by execution 2026-08-22 (design/03-pipeline-install-proof.md, P-1).
    // It went unnoticed because the single-region baseline passes no `sourceFiles`,
    // so the prefix was always the empty string and this branch never ran — the
    // green gate cannot reach it. `bash -n` does NOT catch it either: the string is
    // valid bash, and projen simply is not bash (P-3). Only running the task proves
    // this branch.
    //
    // Fix: run the whole step inside ONE real bash. `set -a` is dropped rather than
    // rehabilitated — it only matters for children that read variables by NAME, and
    // every value here is interpolated as an argument, which bash expands before
    // exec. Fewer moving parts (P-4, variant B).
    const payload = `${sourceCmds} && ${inner}`;

    return wrapInBash(payload, 'deployStackStep');
  };

  /**
   * Build an inline `exec` for a post-deploy step: source dotenvs, then run a command.
   *
   * Same wrapper and same invariant as the stack steps. `AWS_REGION` and
   * `AWS_DEFAULT_REGION` are both set because the AWS CLI honours the latter while most
   * scripts read the former, and a step that silently targets the wrong region is the
   * failure class this factory exists to prevent.
   */
  const postDeployStep = (phase: PostDeployPhase): string => {
    const sourceCmds = (phase.sourceFiles ?? [])
      .map((f) => (f.includes('/') ? f : `dist/$PROJECT_NAME-${f}.env`))
      .map((f) => `. ${f}`)
      .join(' && ');
    const envAssignments = Object.entries({
      AWS_REGION: phase.region,
      AWS_DEFAULT_REGION: phase.region,
      ...(phase.env ?? {}),
    })
      .map(([k, v]) => {
        // `env` values are DATA. They are emitted inside double quotes with `"` and `\`
        // escaped, so a plain `$VAR` reference expands but a command substitution does
        // NOT survive: `$(echo "$X" | sed "s|a|b|")` has its inner quotes escaped to
        // `\"` and the command breaks at runtime with `command not found`. That is a
        // silent corruption — the synth is green, the string looks plausible, and only
        // running the step reveals it. Fail at synth instead, and point at `run`, which
        // is raw shell.
        if (v.includes('$(')) {
          throw new Error(
            `postDeployStep(${phase.name}): env value for ${k} contains a command ` +
              'substitution, which will be escaped and broken. Compute it in `run` instead.',
          );
        }
        return `${k}="${v.replace(/([\\"])/g, '\\$1')}"`;
      })
      .join(' ');
    // -e so the first failure stops the step; -o pipefail so a failure on the LEFT of a
    // pipe is not masked by a healthy exit on the right. Both matter here: these steps
    // pipe a rendered manifest into kubectl, and without pipefail a renderer that
    // refused to emit anything would still be reported as a successful apply.
    const parts = ['set -eo pipefail'];
    if (sourceCmds) parts.push(sourceCmds);
    // EXPORTED, not prefixed onto the command. A `NAME=value cmd` prefix binds only to
    // the first command in an `&&` chain, and these steps chain several — and
    // build/render-manifest.py reads its substitutions from the ENVIRONMENT, so a prefix
    // that stopped at `aws eks update-kubeconfig` would leave every placeholder unset.
    parts.push(`export ${envAssignments}`);
    parts.push(phase.run);
    return wrapInBash(parts.join(' && '), `postDeployStep(${phase.name})`);
  };

  // ── Phase 0 + 1 are identical in both modes ───────────────────────────────
  // Phase 0: compute the run-scoped S3 prefix ONCE and write it to a file every
  // other step reads. Respects a caller-supplied ASSETS_PREFIX; falls back to
  // $PROJECT_NAME/$(UTC timestamp)/. Computing it once (vs a task-env $(...)
  // substitution) avoids projen re-evaluating the timestamp per spawn.
  const phase0and1: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] = [
    { say: 'Phase 0: setting ASSETS_PREFIX' },
    {
      // The ${VAR:-default} form runs inside `bash -c` because projen's built-in
      // dax shell expands only plain $VAR and passes braced forms through literally.
      exec: `mkdir -p dist && bash -c 'printf "%s" "\${ASSETS_PREFIX:-${project.name}/$(date -u +%Y-%m-%dT%H-%M-%SZ)/}" > dist/assets_prefix'`,
    },
    {
      // ENSURE the FIS service-linked role exists — ACCOUNT plumbing, deploy-time.
      //
      // On the FIRST fis:StartExperiment in an account, FIS creates
      // AWSServiceRoleForFIS using the CALLER's iam:CreateServiceLinkedRole. The
      // cockpit role's permissions boundary explicitly denies iam:Create* (the
      // escalation control — correct, and it stays), so without this step the very
      // first cockpit-triggered experiment fails with AccessDenied naming the
      // boundary. Found live 2026-09-01. NOT a CloudFormation resource on purpose:
      // AWS::IAM::ServiceLinkedRole CREATE fails when the role already exists, and
      // the role is account-scoped, not stack-owned. Idempotent here instead:
      // tolerate ONLY the has-been-taken error, stay loud on everything else.
      //
      // CHECK BEFORE CREATE, AND NEVER FAIL THE DEPLOY ON A PERMISSIONS GAP.
      // e2e iteration 3 (2026-09-15) failed here with AccessDenied on
      // iam:CreateServiceLinkedRole while the role had existed in the account
      // since April: a least-privilege deployer may lack the grant, and the create
      // call is denied BEFORE the service can report "has been taken". iam:GetRole
      // is tried first (a read); the create only when the role is absent. An
      // AccessDenied on EITHER is a WARNING, not a failure: nothing in the deploy
      // rail depends on this role -- only the first cockpit-fired FIS experiment
      // does, and that path reports its own AccessDenied at the time. Any other
      // error still aborts. docs/iam/github-actions-role-policy.json grants both
      // actions scoped to the FIS SLR ARN so the step is quiet with the full policy.
      exec:
        'bash -c \'if aws iam get-role --role-name AWSServiceRoleForFIS >/dev/null 2>&1; then echo "FIS service-linked role already exists"; ' +
        'else ERR=$(aws iam create-service-linked-role --aws-service-name fis.amazonaws.com 2>&1) ' +
        '&& echo "FIS service-linked role created" ' +
        '|| { echo "$ERR" | grep -q "has been taken" && echo "FIS service-linked role already exists" ' +
        '|| { echo "$ERR" | grep -q "AccessDenied" && echo "WARNING: deployer lacks iam:GetRole/iam:CreateServiceLinkedRole for AWSServiceRoleForFIS; continuing (first FIS experiment will fail if the role is absent)" ' +
        '|| { echo "$ERR" >&2; exit 1; }; }; }; fi\'',
    },
    { say: 'Phase 1: publishing assets' },
    { spawn: 'deploy:upload' },
  ];

  const multiRegion = (regions?.length ?? 0) >= 2;

  if (!multiRegion) {
    // ── SINGLE-REGION (default green baseline — UNCHANGED) ───────────────────
    // createDeployTasks(project) with no regions arg (or < 2) produces exactly the
    // original Phase 0/1/2 that deploys the one $PROJECT_NAME-demo stack. No peering.
    project.addTask('deploy', {
      description: 'Publish assets and create/update every CFN stack end-to-end.',
      requiredEnv: ['ASSETS_BUCKET_PREFIX', 'AWS_REGION'],
      env: {
        // ASSETS_PREFIX comes from dist/assets_prefix, written by Phase 0. The
        // `2>/dev/null || true` guard keeps projen quiet when it evaluates this on
        // the OUTER task before Phase 0 created the file; by the time any subtask
        // spawns and re-evaluates, the file exists and the real prefix is read.
        ASSETS_PREFIX: '$(cat dist/assets_prefix 2>/dev/null || true)',
        // Default threaded into the stub stack's VpcCidr CfnParameter. Overrides
        // pass through from the caller env.
        VPC_CIDR: '10.0.0.0/16',
      },
      steps: [
        ...phase0and1,
        // Phase 2: deploy the single always-on demo stack. No sourceFiles — it is
        // the first (and only) node of the thread. VpcCidr is threaded from the
        // VPC_CIDR env; AllowedCidr is left at its construct default (deny-all),
        // rotated via the CFN console without redeploy.
        { say: 'Phase 2: deploying the demo stack' },
        {
          exec: deployStackStep({
            env: {
              AWS_REGION: '$AWS_REGION',
              ASSETS_BUCKET: '$ASSETS_BUCKET_PREFIX-$AWS_REGION',
              STACK_NAME: '$PROJECT_NAME-demo',
              TEMPLATE_NAME: '$PROJECT_NAME-demo',
              OUTPUTS_PREFIX: 'DEMO',
              STACK_PARAMETERS: ['VpcCidr=$VPC_CIDR'].join('\n'),
            },
          }),
        },
      ],
    });
    return;
  }

  // ── MULTI-REGION (opt-in: regions.length >= 2) ─────────────────────────────
  // Build the per-region region-stack steps + the conditional peering phase by
  // looping over `regions` (networking-changeset §3.2/§6). AWS_REGION is NOT in
  // requiredEnv here — regions are derived from the config; each step sets its own
  // AWS_REGION inline. ASSETS_BUCKET_PREFIX is still required (the per-region bucket
  // is `<prefix>-<region>`).
  const cidrEnv: Record<string, string> = {};
  regions!.forEach((r, i) => {
    // Per-region CIDR with an env override (REGION_<i>_VPC_CIDR), defaulting to the
    // configured cidr. Projen shell-evaluates only `$(...)` env values (and its dax
    // shell doesn't expand braced ${VAR:-default} forms), so the default is resolved
    // through a `$(bash -c ...)` evaluation at task startup.
    cidrEnv[`REGION_${i}_VPC_CIDR`] = `$(bash -c 'echo "\${REGION_${i}_VPC_CIDR:-${r.cidr}}"')`;
  });

  // dist/<stack>.env files written by each region's deploy-stack.sh, in REGIONS
  // order, sourced by the peering phase. $PROJECT_NAME expands at deploy time.
  const regionDotenvs = regions!.map(
    (r) => `dist/$PROJECT_NAME-region-${r.name}.env`,
  );

  // Per-peer CfnParameters threaded into the peering stack from the dotenvs. The
  // keys (REGION_<i>_VPCID etc.) are what deploy-stack.sh uppercases+prefixes from
  // the RegionStack CfnOutputs, matching the PeeringStack's
  // R<i>{Region,VpcId,VpcCidr,RouteTableIds} param slots (§4.3).
  //
  // NOTE the CIDR asymmetry, and do not "tidy" it: RegionStack already uses the
  // construct id `VpcCidr` for its deploy-time CfnParameter, so its CIDR OUTPUT had
  // to be `VpcCidrOut` (CDK construct ids are unique per scope) -> the dotenv key is
  // REGION_<i>_VPCCIDROUT, not REGION_<i>_VPCCIDR. Referencing the shorter name
  // yields an UNSET shell variable, which expands to an empty string and reaches
  // ec2:CreateRoute as `destination-cidr-block: ` -- an InvalidParameterValue that
  // rolls the peering stack back. Live-proven 2026-08-26 (8th template gap); the
  // consumed-vs-produced audit test pins every key in this list against the
  // synthesized templates.
  const peeringParams = regions!
    .map((_, i) =>
      [
        `R${i}Region=$REGION_${i}_REGION`,
        `R${i}VpcId=$REGION_${i}_VPCID`,
        `R${i}VpcCidr=$REGION_${i}_VPCCIDROUT`,
        `R${i}RouteTableIds=$REGION_${i}_ROUTETABLEIDS`,
      ].join('\n'),
    )
    .join('\n');

  // Phase 2.<i>: one region stack per REGIONS entry. Each writes
  // dist/$PROJECT_NAME-region-<name>.env with REGION_<i>_{VPCID,VPCCIDROUT,
  // ROUTETABLEIDS,REGION}. Region stacks are mutually independent (deployed in
  // REGIONS order for simplicity; OUTPUTS_PREFIX keeps the dotenvs collision-free).
  const regionSteps: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] =
    regions!.flatMap((r, i) => {
      const params = [`VpcCidr=$REGION_${i}_VPC_CIDR`];
      // When the regions are peered, each stack needs the OTHER regions' CIDRs so it can
      // admit cross-region client traffic. Threaded from the same REGION_<j>_VPC_CIDR env
      // the sibling stack is deployed with, rather than left to a compile-time default:
      // otherwise a deploy-time CIDR override silently desynchronises the two, and the
      // symptom is cross-region requests timing out with every other layer green.
      //
      // Available for the FIRST region even though the second has not deployed yet,
      // because these come from task env computed up front, not from stack outputs.
      if ((loadGenOpts.peering ?? true) && regions!.length >= 2) {
        const peers = regions!
          .map((_, j) => j)
          .filter((j) => j !== i)
          .map((j) => `$REGION_${j}_VPC_CIDR`)
          .join(',');
        params.push(`PeerVpcCidrs=${peers}`);
      }
      return [
        { say: `Phase 2.${i}: deploying region stack ${r.name}` },
        {
          exec: deployStackStep({
            env: {
              AWS_REGION: r.name,
              ASSETS_BUCKET: `$ASSETS_BUCKET_PREFIX-${r.name}`,
              STACK_NAME: `$PROJECT_NAME-region-${r.name}`,
              TEMPLATE_NAME: `$PROJECT_NAME-region-${r.name}`,
              OUTPUTS_PREFIX: `REGION_${i}`,
              STACK_PARAMETERS: params.join('\n'),
            },
          }),
        },
      ];
    });

  // Phase 3: peering. Reached when multiRegion === true (regions >= 2) AND the caller
  // has not opted out. Region count alone is NOT sufficient justification to emit it —
  // see DeployTaskOptions.peering. The peering stack deploys into the FIRST region; its
  // Lambda reaches the rest via regional boto3 clients. It sources every region dotenv
  // so the R<i>* params expand from REGION_<i>_*.
  const wantPeering = loadGenOpts.peering ?? true;
  const peeringSteps: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] =
    wantPeering
      ? [
        { say: 'Phase 3: deploying the peering stack (cross-region mesh)' },
        {
          exec: deployStackStep({
            sourceFiles: regionDotenvs,
            env: {
              AWS_REGION: regions![0].name,
              ASSETS_BUCKET: `$ASSETS_BUCKET_PREFIX-${regions![0].name}`,
              STACK_NAME: '$PROJECT_NAME-peering',
              TEMPLATE_NAME: '$PROJECT_NAME-peering',
              OUTPUTS_PREFIX: 'PEERING',
              STACK_PARAMETERS: peeringParams,
            },
          }),
        },
      ]
      : [];

  // Singleton phases: one entry per stack that exists once for the demo rather than
  // once per region. Emitted in declaration order, after every region stack, each
  // sourcing the dotenvs of the stacks it depends on. This is the path that exercises
  // the dotenv → CfnParameter thread, and therefore the `bash -c` wrapper in
  // deployStackStep — see the long comment there for why `set -a` cannot be used.
  //
  // Shared with `postDeployStacks` (Phase 6), which differs only in position.
  const singletonStep = (
    s: SingletonStackPhase,
  ): NonNullable<NonNullable<Parameters<typeof project.addTask>[1]>['steps']> => [
    {
      exec: deployStackStep({
        sourceFiles: (s.sourceSuffixes ?? []).map((dep) =>
          // Plain paths (a post-deploy step's own dotenv) pass through; suffixes map
          // to the stack dotenv convention — mirroring PostDeployPhase.sourceFiles.
          dep.includes('/') ? dep : `dist/$PROJECT_NAME-${dep}.env`,
        ),
        env: {
          AWS_REGION: s.region,
          ASSETS_BUCKET: `$ASSETS_BUCKET_PREFIX-${s.region}`,
          STACK_NAME: `$PROJECT_NAME-${s.suffix}`,
          TEMPLATE_NAME: `$PROJECT_NAME-${s.suffix}`,
          ...(s.outputsPrefix ? { OUTPUTS_PREFIX: s.outputsPrefix } : {}),
          ...(s.stackParameters
            ? {
              STACK_PARAMETERS: Object.entries(s.stackParameters)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n'),
            }
            : {}),
        },
      }),
    },
  ];

  const singletonSteps: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] =
    (loadGenOpts.singletons ?? []).flatMap((s, i) => [
      { say: `Phase 4.${i}: deploying ${s.suffix} into ${s.region}` },
      ...singletonStep(s),
    ]);

  // Post-deploy phases: work CloudFormation cannot express — reading an attribute no
  // resource exposes, and installing Kubernetes objects the cluster's API server owns.
  const postDeploySteps: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] =
    (loadGenOpts.postDeploy ?? []).flatMap((p, i) => [
      { say: `Phase 5.${i}: ${p.name} (${p.region})` },
      { exec: postDeployStep(p) },
    ]);

  // Phase 6: stacks whose parameters only exist after post-deploy work — see
  // DeployTaskOptions.postDeployStacks. Same builder as Phase 4, later position.
  const postDeployStackSteps: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] =
    (loadGenOpts.postDeployStacks ?? []).flatMap((s, i) => [
      { say: `Phase 6.${i}: deploying ${s.suffix} into ${s.region}` },
      ...singletonStep(s),
    ]);

  // Phase 7: work gated on the postDeployStacks having deployed — see
  // DeployTaskOptions.finalSteps. Same builder as Phase 5, later position.
  const finalStepEntries: NonNullable<Parameters<typeof project.addTask>[1]>['steps'] =
    (loadGenOpts.finalSteps ?? []).flatMap((p, i) => [
      { say: `Phase 7.${i}: ${p.name} (${p.region})` },
      { exec: postDeployStep(p) },
    ]);

  project.addTask('deploy', {
    description: wantPeering
      ? 'Publish assets, deploy every region stack, then the peering stack.'
      : 'Publish assets, then deploy every region stack and any singleton stacks.',
    requiredEnv: ['ASSETS_BUCKET_PREFIX'],
    env: {
      ASSETS_PREFIX: '$(cat dist/assets_prefix 2>/dev/null || true)',
      ...cidrEnv,
    },
    steps: [
      ...phase0and1,
      ...regionSteps,
      ...peeringSteps,
      ...singletonSteps,
      ...postDeploySteps,
      ...postDeployStackSteps,
      ...finalStepEntries,
    ],
  });
}
