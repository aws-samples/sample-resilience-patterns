/**
 * Root projen configuration for sample-resilience-patterns monorepo.
 *
 * This is a maintainer-only file. Customers consuming the samples never run
 * projen — they use `npm ci && npx cdk deploy` from inside a subdirectory.
 *
 * What this file generates:
 *   - .github/workflows/*.yml   (build, e2e, cleanup per pattern; Dependabot automation)
 *   - .github/dependabot.yml, .github/CODEOWNERS
 *   - aurora/package.json, cdk.json, tsconfig.json, .projen/  (CDK subproject scaffolding)
 *   - s3mrap-crr/package.json, cdk.json, tsconfig.json, .projen/  (CDK subproject scaffolding)
 *
 * What this file does NOT touch:
 *   - aurora/{bin,lib,src,test,lambda}/**  — the actual sample code
 *   - s3mrap-crr/{bin,lib,src,test,lambda}/**  — the actual sample code
 *   - aurora/cleanup.sh, s3mrap-crr/cleanup.sh
 *   - aurora/README.md, s3mrap-crr/README.md, /README.md
 *
 * To regenerate scaffolding after changes here:  npx projen
 */
import { typescript, awscdk, javascript, github, TextFile, YamlFile } from 'projen';

// ---------------------------------------------------------------------------
// Root project: holds the workflows and is the parent of the two subprojects.
// It does NOT have its own build/test/release — its only job is generating
// the per-pattern subprojects and the root .github/ directory.
// ---------------------------------------------------------------------------
const root = new typescript.TypeScriptProject({
  name: 'sample-resilience-patterns-root',
  description: 'Root projen project for the sample-resilience-patterns monorepo (maintainer tooling only)',
  defaultReleaseBranch: 'main',
  projenrcTs: true,
  packageManager: javascript.NodePackageManager.NPM,
  // Repo has its own hand-managed root LICENSE (MIT). Don't let projen own it.
  licensed: false,

  // We are a meta-project: nothing to build, lint, test, release, or package.
  jest: false,
  eslint: false,
  prettier: false,
  sampleCode: false,
  buildWorkflow: false,
  release: false,
  depsUpgrade: false,
  pullRequestTemplate: false,

  // GitHub support is enabled so we can attach workflows; everything else off.
  github: true,
  githubOptions: {
    mergify: false,
    pullRequestLint: false,
  },

  gitignore: [
    '.idea/',
    'cdk.out.*/',
    '/temporary/',
    'coverage/',
    'test-reports/',
  ],
});

// licensed:false on root sets "license": "UNLICENSED" in the root package.json.
// Override to MIT to match the repo's root LICENSE file.
root.package.addField('license', 'MIT');

// ---------------------------------------------------------------------------
// Per-pattern configuration. Adding a new pattern = add an entry here +
// create the directory with bin/lib/src/test/lambda + cleanup.sh + README.md.
// ---------------------------------------------------------------------------
interface Pattern {
  /** Subdirectory name and CDK app name. */
  outdir: string;
  /**
   * When true, the pattern carries its OWN .projenrc.ts (its own package manager, CDK
   * version, deploy rail) and the root generates only the three workflows and the
   * dependabot entry -- NOT the subproject scaffolding. Two projen owners of one
   * package.json would fight each other on every `npx projen`. Default false.
   */
  selfManaged?: boolean;
  /** GitHub Actions OIDC role ARN (per-pattern least-privilege). */
  e2eRoleArn: string;
  /** Primary AWS region for credential configuration. */
  awsRegion: string;
  /** Steps for the build workflow's job. Pattern-specific. */
  buildSteps: github.workflows.JobStep[];
  /** Steps for the e2e workflow's job. Pattern-specific. */
  e2eSteps: github.workflows.JobStep[];
  /** Steps for the cleanup workflow's job. Pattern-specific. */
  cleanupSteps: github.workflows.JobStep[];
  /** Optional timeout-minutes for the e2e job (defaults to 360). */
  e2eTimeoutMinutes?: number;
  /** Optional timeout-minutes for the cleanup job (defaults to 60). */
  cleanupTimeoutMinutes?: number;
  /** Optional env block applied to the e2e workflow. */
  e2eEnv?: Record<string, string>;
  /**
   * Runner label for all three jobs. Default 'ubuntu-latest'. eks-multi-region needs an
   * arm64 runner: its container images are Graviton-only and kaniko cannot cross-build.
   */
  runsOn?: string;
}

// Common CDK app config — shared across all patterns.
const SHARED_CDK_CONFIG = {
  cdkVersion: '2.200.0',
  defaultReleaseBranch: 'main',
  projenrcTs: true,
  packageManager: javascript.NodePackageManager.NPM,
  // The repo's root LICENSE applies to all subprojects; don't generate per-dir.
  licensed: false,
  deps: ['cdk-nag'],
  appEntrypoint: 'bin/app.ts',
  testdir: 'test',
  srcdir: '.',
  libdir: '.',
  // Workflows live at repo root, not per-subproject.
  github: false,
  eslint: false,
  prettier: false,
  sampleCode: false,
  tsconfig: { compilerOptions: { rootDir: '.' } },
  context: { '@aws-cdk/core:target-partitions': ['aws'] },
  gitignore: ['cdk.out.*/', '/temporary/'],
};

const E2E_ACCOUNT = '563688183446';

const patterns: Pattern[] = [
  // -------------------------------------------------------------------------
  // aurora — Aurora Global Database multi-region resilience demo.
  // -------------------------------------------------------------------------
  {
    outdir: 'aurora',
    e2eRoleArn: `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-aurora`,
    awsRegion: 'us-east-1',
    buildSteps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '20' } },
      { run: 'npm ci' },
      { run: 'npx projen test' },
      { run: 'npx cdk synth -c stack=bootstrap' },
    ],
    cleanupSteps: [
      { uses: 'actions/checkout@v6' },
      {
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-aurora`,
          'aws-region': 'us-east-1',
        },
      },
      { run: './cleanup.sh' },
    ],
    e2eSteps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '20' } },
      {
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-aurora`,
          'aws-region': 'us-east-1',
          'role-duration-seconds': 7200,
        },
      },
      { run: 'npm ci' },
      { run: 'npx projen test' },
      {
        // Unique per-run stack names (like the microservice repo's ENV suffix):
        // prevents fixed-name collisions when a prior run's teardown was
        // interrupted or failed. Sha passed via env to avoid script injection.
        name: 'Set sha-suffixed project name',
        env: { HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}' },
        run: 'echo "PROJECT=aurora-$(echo $HEAD_SHA | cut -c1-6)" >> $GITHUB_ENV',
      },
      {
        name: 'Pre-flight cleanup (idempotent)',
        run: 'chmod +x cleanup.sh && ./cleanup.sh || true',
      },
      {
        name: 'Get account ID',
        id: 'account',
        run: 'echo "id=$(aws sts get-caller-identity --query Account --output text)" >> $GITHUB_OUTPUT',
      },
      {
        name: 'Deploy via bootstrap',
        run: [
          'ACCOUNT_ID=${{ steps.account.outputs.id }}',
          'npx cdk deploy $PROJECT-bootstrap \\',
          '  -c stack=bootstrap -c project=$PROJECT -c primaryRegion=us-east-1 -c secondaryRegion=us-west-2 \\',
          '  -c accountId=$ACCOUNT_ID --require-approval never',
        ].join('\n'),
      },
      {
        name: 'Verify canaries',
        run: [
          'echo "Waiting for canaries to run..."',
          'sleep 360',
          'for canary in $PROJECT-rdl-e1 $PROJECT-wrl-e1; do',
          '  aws synthetics get-canary-runs --name $canary --region us-east-1 --query \'CanaryRuns[0].Status.State\' --output text || true',
          'done',
        ].join('\n'),
      },
      {
        name: 'Refresh AWS credentials (pre-failover)',
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-aurora`,
          'aws-region': 'us-east-1',
          'role-duration-seconds': 7200,
        },
      },
      {
        name: 'Load test + failover exercise',
        run: [
          'ACCOUNT_ID=${{ steps.account.outputs.id }}',
          'PLAN_ARN=$(aws cloudformation describe-stacks --stack-name $PROJECT-failover-plan --region us-east-1 \\',
          '  --query "Stacks[0].Outputs[?OutputKey==\'PlanArn\'].OutputValue" --output text)',
          'SSM_DOC=$(aws cloudformation describe-stack-resources --stack-name $PROJECT-loadgen --region us-east-1 \\',
          '  --query "StackResources[?ResourceType==\'AWS::SSM::Document\'].PhysicalResourceId" --output text)',
          '',
          'wait_for_plan() {',
          '  echo "  Waiting for plan execution to complete..."',
          '  for i in $(seq 1 30); do',
          '    STATUS=$(aws arc-region-switch list-plan-executions --plan-arn "$PLAN_ARN" --region us-east-1 \\',
          '      --query "items[?executionId==\'$1\'].executionState" --output text 2>/dev/null || echo "UNKNOWN")',
          '    echo "  [$i] status=$STATUS"',
          '    if echo "$STATUS" | grep -qi "succeeded\\|failed\\|completed"; then break; fi',
          '    sleep 30',
          '  done',
          '}',
          '',
          'echo "Starting 1-min load test via SSM: $SSM_DOC"',
          'aws ssm start-automation-execution \\',
          '  --document-name "$SSM_DOC" \\',
          '  --parameters \'{"RequestsPerSecond":["10"],"DurationSeconds":["60"],"TargetApp":["aurora"],"OperationMix":["50,20,10,20"]}\' \\',
          '  --region us-east-1 || true',
          '',
          'echo "Running ARC failover exercise..."',
          '',
          'echo "1/4: Deactivate us-east-1"',
          'EXEC_ID=$(aws arc-region-switch start-plan-execution \\',
          '  --plan-arn "$PLAN_ARN" --target-region us-east-1 --action deactivate \\',
          '  --region us-west-2 --query \'executionId\' --output text)',
          'echo "  Execution: $EXEC_ID"',
          'wait_for_plan "$EXEC_ID"',
          '',
          'echo "2/4: Activate us-east-1"',
          'EXEC_ID=$(aws arc-region-switch start-plan-execution \\',
          '  --plan-arn "$PLAN_ARN" --target-region us-east-1 --action activate \\',
          '  --region us-east-1 --query \'executionId\' --output text)',
          'echo "  Execution: $EXEC_ID"',
          'wait_for_plan "$EXEC_ID"',
          '',
          'echo "3/4: Deactivate us-west-2"',
          'EXEC_ID=$(aws arc-region-switch start-plan-execution \\',
          '  --plan-arn "$PLAN_ARN" --target-region us-west-2 --action deactivate \\',
          '  --region us-east-1 --query \'executionId\' --output text)',
          'echo "  Execution: $EXEC_ID"',
          'wait_for_plan "$EXEC_ID"',
          '',
          'echo "4/4: Activate us-west-2"',
          'EXEC_ID=$(aws arc-region-switch start-plan-execution \\',
          '  --plan-arn "$PLAN_ARN" --target-region us-west-2 --action activate \\',
          '  --region us-west-2 --query \'executionId\' --output text)',
          'echo "  Execution: $EXEC_ID"',
          'wait_for_plan "$EXEC_ID"',
          '',
          'echo "Failover exercise complete"',
        ].join('\n'),
      },
      {
        name: 'Refresh AWS credentials (pre-cleanup)',
        if: 'always()',
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-aurora`,
          'aws-region': 'us-east-1',
          'role-duration-seconds': 7200,
        },
      },
      {
        name: 'Cleanup on success',
        if: 'success()',
        run: './cleanup.sh',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // s3mrap-crr — S3 Multi-Region Access Point + Cross-Region Replication demo.
  // -------------------------------------------------------------------------
  {
    outdir: 's3mrap-crr',
    e2eRoleArn: `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-s3mrap-crr`,
    awsRegion: 'us-east-1',
    e2eEnv: { AWS_REGION: 'us-east-1' },
    e2eTimeoutMinutes: 45,
    cleanupTimeoutMinutes: 15,
    buildSteps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '20' } },
      { run: 'npm ci' },
      { run: 'npx projen build' },
    ],
    cleanupSteps: [
      { uses: 'actions/checkout@v6' },
      {
        name: 'Configure AWS credentials',
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-s3mrap-crr`,
          'aws-region': 'us-east-1',
        },
      },
      {
        name: 'Cleanup',
        run: [
          'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
          'chmod +x cleanup.sh',
          './cleanup.sh $ACCOUNT_ID || true',
        ].join('\n'),
      },
    ],
    e2eSteps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '20' } },
      { name: 'Install dependencies', run: 'npm ci' },
      { name: 'Build and test', run: 'npx projen build' },
      {
        name: 'Configure AWS credentials',
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-s3mrap-crr`,
          'aws-region': 'us-east-1',
        },
      },
      {
        // Unique per-run stack names (like the microservice repo's ENV suffix):
        // prevents fixed-name collisions when a prior run's teardown was
        // interrupted or failed. Sha passed via env to avoid script injection.
        name: 'Set sha-suffixed project name',
        env: { HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}' },
        run: 'echo "PROJECT=s3mrap-$(echo $HEAD_SHA | cut -c1-6)" >> $GITHUB_ENV',
      },
      {
        name: 'Pre-flight cleanup (idempotent)',
        run: [
          'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
          'chmod +x cleanup.sh',
          './cleanup.sh $ACCOUNT_ID || true',
        ].join('\n'),
      },
      {
        name: 'Deploy',
        run: [
          'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
          'npx cdk deploy $PROJECT-bootstrap -c project=$PROJECT -c accountId=$ACCOUNT_ID --require-approval never',
        ].join('\n'),
      },
      {
        name: 'Run load test with mid-flight failover',
        run: [
          'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
          '',
          'echo "=== Starting load test (background) ==="',
          'aws lambda invoke \\',
          '  --function-name ${PROJECT}-load-test \\',
          '  --payload \'{"sourceRegion":"us-east-1","destRegion":"us-west-2","objectCount":100,"objectSizeKB":10,"timeoutSeconds":600}\' \\',
          '  --cli-binary-format raw-in-base64-out \\',
          '  --cli-read-timeout 1200 \\',
          '  /tmp/loadtest-result.json &',
          'LOADTEST_PID=$!',
          '',
          'echo "=== Waiting 30s for uploads to start ==="',
          'sleep 30',
          '',
          'echo "=== Triggering failover to us-west-2 ==="',
          'aws lambda invoke \\',
          '  --function-name ${PROJECT}-mrap-routing \\',
          '  --payload \'{}\' \\',
          '  --cli-binary-format raw-in-base64-out \\',
          '  --region us-west-2 \\',
          '  /tmp/failover-result.json',
          '',
          'echo "Failover result:"',
          'cat /tmp/failover-result.json',
          '',
          'echo "=== Waiting for load test to complete ==="',
          'wait $LOADTEST_PID',
          '',
          'echo "=== Load test results ==="',
          'cat /tmp/loadtest-result.json | python3 -m json.tool',
        ].join('\n'),
      },
      {
        name: 'Verify load test results',
        run: [
          "FAILURES=$(python3 -c \"import json; r=json.load(open('/tmp/loadtest-result.json')); print(r.get('replicationFailures', -1))\")",
          "REPLICATED=$(python3 -c \"import json; r=json.load(open('/tmp/loadtest-result.json')); print(r.get('objectsReplicated', 0))\")",
          'echo "Replicated: $REPLICATED, Failures: $FAILURES"',
          'if [ "$FAILURES" != "0" ]; then',
          '  echo "FAIL: replication failures detected"',
          '  exit 1',
          'fi',
          'if [ "$REPLICATED" = "0" ]; then',
          '  echo "FAIL: no objects replicated"',
          '  exit 1',
          'fi',
          'echo "PASS: all objects replicated with zero failures"',
        ].join('\n'),
      },
      {
        name: 'Verify failover result',
        run: [
          "ACTIVE=$(python3 -c \"import json; r=json.load(open('/tmp/failover-result.json')); print(r.get('activeRegion', 'NONE'))\")",
          'echo "Active region: $ACTIVE"',
          'if [ "$ACTIVE" != "us-west-2" ]; then',
          '  echo "FAIL: expected activeRegion=us-west-2, got $ACTIVE"',
          '  exit 1',
          'fi',
          'echo "PASS: failover to us-west-2 succeeded"',
        ].join('\n'),
      },
      {
        name: 'Verify MRAP traffic dial metrics',
        run: [
          'echo "Waiting 2 minutes for monitor Lambda to publish metrics..."',
          'sleep 120',
          'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
          '',
          '# Check us-west-2 should be 100%',
          'DIAL=$(aws cloudwatch get-metric-statistics \\',
          '  --namespace ${PROJECT} \\',
          '  --metric-name MrapTrafficDial \\',
          '  --dimensions Name=Region,Value=us-west-2 \\',
          "  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S) \\",
          '  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \\',
          '  --period 60 --statistics Average \\',
          '  --region us-west-2 \\',
          "  --query 'Datapoints[-1].Average' --output text 2>/dev/null || echo \"NONE\")",
          'echo "us-west-2 traffic dial: $DIAL"',
          'if [ "$DIAL" = "100.0" ]; then',
          '  echo "PASS: us-west-2 is active (100%)"',
          'elif [ "$DIAL" = "NONE" ] || [ "$DIAL" = "None" ]; then',
          '  echo "WARN: no metric data yet (monitor Lambda may not have run)"',
          'else',
          '  echo "WARN: unexpected traffic dial value: $DIAL"',
          'fi',
        ].join('\n'),
      },
      {
        name: 'Verify no alarms firing',
        run: [
          'for REGION in us-east-1 us-west-2; do',
          '  ALARMS=$(aws cloudwatch describe-alarms \\',
          '    --state-value ALARM \\',
          '    --alarm-name-prefix ${PROJECT}- \\',
          '    --region $REGION \\',
          "    --query 'MetricAlarms[].AlarmName' --output text)",
          '  if [ -n "$ALARMS" ]; then',
          '    echo "WARN: alarms in ALARM state in $REGION: $ALARMS"',
          '  else',
          '    echo "PASS: no alarms firing in $REGION"',
          '  fi',
          'done',
        ].join('\n'),
      },
      {
        name: 'Cleanup',
        if: 'success()',
        run: [
          'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
          'chmod +x cleanup.sh',
          './cleanup.sh $ACCOUNT_ID || true',
        ].join('\n'),
      },
    ],
  },

  // -------------------------------------------------------------------------
  // eks-multi-region — multi-region EKS + ARC Region Switch + FIS demo.
  //
  // SELF-MANAGED: it has its own .projenrc.ts (yarn berry, aws-cdk-lib 2.248 for the
  // ARC L1s, a multi-phase deploy rail with an in-VPC CodeBuild installer), so the root
  // emits only its workflows. ARM64 RUNNERS: the app and load-generator images are
  // Graviton-only and kaniko cannot cross-build.
  //
  // The e2e here is a DEPLOY-AND-TEAR-DOWN proof, not the failover exercise the aurora
  // pattern runs: the rail takes ~90 minutes, and ARC's EKS scaling block sizes the
  // standby from a 24-hour replica sample, so a same-run failover would scale nothing
  // and prove nothing (see eks-multi-region/docs/runbook.md). The failover round trip is
  // the operator's `build/arc-switch.sh`, run on day 2.
  // -------------------------------------------------------------------------
  {
    outdir: 'eks-multi-region',
    selfManaged: true,
    runsOn: 'ubuntu-24.04-arm',
    e2eRoleArn: `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-eks-multi-region`,
    awsRegion: 'us-east-2',
    e2eEnv: {
      AWS_REGION: 'us-east-2',
      AWS_DEFAULT_REGION: 'us-east-2',
      // Two-tier permissions, the same shape `cdk deploy` gives the aurora pattern via
      // the cdk-* bootstrap roles: the GitHub role holds only what the workflow's own
      // shell steps call (change-sets, S3, ECR, CodeBuild, EKS describe, SSM, tags) plus
      // iam:PassRole on THIS CloudFormation service role, which holds the broad
      // resource permissions the stacks need. build/deploy-stack.sh passes it as
      // --role-arn on every change-set when set.
      ROLE_ARN: `arn:aws:iam::${E2E_ACCOUNT}:role/eks-multi-region-cfn-exec`,
    },
    e2eTimeoutMinutes: 180,
    cleanupTimeoutMinutes: 60,
    buildSteps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '20' } },
      { uses: 'actions/setup-python@v6', with: { 'python-version': '3.12' } },
      // Pinned so a new cfn-lint rule cannot fail the build unannounced; the gate
      // script FAILS (not skips) when the linter is missing because CFN_LINT_REQUIRED=1.
      { name: 'Install cfn-lint (template lint gate)', run: 'pip install cfn-lint==1.45.0' },
      { name: 'Install app deps (in-image smoke test)', run: 'pip install -r src/app/requirements.txt' },
      { run: 'corepack enable && yarn install --immutable' },
      {
        name: 'CDK synth + cfn-lint + tests + asset staging',
        env: { CFN_LINT_REQUIRED: '1' },
        run: 'yarn ci:build:cdk',
      },
    ],
    cleanupSteps: [
      { uses: 'actions/checkout@v6' },
      {
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-eks-multi-region`,
          'aws-region': 'us-east-2',
          'role-duration-seconds': 28800,
        },
      },
      // ASSETS_BUCKET_PREFIX must match what the e2e used; for a manual run pass it via
      // the workflow_dispatch environment or accept the default prefix.
      { run: 'chmod +x cleanup.sh && ./cleanup.sh' },
    ],
    e2eSteps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '20' } },
      { uses: 'actions/setup-python@v6', with: { 'python-version': '3.12' } },
      { run: 'pip install cfn-lint==1.45.0 && pip install -r src/app/requirements.txt' },
      { run: 'corepack enable && yarn install --immutable' },
      { name: 'Build gate', env: { CFN_LINT_REQUIRED: '1' }, run: 'yarn ci:build:cdk' },
      {
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-eks-multi-region`,
          'aws-region': 'us-east-2',
          // The rail runs ~90 min after mirror + buckets; the other multi-region samples
          // use 8h for the same reason. The role's MaxSessionDuration must allow it.
          'role-duration-seconds': 28800,
        },
      },
      {
        // Unique per-run asset-bucket prefix so two runs cannot collide on S3 keys.
        // The STACK names are fixed (the rail's stack ids are a cross-file contract
        // pinned by tests), so this pattern runs ONE e2e at a time -- the workflow's
        // concurrency group below enforces it.
        name: 'Set sha-suffixed assets prefix',
        env: { HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}' },
        run: 'echo "ASSETS_BUCKET_PREFIX=eks-multi-region-$(echo $HEAD_SHA | cut -c1-6)" >> $GITHUB_ENV',
      },
      {
        name: 'Pre-flight cleanup (idempotent)',
        // No `|| true`: cleanup.sh exits 0 when nothing is left and non-zero when a
        // stack remains. Run 9 tolerated a failed cleanup and then tried to UPDATE a
        // DELETE_FAILED region stack -- a two-hour teardown followed by an instant
        // ValidationError. Stop here instead, with cleanup's own diagnosis in the log.
        run: 'chmod +x cleanup.sh && ./cleanup.sh',
      },
      {
        name: 'Create assets buckets',
        run: 'make buckets',
      },
      {
        // crane does the daemonless registry-to-registry copies: build/mirror-images.sh
        // (third-party images -> private ECR) and build/deploy-docker.sh (the app image).
        // Static Go binary, pinned; arm64 to match the runner. Iteration 1 of the e2e
        // failed at `make mirror` with "crane not found on PATH" -- the internal CI had
        // installed it in a before_script that was not carried into this workflow.
        name: 'Install crane',
        run: [
          'CRANE_VERSION=v0.20.2',
          'curl -fsSL "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_arm64.tar.gz" \\',
          '  | sudo tar -xz -C /usr/local/bin crane',
          'crane version',
        ].join('\n'),
      },
      {
        name: 'Mirror pinned third-party images into this account (no NAT in the node subnets)',
        run: 'make mirror',
      },
      {
        name: 'Deploy the full rail',
        run: 'make deploy',
      },
      {
        // Adopted from sample-multi-region-resilient-microservice-on-aws: a failed e2e
        // must leave a READABLE reason in the job log, not just a red X, because the
        // stacks are gone by the time anyone looks (cleanup runs on success only, but a
        // re-run's pre-flight cleanup deletes them).
        name: 'Capture failure diagnostics',
        if: 'failure()',
        run: [
          'set +e',
          'PROJECT=eks-mr-demo',
          'FAILED="StackStatus==\'CREATE_FAILED\' || StackStatus==\'ROLLBACK_IN_PROGRESS\' || StackStatus==\'ROLLBACK_COMPLETE\' || StackStatus==\'ROLLBACK_FAILED\' || StackStatus==\'UPDATE_ROLLBACK_COMPLETE\' || StackStatus==\'UPDATE_ROLLBACK_FAILED\' || StackStatus==\'CREATE_IN_PROGRESS\'"',
          'for region in us-east-2 us-west-2 us-east-1; do',
          '  echo "::group::$region -- stacks not in a *_COMPLETE state"',
          '  aws cloudformation list-stacks --region "$region" --no-cli-pager \\',
          '    --query "StackSummaries[?($FAILED) && starts_with(StackName, \'$PROJECT-\')].[StackName, StackStatus]" --output text',
          '  echo "::endgroup::"',
          '  for stack in $(aws cloudformation list-stacks --region "$region" --no-cli-pager \\',
          '      --query "StackSummaries[?($FAILED) && starts_with(StackName, \'$PROJECT-\')].StackName" --output text); do',
          '    echo "::group::$region $stack -- failure events"',
          '    aws cloudformation describe-stack-events --stack-name "$stack" --region "$region" --no-cli-pager --max-items 40 \\',
          '      --query "StackEvents[?contains(ResourceStatus, \'FAILED\') || contains(ResourceStatus, \'ROLLBACK\')].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]" --output text 2>&1 | head -40',
          '    echo "::endgroup::"',
          '  done',
          'done',
          // The in-VPC installer runs in CodeBuild; a failed build is the other place a
          // rail failure hides. Surface the last build per installer project.
          'echo "::group::CodeBuild installer builds (last 3 per region)"',
          'for region in us-east-2 us-west-2; do',
          '  for p in $(aws codebuild list-projects --region "$region" --query "projects[?starts_with(@, \'$PROJECT\')]" --output text); do',
          '    ids=$(aws codebuild list-builds-for-project --project-name "$p" --region "$region" --max-items 3 --query ids --output text)',
          '    [ -n "$ids" ] && aws codebuild batch-get-builds --ids $ids --region "$region" --query "builds[].[projectName,buildStatus,currentPhase,logs.deepLink]" --output text',
          '  done',
          'done',
          'echo "::endgroup::"',
        ].join('\n'),
      },
      {
        name: 'Verify every stack is in a *_COMPLETE state',
        run: 'make verify',
      },
      {
        name: 'Refresh AWS credentials (pre-cleanup)',
        if: 'always()',
        uses: 'aws-actions/configure-aws-credentials@v6',
        with: {
          'role-to-assume': `arn:aws:iam::${E2E_ACCOUNT}:role/github-actions-eks-multi-region`,
          'aws-region': 'us-east-2',
          'role-duration-seconds': 28800,
        },
      },
      {
        name: 'Cleanup on success',
        if: 'success()',
        run: './cleanup.sh',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Generate one CDK subproject + 3 workflows per pattern.
// ---------------------------------------------------------------------------
for (const p of patterns) {
  const runsOn = [p.runsOn ?? 'ubuntu-latest'];
  // Subproject scaffolding (cdk.json, tsconfig.json, package.json, .projen/).
  // The subproject's package.json + cdk.json + tsconfig.json are what
  // customers use. They are fully self-contained: `cd <outdir> && npm ci &&
  // npx cdk deploy` works without any reference to the root projenrc.
  //
  // A selfManaged pattern owns these files through its OWN .projenrc.ts and is
  // skipped here -- the root still emits its workflows + dependabot entry below.
  if (!p.selfManaged) {
    const subproject = new awscdk.AwsCdkTypeScriptApp({
      parent: root,
      outdir: p.outdir,
      name: p.outdir,
      ...SHARED_CDK_CONFIG,
    });
    // licensed:false makes projen set "license": "UNLICENSED" in package.json.
    // Override to "MIT" so package.json matches the repo's root LICENSE.
    subproject.package.addField('license', 'MIT');
  }

  // ----------- Build workflow ---------------------------------------------
  const buildWf = new github.GithubWorkflow(root.github!, `${p.outdir}-build`);
  // Runs on every branch, main included: the README badge reports the
  // workflow's latest run on the default branch, so a build that never runs
  // on main leaves the badge pinned to the last manual dispatch there.
  buildWf.on({
    push: { paths: [`${p.outdir}/**`] },
    workflowDispatch: {},
  });
  // Preserve the original GitHub Actions display name (matters for branch
  // protection required-check names: 'aurora: build / build').
  buildWf.file?.addOverride('name', `${p.outdir}: build`);
  buildWf.addJobs({
    build: {
      runsOn,
      permissions: { contents: github.workflows.JobPermission.READ },
      defaults: { run: { workingDirectory: p.outdir } },
      steps: p.buildSteps,
    },
  });

  // ----------- E2E workflow -----------------------------------------------
  const e2eWf = new github.GithubWorkflow(root.github!, `${p.outdir}-e2e`);
  e2eWf.on({
    pullRequest: { paths: [`${p.outdir}/**`] },
    workflowDispatch: {},
  });
  e2eWf.file?.addOverride('name', `${p.outdir}: e2e`);
  if (p.e2eEnv) {
    e2eWf.file?.addOverride('env', p.e2eEnv);
  }
  if (p.selfManaged) {
    // A self-managed rail has FIXED stack names (a cross-file contract its tests pin),
    // so two e2e runs in one account would collide. Queue them; never cancel an
    // in-flight one -- a half-torn-down rail is the worst state to leave behind.
    e2eWf.file?.addOverride('concurrency', { group: `${p.outdir}-e2e`, 'cancel-in-progress': false });
  }
  e2eWf.addJobs({
    e2e: {
      runsOn,
      permissions: {
        idToken: github.workflows.JobPermission.WRITE,
        contents: github.workflows.JobPermission.READ,
      },
      timeoutMinutes: p.e2eTimeoutMinutes,
      defaults: { run: { workingDirectory: p.outdir } },
      steps: p.e2eSteps,
    },
  });

  // ----------- Cleanup workflow (manual only) -----------------------------
  const cleanupWf = new github.GithubWorkflow(root.github!, `${p.outdir}-cleanup`);
  if (p.selfManaged) {
    // A self-managed rail names its assets buckets by a per-run prefix (sha-suffixed in
    // e2e). Cleanup runs only on e2e SUCCESS, so a failed run leaves buckets under the
    // failed head's prefix -- and the next run's pre-flight cleanup uses the NEW prefix and
    // never sees them. This input lets an operator sweep a specific failed run's prefix.
    cleanupWf.on({
      workflowDispatch: {
        inputs: {
          assets_bucket_prefix: {
            description: 'ASSETS_BUCKET_PREFIX of the run to clean (e2e uses eks-multi-region-<sha6>)',
            required: false,
            default: p.outdir,
            type: 'string',
          },
        },
      },
    });
    cleanupWf.file?.addOverride('env', {
      ...(p.e2eEnv ?? {}),
      ASSETS_BUCKET_PREFIX: `\${{ inputs.assets_bucket_prefix || '${p.outdir}' }}`,
    });
  } else {
    cleanupWf.on({ workflowDispatch: {} });
  }
  cleanupWf.file?.addOverride('name', `${p.outdir}: cleanup`);
  cleanupWf.addJobs({
    cleanup: {
      runsOn,
      permissions: {
        idToken: github.workflows.JobPermission.WRITE,
        contents: github.workflows.JobPermission.READ,
      },
      timeoutMinutes: p.cleanupTimeoutMinutes,
      defaults: { run: { workingDirectory: p.outdir } },
      steps: p.cleanupSteps,
    },
  });
}

// ---------------------------------------------------------------------------
// Dependabot configuration (label-driven auto-merge, all semver levels):
//   - lockfile-only versioning strategy for npm
//   - weekly schedule, grouped minor+patch per ecosystem × directory
//   - 'auto-approve' + 'auto-merge' labels trigger the approval workflow
//   - CI is the only gate — no semver filtering
// ---------------------------------------------------------------------------
const dependabotEntry = (
  ecosystem: 'npm' | 'github-actions',
  directory: string,
): Record<string, unknown> => {
  const entry: Record<string, unknown> = {
    'package-ecosystem': ecosystem,
    directory,
    schedule: { interval: 'weekly' },
    labels: ['auto-approve', 'auto-merge'],
    groups: {
      'all-minor-and-patch': {
        'update-types': ['minor', 'patch'],
      },
    },
    'open-pull-requests-limit': 5,
  };
  if (ecosystem === 'npm') {
    entry['versioning-strategy'] = 'lockfile-only';
  }
  return entry;
};

new YamlFile(root, '.github/dependabot.yml', {
  marker: true,
  obj: {
    version: 2,
    updates: [
      dependabotEntry('npm', '/'),
      ...patterns.map((p) => dependabotEntry('npm', `/${p.outdir}`)),
    ],
  },
});

// ---------------------------------------------------------------------------
// Auto-approve workflow: approves Dependabot PRs that carry the 'auto-approve'
// label. Triggered on label, open, sync, ready_for_review events.
//
// Uses `pull_request`, not `pull_request_target` (AWS-427). Dependabot-triggered
// `pull_request` runs get a read-only GITHUB_TOKEN by default; the job-level
// `permissions` block raises it to what the step needs, which is GitHub's own
// documented pattern for Dependabot auto-approve. Values from the `github`
// context reach the shell only through environment variables.
// ---------------------------------------------------------------------------
const autoApproveWf = new github.GithubWorkflow(root.github!, 'auto-approve');
autoApproveWf.on({
  pullRequest: {
    types: ['labeled', 'opened', 'synchronize', 'reopened', 'ready_for_review'],
  },
});
autoApproveWf.addJobs({
  approve: {
    runsOn: ['ubuntu-latest'],
    permissions: { pullRequests: github.workflows.JobPermission.WRITE },
    if: "contains(github.event.pull_request.labels.*.name, 'auto-approve') && github.event.pull_request.user.login == 'dependabot[bot]'",
    steps: [
      {
        name: 'Approve PR',
        env: {
          GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
          PR_NUMBER: '${{ github.event.pull_request.number }}',
          REPO: '${{ github.repository }}',
        },
        run: 'gh pr review --approve "$PR_NUMBER" --repo "$REPO"',
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Auto-merge workflow: enables squash auto-merge on every Dependabot PR.
// GitHub will merge once required checks pass + approval is present.
// `pull_request` trigger and env-var indirection for the same reasons as
// auto-approve above (AWS-427).
// ---------------------------------------------------------------------------
const autoMergeWf = new github.GithubWorkflow(root.github!, 'auto-merge');
autoMergeWf.on({
  // 'synchronize' re-arms auto-merge on every push to the Dependabot branch
  // (initial open + any rebase/force-push). This is the primary durable
  // safety net: if the arming call flakes once at open time, the next push
  // re-tries. Do NOT rely solely on retry-automerge (check_suite:completed) —
  // its conclusion=='success' gate is skipped whenever a neutral/skipped
  // check (e.g. CodeQL "skipping") is present in the suite.
  pullRequest: {
    types: ['opened', 'reopened', 'ready_for_review', 'synchronize'],
  },
});
autoMergeWf.addJobs({
  'enable-auto-merge': {
    runsOn: ['ubuntu-latest'],
    permissions: {
      contents: github.workflows.JobPermission.WRITE,
      pullRequests: github.workflows.JobPermission.WRITE,
    },
    if: "github.event.pull_request.user.login == 'dependabot[bot]'",
    steps: [
      {
        name: 'Enable auto-merge',
        env: {
          GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
          PR_NUMBER: '${{ github.event.pull_request.number }}',
          REPO: '${{ github.repository }}',
        },
        run: 'gh pr merge --auto --squash "$PR_NUMBER" --repo "$REPO"',
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Dependency review: catches license violations + known CVEs on every PR.
// ---------------------------------------------------------------------------
const depReviewWf = new github.GithubWorkflow(root.github!, 'dependency-review');
depReviewWf.on({ pullRequest: {} });
depReviewWf.addJobs({
  'dependency-review': {
    runsOn: ['ubuntu-latest'],
    permissions: { contents: github.workflows.JobPermission.READ },
    steps: [
      { uses: 'actions/checkout@v6' },
      { uses: 'actions/dependency-review-action@v4' },
    ],
  },
});

// ---------------------------------------------------------------------------
// Retry auto-merge: re-enables auto-merge on Dependabot PRs after a check
// suite completes (catches PRs where the initial auto-merge didn't stick due
// to transient conflicts or incomplete checks at open time).
// ---------------------------------------------------------------------------
const retryAutoMergeWf = new github.GithubWorkflow(root.github!, 'retry-automerge');
retryAutoMergeWf.on({
  checkSuite: { types: ['completed'] },
});
retryAutoMergeWf.addJobs({
  'retry-auto-merge': {
    runsOn: ['ubuntu-latest'],
    permissions: {
      contents: github.workflows.JobPermission.WRITE,
      pullRequests: github.workflows.JobPermission.WRITE,
    },
    // Only gate on the source app, NOT on conclusion == 'success'. A neutral/
    // skipped check (e.g. CodeQL "skipping") makes the suite conclusion
    // 'neutral', which previously skipped this job on every run. Enabling
    // auto-merge is safe regardless: GitHub still only completes the merge
    // once required checks pass + branch protection is satisfied.
    if: "github.event.check_suite.app.slug == 'github-actions'",
    steps: [
      {
        name: 'Re-enable auto-merge on Dependabot PRs',
        env: {
          GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
          REPO: '${{ github.repository }}',
        },
        run: [
          'for pr in $(gh pr list --repo "$REPO" --author "app/dependabot" --json number,autoMergeRequest --jq \'.[] | select(.autoMergeRequest == null) | .number\'); do',
          '  echo "Re-enabling auto-merge on PR #$pr"',
          '  gh pr merge --auto --squash "$pr" --repo "$REPO" || true',
          'done',
        ].join('\n'),
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// CODEOWNERS (AWS-427): changes to workflow files, and to this file that
// generates them, request review from the owning team. The team must hold
// write access on the repository for GitHub to honour the entry.
// ---------------------------------------------------------------------------
const codeOwners = '@aws-samples/aws-cre';
new TextFile(root, '.github/CODEOWNERS', {
  marker: false,
  lines: [
    '# ~~ Generated by projen. To modify, edit .projenrc.ts and run "npx projen".',
    '#',
    '# Requests a review from the owning team whenever these paths change. It does not',
    '# block a merge: that needs "Require review from Code Owners" in the main branch',
    '# protection, which stays OFF on purpose. auto-approve and auto-merge approve',
    '# Dependabot PRs as github-actions[bot], and a bot cannot satisfy a Code Owners',
    '# review, so turning it on would stall every Dependabot PR.',
    `*                    ${codeOwners}`,
    `/.github/            ${codeOwners}`,
    `/.projenrc.ts        ${codeOwners}`,
    '',
  ],
});

root.synth();
