/**
 * Root projen configuration for sample-resilience-patterns monorepo.
 *
 * This is a maintainer-only file. Customers consuming the samples never run
 * projen — they use `npm ci && npx cdk deploy` from inside a subdirectory.
 *
 * What this file generates:
 *   - .github/workflows/*.yml   (6 files: build, e2e, cleanup per pattern)
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
import { typescript, awscdk, javascript, github, YamlFile } from 'projen';

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
          'npx cdk deploy aurora-bootstrap \\',
          '  -c stack=bootstrap -c project=aurora -c primaryRegion=us-east-1 -c secondaryRegion=us-west-2 \\',
          '  -c accountId=$ACCOUNT_ID --require-approval never',
        ].join('\n'),
      },
      {
        name: 'Verify canaries',
        run: [
          'echo "Waiting for canaries to run..."',
          'sleep 360',
          'for canary in aurora-rd-local-e1 aurora-wr-local-e1; do',
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
          'PLAN_ARN=$(aws cloudformation describe-stacks --stack-name aurora-failover-plan --region us-east-1 \\',
          '  --query "Stacks[0].Outputs[?OutputKey==\'PlanArn\'].OutputValue" --output text)',
          'SSM_DOC=$(aws cloudformation describe-stack-resources --stack-name aurora-loadgen --region us-east-1 \\',
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
    e2eEnv: { AWS_REGION: 'us-east-1', PROJECT: 's3mrap' },
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
          'npx cdk deploy s3mrap-bootstrap -c accountId=$ACCOUNT_ID --require-approval never',
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
];

// ---------------------------------------------------------------------------
// Generate one CDK subproject + 3 workflows per pattern.
// ---------------------------------------------------------------------------
for (const p of patterns) {
  // Subproject scaffolding (cdk.json, tsconfig.json, package.json, .projen/).
  // The subproject's package.json + cdk.json + tsconfig.json are what
  // customers use. They are fully self-contained: `cd <outdir> && npm ci &&
  // npx cdk deploy` works without any reference to the root projenrc.
  const subproject = new awscdk.AwsCdkTypeScriptApp({
    parent: root,
    outdir: p.outdir,
    name: p.outdir,
    ...SHARED_CDK_CONFIG,
  });
  // licensed:false makes projen set "license": "UNLICENSED" in package.json.
  // Override to "MIT" so package.json matches the repo's root LICENSE.
  subproject.package.addField('license', 'MIT');

  // ----------- Build workflow ---------------------------------------------
  const buildWf = new github.GithubWorkflow(root.github!, `${p.outdir}-build`);
  buildWf.on({
    push: { paths: [`${p.outdir}/**`] },
    workflowDispatch: {},
  });
  // projen's PushOptions doesn't expose `branches-ignore`, so inject directly.
  buildWf.file?.addOverride('on.push.branches-ignore', ['main']);
  // Preserve the original GitHub Actions display name (matters for branch
  // protection required-check names: 'aurora: build / build').
  buildWf.file?.addOverride('name', `${p.outdir}: build`);
  buildWf.addJobs({
    build: {
      runsOn: ['ubuntu-latest'],
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
  e2eWf.addJobs({
    e2e: {
      runsOn: ['ubuntu-latest'],
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
  cleanupWf.on({ workflowDispatch: {} });
  cleanupWf.file?.addOverride('name', `${p.outdir}: cleanup`);
  cleanupWf.addJobs({
    cleanup: {
      runsOn: ['ubuntu-latest'],
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
// Auto-approve workflow: approves PRs with 'auto-approve' label from trusted
// actors. Triggered on label, open, sync, ready_for_review events.
// ---------------------------------------------------------------------------
const autoApproveWf = new github.GithubWorkflow(root.github!, 'auto-approve');
autoApproveWf.on({
  pullRequestTarget: {
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
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
        run: 'gh pr review --approve "${{ github.event.pull_request.number }}" --repo "${{ github.repository }}"',
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Auto-merge workflow: enables squash auto-merge on every Dependabot PR.
// GitHub will merge once required checks pass + approval is present.
// ---------------------------------------------------------------------------
const autoMergeWf = new github.GithubWorkflow(root.github!, 'auto-merge');
autoMergeWf.on({
  // 'synchronize' re-arms auto-merge on every push to the Dependabot branch
  // (initial open + any rebase/force-push). This is the primary durable
  // safety net: if the arming call flakes once at open time, the next push
  // re-tries. Do NOT rely solely on retry-automerge (check_suite:completed) —
  // its conclusion=='success' gate is skipped whenever a neutral/skipped
  // check (e.g. CodeQL "skipping") is present in the suite.
  pullRequestTarget: {
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
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
        run: 'gh pr merge --auto --squash "${{ github.event.pull_request.number }}" --repo "${{ github.repository }}"',
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
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
        run: [
          'for pr in $(gh pr list --repo "${{ github.repository }}" --author "app/dependabot" --json number,autoMergeRequest --jq \'.[] | select(.autoMergeRequest == null) | .number\'); do',
          '  echo "Re-enabling auto-merge on PR #$pr"',
          '  gh pr merge --auto --squash "$pr" --repo "${{ github.repository }}" || true',
          'done',
        ].join('\n'),
      },
    ],
  },
});

root.synth();
