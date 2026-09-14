import type { awscdk } from 'projen';

/**
 * Top-level CDK stack-name suffixes the green skeleton packages.
 *
 * The stub `app.ts` (skeleton/_shared/src/cdk/app.ts) synthesizes a single stack
 * named `$PROJECT_NAME-demo`, so the baseline iterates `['demo']`. The recipe
 * documents extending this list as PDD adds stacks (e.g. the the predecessor project shape was
 * `['application','client','edge','peering','dashboard','database']`).
 *
 * `$PROJECT_NAME` is set globally via
 * `project.tasks.addEnvironment('PROJECT_NAME', project.name)` in .projenrc.ts.
 */
const DEFAULT_STACK_SUFFIXES = ['demo'];

/**
 * Provider-AGNOSTIC build lifecycle for the green CRE demo skeleton.
 *
 * Lives once in `skeleton/_shared/projenrc/tasks/` and is copied verbatim into BOTH
 * the CI-provider trees at scaffold time. CI in both families only ever invokes
 * the projen tasks registered here (`npx projen <task>`) — this is the PROJEN_PATTERN
 * "CI ↔ task parity" principle that keeps the CI-provider seam narrow.
 *
 * Ported (generalized) from the predecessor project-app/projenrc/tasks/build-tasks.ts. The green
 * skeleton baseline is the THIN, NON-DOCKER half of that lifecycle:
 *
 *   preCompileTask   → wipe assets/ + cdk.out/ so downstream phases start clean
 *   compileTask      → tsc (projen-native, unchanged)
 *   postCompileTask  → projen-native `synth:silent` runs `cdk synth` (NO docker steps)
 *   testTask         → jest + eslint (projen-native, unchanged)
 *   packageTask      → stage CFN assets (package:assets) → zip into dist/content.zip
 *
 * Result: one `yarn build` (or `npx projen build`) produces `dist/content.zip`
 * carrying the CFN template + staged file assets the deploy mechanism consumes.
 *
 * CONTAINER / LOAD-GEN STEPS ARE DELIBERATELY ABSENT. The kaniko/crane container
 * build (`build:container-plan`, `build:docker`) and its CI aliases are gated behind
 * an `enableLoadGen` flag that M7 (load-generation) adds. Emitting container jobs in
 * the green skeleton would require a Dockerfile + DockerImageAsset that does not exist
 * yet, breaking the zero-edit green guarantee (NFR1). They stay OFF here.
 */
/**
 * Options for {@link createBuildTasks}.
 *
 * `enableLoadGen` is the single toggle (changeset §4a) gating the container-build
 * lifecycle. When false (the green skeleton default), NO docker tasks are registered
 * and NO docker steps attach to postCompile — the skeleton emits zero container work
 * and stays green with zero edits (NFR1). The provider workflow factories receive the
 * SAME flag so CI jobs and lifecycle tasks light up together — never one without the
 * other (the failure mode where a job is emitted with no asset, or vice-versa).
 *
 * `containerBuild` selects HOW the ONE DockerImageAsset is built (changeset §4c/§4d).
 * This is the CI-provider seam, since the two providers build the SAME asset
 * differently:
 *   - `'kaniko'` (CI): register `build:container-plan` + `build:docker` and attach
 *     them to postCompile. `build:docker` shells out to `build/build-docker.sh` (kaniko;
 *     the CI runners block DinD). Requires the `build/*.sh` scripts to be vendored.
 *   - `'cdk-assets'` (GitHub): register NOTHING in the build lifecycle. GitHub-hosted
 *     runners allow Docker-in-daemon, so CDK's native `cdk-assets publish` (in the deploy
 *     workflow, §4d) builds+pushes the image. The `build/*.sh` scripts are NOT vendored on
 *     the GitHub path (§5d), so attaching `build:docker` here would break `projen build`.
 * Ignored when `enableLoadGen` is false. Defaults to `'kaniko'` ((the kaniko path)).
 */
export interface BuildTaskOptions {
  readonly enableLoadGen?: boolean;
  readonly containerBuild?: 'kaniko' | 'cdk-assets';
  /**
   * Every deployable stack suffix; packaging runs once per entry as
   * `build/package.py $PROJECT_NAME-<suffix>`.
   *
   * Defaults to the green baseline `['demo']`. A multi-stack demo MUST pass the list
   * DERIVED from its region array (see `src/cdk/regions.ts` `STACK_SUFFIXES`) rather
   * than a hand-written one: the deploy factory names multi-region stacks
   * `$PROJECT_NAME-region-${r.name}`, so a hand-written short form packages one name
   * and deploys another. `cdk synth` and `yarn build` both stay green and the DEPLOY
   * fails on a stack nobody packaged.
   */
  readonly stackSuffixes?: readonly string[];
}

export function createBuildTasks(
  project: awscdk.AwsCdkTypeScriptApp,
  opts: BuildTaskOptions = {},
): void {
  // --- granular tasks (also wired into the lifecycle below) ----------------

  // For each top-level stack, build/package.py:
  //   1. Rewrites nested templates that reference ${AssetsBucket*} to accept
  //      them as parameters, piping the parent's params through.
  //   2. Copies every file asset into assets/<hash>.<ext> (zipping directories).
  //   3. Copies the top-level template to assets/<stack_name>.json so the deploy
  //      task can target it by name via --template-url.
  //
  // Does NOT wipe assets/ — preCompile handles that once per build so postCompile
  // phases can share the folder.
  const packageAssets = project.addTask('package:assets', {
    description: "Stage every stack's assets into assets/ and rewrite nested templates",
    steps: [
      { exec: 'chmod +x build/package.py' },
      ...(opts.stackSuffixes ?? DEFAULT_STACK_SUFFIXES).map((suffix) => ({
        // $PROJECT_NAME (no braces): projen's built-in dax shell expands $VAR
        // but passes the braced ${VAR} form through literally.
        exec: `build/package.py \$PROJECT_NAME-${suffix} .`,
      })),
    ],
  });

  const packageContent = project.addTask('package:content', {
    description: 'Build dist/content.zip — the artifact the deploy stage consumes',
    steps: [
      { exec: 'rm -f dist/content.zip' },
      { exec: 'mkdir -p dist && cd assets && zip -r ../dist/content.zip .' },
    ],
  });

  // CI build entry point — the single composite task BOTH providers' build jobs
  // invoke (GitHub `build.yml`'s build step; CI `build:cdk`). Named so a
  // workflow `needs:`/job graph can reference it directly. Runs the non-docker
  // half of projen's lifecycle so the build job needs only a plain node image:
  // wipe assets/ + cdk.out/, compile, synth, lint + unit test (projen's `test`
  // task spawns both jest and eslint), then stage CFN assets into assets/.
  project.addTask('ci:build:cdk', {
    description: 'CI: CDK synthesis + tests + asset staging (provider build-job entry point)',
    steps: [
      // Wipe assets/ + cdk.out/ because `cdk synth` doesn't prune stale
      // *.assets.json files from renamed/removed stacks, and package:assets
      // expects a clean assets/ tree. dist/ is NOT wiped — it carries state
      // between lifecycle phases (dist/assets_prefix, dist/<stack>.env dotenvs,
      // dist/<stack>.params.json). `mkdir -p dist` is defensive.
      { exec: 'rm -rf assets cdk.out && mkdir -p assets dist' },
      { spawn: 'compile' },
      { spawn: 'synth:silent' },
      // cfn-lint the SYNTHESIZED templates. This must be here and not only on
      // postCompile: CI does not run `projen build`, it runs THIS task, so a gate wired
      // only into postCompile never executes in CI at all (discovered 2026-08-31, after
      // a template defect reached a live deploy). Placed straight after synth so it fails
      // before the slower test + asset-staging steps. The CI build job installs
      // cfn-lint and sets CFN_LINT_REQUIRED=1, making its absence fatal there; locally,
      // a missing cfn-lint only warns.
      { spawn: 'lint:templates' },
      { spawn: 'test' },
      { spawn: 'package:assets' },
    ],
  });

  // CI package entry point — zips the staged assets/ tree into dist/content.zip.
  // Kept as a named `ci:build:*` alias (rather than the job calling
  // `yarn package:content` directly) so all build-stage CI entry points share
  // the namespace and the provider workflow's job→task mapping stays trivial.
  project.addTask('ci:build:package', {
    description: 'CI: zip assets/ into dist/content.zip (provider package-job entry point)',
    steps: [{ spawn: 'package:content' }],
  });

  // --- synthesized-template lint (cfn-lint) --------------------------------
  //
  // Runs on postCompile immediately after projen-native `synth:silent`, and BEFORE the
  // container steps so a bad template fails in seconds rather than after a docker build.
  //
  // `cdk synth` validates the CDK object graph, not the emitted template, and some
  // template errors are only rejected by CloudFormation at CreateChangeSet -- mid deploy.
  // On 2026-08-31 three such defects reached a live deploy behind a green synth, incl. a
  // `CfnCondition` referencing a resource (illegal; cfn-lint flags it E8003) and a nested
  // `Fn::GetAtt` path outside readOnlyProperties. See docs/lessons.md #17 and #19.
  //
  // Not gated behind a flag: it is provider-agnostic, needs no credentials, and every
  // demo built on this template synthesizes CloudFormation. build/lint-templates.sh skips
  // with a loud warning when cfn-lint is absent (so a CI image without it cannot break
  // the build) and hard-fails on zero templates or on a lint that checked nothing.
  const lintTemplates = project.addTask('lint:templates', {
    description: 'cfn-lint the synthesized CloudFormation templates in cdk.out/',
    steps: [{ exec: 'bash build/lint-templates.sh' }],
  });
  project.postCompileTask.spawn(lintTemplates);

  // --- load-gen container tasks (gated; changeset §4b) ---------------------
  //
  // Registered ONLY when enableLoadGen is true. These are the provider-agnostic
  // task layer behind both providers' container jobs:
  //   build:container-plan  reads cdk.out/*.assets.json (the one DockerImageAsset the
  //                         LoadGenerator declares) → assets/containers/manifest.json
  //                         + dist/container-plan.tsv (build/container-plan.sh).
  //   build:docker          builds each image into assets/containers/<hash>.tar.gz via
  //                         kaniko (build/build-docker.sh; POSIX sh, no python).
  //   ci:build:container-plan  composite alias the CI container-plan job calls.
  // postCompile ordering matters: plan THEN build (build reads the .tsv the plan wrote).
  // build/*.sh are carried verbatim from the predecessor project into a demo's build/ on pull-in;
  // the green skeleton ships none, which is why these tasks must never register when
  // the flag is off (NFR1 — a build:docker that runs with no Dockerfile breaks green).
  if (opts.enableLoadGen && (opts.containerBuild ?? 'kaniko') === 'kaniko') {
    const buildContainerPlan = project.addTask('build:container-plan', {
      description: 'Enumerate DockerImageAssets into manifest.json + container-plan.tsv',
      steps: [{ exec: 'bash build/container-plan.sh' }],
    });
    const buildDocker = project.addTask('build:docker', {
      description: 'Build every DockerImageAsset into assets/containers/ (kaniko)',
      steps: [{ exec: 'sh build/build-docker.sh' }],
    });
    project.addTask('ci:build:container-plan', {
      description: 'CI: produce manifest.json + container-plan.tsv (container-plan job entry point)',
      steps: [{ spawn: 'build:container-plan' }],
    });
    // postCompile: synth:silent (projen-native) already ran cdk synth above; now plan
    // the containers, then build them. Local `npx projen build` builds the image via
    // build-docker.sh's docker-wrapped kaniko fallback when a docker daemon is present.
    project.postCompileTask.spawn(buildContainerPlan);
    project.postCompileTask.spawn(buildDocker);
  }

  // --- lifecycle wiring ----------------------------------------------------

  // preCompile: clean slate. Downstream phases share assets/ and cdk.out/, so
  // wipe both once here rather than at the start of every individual task.
  // Wiping cdk.out/ matters because `cdk synth` doesn't prune files from stacks
  // that have been renamed or removed. dist/ is NOT wiped (it carries cross-phase
  // state); `mkdir -p dist` just ensures it exists for package:content to write.
  project.preCompileTask.exec('rm -rf assets cdk.out && mkdir -p assets dist');

  // postCompile: projen-native `synth:silent` (added by AwsCdkTypeScriptApp)
  // already runs `cdk synth` here. The green skeleton attaches NO docker steps —
  // container build is gated behind enableLoadGen (M7).

  // package: stage CFN assets, then zip the whole assets/ tree. Gotcha 8 —
  // reset() before re-authoring the native `package` task so we replace projen's
  // default rather than appending to it. package:assets runs here (not earlier)
  // because rewriting templates for the ${AssetsBucket*} params is a packaging
  // concern, not a compile concern.
  project.packageTask.reset();
  project.packageTask.description = 'Stage CFN assets and zip into dist/content.zip';
  project.packageTask.spawn(packageAssets);
  project.packageTask.spawn(packageContent);
}
