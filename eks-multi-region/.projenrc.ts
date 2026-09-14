import { awscdk, javascript } from 'projen';
import { NodePackageManager } from 'projen/lib/javascript';
import { createBuildTasks, createDeployTasks } from './projenrc';
// Single source of truth for the region list, shared with src/cdk/app.ts. Kept free of
// aws-cdk-lib imports so pulling it in here does not drag CDK into projen synth.
import {
  APP_MANIFEST,
  APP_NAMESPACE,
  APP_SERVICE_NAME,
  ARGO_APPLICATION_MANIFEST,
  ARGOCD_CONFIG_MANIFEST,
  ARGOCD_MANIFEST,
  CHART_REPO_MANIFEST,
  FLUENTBIT_MANIFEST,
  KARPENTER_MANIFEST,
  LBC_MANIFEST,
  LOGGING_NAMESPACE,
  KARPENTER_NODEPOOL_MANIFEST,
  METRICS_SERVER_MANIFEST,
  NAMESPACES_MANIFEST,
  SCHEMA_JOB_MANIFEST,
} from './src/cdk/k8s';
import {
  AZ_COUNT,
  DNS_SUFFIX,
  GLOBAL_DATA_SUFFIX,
  LOADGEN_SUFFIX,
  OBSERVER_CIDR,
  OBSERVER_REGION,
  OBSERVER_SUFFIX,
  PRIMARY_REGION,
  REGIONS,
  FAILOVER_SUFFIX,
  SECONDARY_DB_SUFFIX,
  STACK_SUFFIXES,
  STANDBY_ACCESS_SUFFIX,
  operatorAccessSuffix,
  regionSuffix,
} from './src/cdk/regions';
// Kubernetes object names come from ONE module, shared with the manifests (asserted by
// test) and with the ARC plan's scaling block in step 8.

const project = new awscdk.AwsCdkTypeScriptApp({
  // ---- identity / metadata (values substituted by the recipe) ----------------
  name: 'eks-mr-demo',
  description: 'Multi-region EKS Demo with ARC RS',
  repository: 'https://github.com/aws-samples/sample-resilience-patterns',
  license: 'Apache-2.0',

  // ---- convergent skeleton (BYTE-IDENTICAL to the GitHub tree's block) -------
  defaultReleaseBranch: 'main',
  projenrcTs: true,
  cdkVersion: '2.248.0',
  cdkVersionPinning: true,
  constructsVersion: '10.5.0',
  typescriptVersion: '~5.6.3',
  appEntrypoint: 'cdk/app.ts',
  srcdir: 'src',
  testdir: 'test',
  sampleCode: false, // gotcha 12 — supply our own app.ts, no projen sample stack
  featureFlags: awscdk.CdkFeatureFlags.V2.ALL,
  packageManager: NodePackageManager.YARN_BERRY,
  yarnBerryOptions: {
    yarnRcOptions: {
      nodeLinker: javascript.YarnNodeLinker.NODE_MODULES, // gotcha 1 — NOT PnP
    },
  },
  tsconfig: { compilerOptions: { isolatedModules: true } }, // gotcha 13
  tsconfigDev: { compilerOptions: { isolatedModules: true } }, // gotcha 13

  // The vendored construct barrels (src/cdk/lib/constructs/*/index.ts) re-export with
  // ESM-style specifiers — `export * from './allowed-cidr-security-group.js'`. `cdk
  // synth` resolves those through the ts-node `experimentalResolver` override below,
  // but jest does not, so importing ANY vendored construct from a test fails with
  //   Cannot find module './allowed-cidr-security-group.js'
  // That makes the always-on constructs untestable as shipped. Mapping the `.js`
  // suffix off relative specifiers is the standard fix and is required before any test
  // can instantiate a stack that uses them.
  jestOptions: {
    jestConfig: {
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
    },
  },
  devDeps: ['@types/node'],
  deps: [],
  peerDeps: [],
  eslintOptions: {
    dirs: ['src', 'test'],
    devdirs: ['src/cdk', 'test', 'build-tools', '.projenrc.ts', 'projenrc'], // gotcha 4
    ignorePatterns: ['*.d.ts', '*.js', 'node_modules/', 'lib/'],
  },

  // ---- GitLab seam -----------------------------------------------------------
  github: false, // THE SEAM — no .github/, no release, no depsUpgrade

  // ---- gitignore (gotcha 9; .agents/ via array, OQ5; +python dirs) -----------
  gitignore: [
    // .kiro/ dev-loop tooling (steering + skills, M3.5) is COMMITTED into the demo
    // (matches five-nines: only .kiro/specs is ignored). .agents/ and idea/ are local-only.
    '.agents/', '.kiro/specs/', 'idea/',
    // temporary/ holds scratch: probe harnesses, mutation-test scaffolding, upstream
    // manifests pulled down for vendoring. It was UNTRACKED but not IGNORED, so it
    // showed up in every `git status` and one careless `git add .` would have committed
    // it. See temporary-files steering: scratch belongs here and nowhere else.
    'temporary/',
    // gl-push per-builder config (assignee id etc.) — local-only, never committed.
    '.kiro/skills/gl-push/config.sh',
    '.DS_Store', '**/.DS_Store', 'tsconfig.tsbuildinfo',
    'coverage/', 'test-reports/',
    'cdk.out*/', 'dist/', 'assets/', 'tmp/', '/lib/', '*.d.ts', 'node_modules/',
    '__pycache__/', '*.pyc', '.venv/', 'venv/', '*.egg-info/',
  ],
});

// ---- post-construction (GitLab) — NO addPackageResolutions / auto-queue / PAT
project.tasks.addEnvironment('PROJECT_NAME', project.name);

// CONVERGENT (emit in BOTH provider trees): make `cdk synth` resolve the
// explicit `.js` extension imports the vendored M1 construct barrels use
// (e.g. `export * from './regional-network.js'`). projen runs synth via
// `ts-node -P tsconfig.json` in CommonJS mode, where Node's CJS resolver can't
// map a `.js` specifier to its sibling `.ts` source. ts-node's
// experimentalResolver enables that NodeNext-style mapping. Set via addOverride
// (gotcha 9 — never hand-edit the generated tsconfig.json). Without this the
// always-on constructs fail to load and `cdk synth` is red.
project.tryFindObjectFile('tsconfig.json')?.addOverride('ts-node', {
  experimentalResolver: true,
});

// Container lifecycle toggle (M7, changeset §4a).
//
// TRUE from step 3b onward. The name is the template's and now understates what it does:
// it gates the container BUILD + PUSH machinery generally (kaniko build job, crane push,
// the container-plan step), and from step 3b the APPLICATION image rides that machinery,
// not just the load generator. Turning it off would remove the app image too, not merely
// the traffic generator. The load generator itself arrives in step 4.
const enableLoadGen = true;
// PDD 2026-08-31-chaos-status-page, Step 0. Gates the status+chaos cockpit (a no-VPC
// Lambda served through the us-west-2 operator access door). Off by default in the
// construct is impossible here (projen wires it), so the west-region guard in
// OperatorAccessStack + this flag both gate it: flag off => empty synth diff, verified
// by test/cockpit.test.ts.
const enableCockpit = true;
// Gated at synth via an env var read by app.ts (the cockpit lives INSIDE
// OperatorAccessStack, not its own stack, so unlike enableLoadGen it is not a stack-list
// toggle). Defaults ON; flag off => app.ts passes enableCockpit:false => west-guarded
// construct skipped => empty synth diff (test/cockpit.test.ts pins this). Placed after
// the flag declaration.
project.tasks.addEnvironment('ENABLE_COCKPIT', enableCockpit ? 'true' : 'false');

// Both regions' ECR registries. The image must exist in the region whose nodes pull it,
// and a pod cannot pull across regions. See DEFAULT_DOCKER_IMAGE_REGIONS in the workflow
// factory for why the primary-only default was wrong.
const dockerImageRegions = REGIONS.map((r) => r.name);

// ---- step 3b: installing the workload on the clusters ------------------------------
//
// Everything below is work CloudFormation genuinely cannot do, which is why it is a
// post-deploy phase rather than another stack:
//
//   - Aurora's global WRITER endpoint is not an attribute of anything. CfnGlobalCluster
//     exposes no attributes at all, so the endpoint only exists via a describe call once
//     the cluster is up. The source repo does the same thing from its Makefile.
//   - Kubernetes objects are owned by the cluster API server.
//
// ORDERING. These run after EVERY stack, including secondarydb, and that is forced: the
// standby region's pods need its own reader endpoint, which only exists once the
// secondary member has been created — the last stack in the deploy. An earlier draft of
// the plan had the apply happening right after each RegionStack, which would have had
// the secondary region substituting an endpoint that did not exist yet.
const primary = REGIONS[0].name;
const secondary = REGIONS[1].name;
const regionDotenv = (r: string) => regionSuffix(r);

/** Shared substitutions for k8s/*.yaml. Keys match the ${...} placeholders exactly. */
const manifestEnv = (index: 0 | 1, readHostVar: string) => ({
  CLUSTER_NAME: `$REGION_${index}_EKSCLUSTERNAME`,
  APP_IMAGE_URI: `$REGION_${index}_APPIMAGEURI`,
  APP_REGION: index === 0 ? primary : secondary,
  // Same NAME in both regions — the secret is replicated, and a replica keeps the name
  // but not the ARN. Both regions therefore read the PRIMARY stack's output.
  DB_SECRET_NAME: '$REGION_0_DBSECRETNAME',
  DB_READ_HOST: readHostVar,
  // Identical in both regions by design: Aurora repoints this at the current primary.
  DB_WRITE_HOST: '$GLOBAL_WRITER_ENDPOINT',
  // L1 injection knob NAME, per region. Both regions have their own (each seeded "0");
  // only the primary's is raised for the gray failure. Supplying the standby's real name
  // keeps the renderer's no-empty-placeholder rule satisfied without making the standby
  // pay a failed SSM lookup on every request.
  ERROR_RATE_PARAM: `$REGION_${index}_ERRORRATEPARAMNAME`,
  // Cluster-wide pod log shipping (k8s/fluent-bit.yaml). LOGGING_NAMESPACE is a synth-time
  // constant -- it must equal the namespace k8s/namespaces.yaml declares AND the one the
  // IRSA trust policy pins, or every AWS call from the shipper returns WebIdentityErr. The
  // other three are per-region stack outputs on the usual CfnOutput -> dotenv rail.
  //
  // NOTE the region is supplied as APP_REGION (already above), NOT AWS_REGION:
  // render-manifest.py reads os.environ, where AWS_REGION is the PIPELINE RUNNER's region.
  // Using it would point the standby's shipper at the primary's CloudWatch Logs endpoint.
  LOGGING_NAMESPACE,
  FLUENTBIT_ROLE_ARN: `$REGION_${index}_FLUENTBITROLEARN`,
  FLUENTBIT_IMAGE_REPO: `$REGION_${index}_FLUENTBITIMAGEREPO`,
  LOG_GROUP_NAME: `$REGION_${index}_PODLOGGROUPNAME`,
  // Karpenter (steps 11b/11c). All four are per-region: the cluster name, the ECR mirror
  // URI (account + region), the controller role ARN and the EKS-owned cluster security
  // group id. render-manifest.py fails on any that resolves empty, which is what stops an
  // EC2NodeClass with a blank instance profile ever reaching the cluster.
  KARPENTER_CLUSTER_NAME: `$REGION_${index}_EKSCLUSTERNAME`,
  KARPENTER_IMAGE_REPO: `$REGION_${index}_KARPENTERIMAGEREPO`,
  KARPENTER_CONTROLLER_ROLE_ARN: `$REGION_${index}_KARPENTERCONTROLLERROLEARN`,
  KARPENTER_INSTANCE_PROFILE: `$REGION_${index}_KARPENTERINSTANCEPROFILE`,
  KARPENTER_SECURITY_GROUP_ID: `$REGION_${index}_KARPENTERSECURITYGROUPID`,
  // AWS Load Balancer Controller (single-AZ / zonal-shift feature). All four are per-region
  // and all four are REQUIRED: in a private cluster the controller cannot discover the
  // cluster name, VPC or region (no reachable IMDS) and exits at startup naming the missing
  // flag. render-manifest.py fails on any that resolves empty, which is what stops a
  // controller with a blank cluster name ever reaching the cluster.
  LBC_CLUSTER_NAME: `$REGION_${index}_EKSCLUSTERNAME`,
  // Same idiom as APP_REGION above: a literal, since the region is a property of the
  // manifest's target cluster and is known at render time (unlike an AZ, which is a property
  // of whichever node the scheduler picks).
  LBC_REGION: index === 0 ? primary : secondary,
  LBC_VPC_ID: `$REGION_${index}_LBCVPCID`,
  LBC_IMAGE_REPO: `$REGION_${index}_LBCIMAGEREPO`,
  LBC_CONTROLLER_ROLE_ARN: `$REGION_${index}_LBCCONTROLLERROLEARN`,
  // Argo CD + metrics-server (step 10b). The mirror PREFIX, since those manifests repoint
  // several images at once.
  MIRROR_REGISTRY: `$REGION_${index}_MIRRORREGISTRY`,
});

/**
 * Where the pipeline stages things for the in-VPC installer to pick up.
 *
 * Everything travels through the per-region assets bucket, which already exists and which
 * the deploy role already writes to. The build reads it over the S3 GATEWAY endpoint —
 * the one route out of a subnet with no NAT that costs nothing and needs no new wiring.
 *
 * `dist/assets_prefix` is read INLINE rather than from the task env: projen resolves task
 * env once at startup, before phase 0 has written that file.
 */
const stagePaths = (region: string) => ({
  bucket: `s3://$ASSETS_BUCKET_PREFIX-${region}`,
  prefix: '$(cat dist/assets_prefix)',
});

/**
 * Start the in-VPC installer, wait for it, and print its log stream if it fails.
 *
 * The wait is not optional. Without it the deploy task returns while the manifests have
 * not been applied, so a later step reads an endpoint that does not exist yet and the
 * pipeline reports a successful deploy of a cluster running nothing.
 *
 * On failure the build log is printed into the pipeline output. A build inside an isolated
 * subnet is otherwise a black box — the whole reason for this indirection is that nobody
 * outside the VPC can reach the thing being configured.
 */
const runInstaller = (
  index: 0 | 1,
  region: string,
  manifests: string,
  // Custom resources whose CRDs `manifests` installs. Rendered and staged separately
  // because `kubectl apply -f` does not wait for CRD establishment, so one combined file
  // races and the CR fails with "no matches for kind".
  crManifests?: string,
) => {
  const s = stagePaths(region);
  const stage = `${s.bucket}/${s.prefix}k8s`;
  return [
    // Render LOCALLY so the unresolved-placeholder check fails as a visible pipeline
    // error rather than inside a build log. This is the step that stops a manifest with
    // an empty database host ever reaching the cluster.
    // The chart repo's CONTENT is generated, not committed: package-chart.py builds the
    // Helm archive from the RENDERED app manifest so the chart and the applied Deployment
    // cannot diverge. Rendering app.yaml on its own first is what makes that possible --
    // Argo does not substitute ${...}, so an unrendered chart would ship literal
    // placeholders into the cluster. package-chart.py refuses that case outright.
    `python3 build/render-manifest.py ${APP_MANIFEST} > dist/app-rendered-${region}.yaml`,
    `&& python3 build/package-chart.py dist/app-rendered-${region}.yaml dist/chart-content-${region}.yaml`,
    `&& python3 build/render-manifest.py ${manifests} > dist/manifest-${region}.yaml`,
    // Appended rather than passed to the renderer: it is already fully resolved, and its
    // base64 payload has no placeholders to substitute.
    `&& cat dist/chart-content-${region}.yaml >> dist/manifest-${region}.yaml`,
    `&& aws s3 cp dist/manifest-${region}.yaml "${stage}/manifest-${region}.yaml" --region ${region}`,
    // The AWS Load Balancer Controller manifest travels SEPARATELY, not concatenated.
    //
    // Its `mservice.elbv2.k8s.aws` webhook is failurePolicy: Fail and its caBundle is blanked
    // in the vendored file (no key material in git -- keys are provisioned, never committed). The installer
    // generates the cert, creates the Secret, applies this file, patches the caBundle and
    // WAITS for the controller before the app manifest is applied. Concatenated instead, the
    // Fail-policy webhook would be registered holding a blank CA and every Service create in
    // the cluster -- including the app's own -- would fail.
    `&& python3 build/render-manifest.py ${LBC_MANIFEST} > dist/lbc-${region}.yaml`,
    `&& aws s3 cp dist/lbc-${region}.yaml \"${stage}/lbc-${region}.yaml\" --region ${region}`,
    ...(crManifests
      ? [
        `&& python3 build/render-manifest.py ${crManifests} > dist/cr-manifest-${region}.yaml`,
        `&& aws s3 cp dist/cr-manifest-${region}.yaml "${stage}/cr-manifest-${region}.yaml" --region ${region}`,
      ]
      : []),
    `&& BID=$(aws codebuild start-build --project-name "$INSTALLER_PROJECT" --region ${region}`,
    '  --environment-variables-override',
    `    name=MANIFEST_S3_URI,value="${stage}/manifest-${region}.yaml",type=PLAINTEXT`,
    `    name=KUBECTL_S3_URI,value="${stage}/kubectl",type=PLAINTEXT`,
    `    name=ENDPOINT_S3_URI,value="${stage}/endpoint-${region}.txt",type=PLAINTEXT`,
    // Step 12: the argocd-server NLB hostname, captured the same way as the app's.
    `    name=ARGOCD_ENDPOINT_S3_URI,value="${stage}/argocd-endpoint-${region}.txt",type=PLAINTEXT`,
    `    name=LBC_MANIFEST_S3_URI,value=\"${stage}/lbc-${region}.yaml\",type=PLAINTEXT`,
    ...(crManifests
      ? [`    name=CR_MANIFEST_S3_URI,value="${stage}/cr-manifest-${region}.yaml",type=PLAINTEXT`]
      : []),
    '  --query "build.id" --output text)',
    '&& echo "installer build: $BID"',
    // 120 x 10s = 20 minutes, matching the project timeout. The Service's load balancer
    // takes a couple of minutes to appear and the build waits for it.
    '&& for i in $(seq 1 120); do',
    `  ST=$(aws codebuild batch-get-builds --ids "$BID" --region ${region} --query "builds[0].buildStatus" --output text);`,
    '  if [ "$ST" != IN_PROGRESS ]; then break; fi;',
    '  sleep 10;',
    'done',
    '&& if [ "$ST" != SUCCEEDED ]; then',
    '  echo "installer build $BID finished as $ST — log follows:" >&2;',
    `  LG=$(aws codebuild batch-get-builds --ids "$BID" --region ${region} --query "builds[0].logs.groupName" --output text);`,
    `  LS=$(aws codebuild batch-get-builds --ids "$BID" --region ${region} --query "builds[0].logs.streamName" --output text);`,
    `  aws logs get-log-events --log-group-name "$LG" --log-stream-name "$LS" --region ${region} --query "events[*].message" --output text >&2;`,
    '  exit 1;',
    'fi',
    // The load-balancer hostname is a KUBERNETES value, not a CloudFormation output, so
    // the build is the only place it can be read. Putting it back on the dotenv rail is
    // what lets the load generator (step 4) and the Route 53 records (step 8) consume it
    // the same way as every other threaded value.
    `&& aws s3 cp "${stage}/endpoint-${region}.txt" dist/endpoint-${index}.txt --region ${region}`,
    `&& printf "APP_ENDPOINT_${index}=%s\\n" "$(cat dist/endpoint-${index}.txt)" > dist/app-endpoint-${index}.env`,
    // Route 53 ALIAS records need the NLB's CANONICAL HOSTED ZONE ID as well as its DNS
    // name — a second Kubernetes-era value nothing in CloudFormation exposes. Looked up
    // HERE (the runner has the route and the credentials) rather than in the build,
    // whose isolated subnet has no elasticloadbalancing endpoint. Matched by DNS name
    // over the full text listing because describe-load-balancers cannot filter
    // server-side by DNSName. Requires elasticloadbalancing:DescribeLoadBalancers on
    // the runner role.
    `&& ZID=$(aws elbv2 describe-load-balancers --region ${region}`,
    '  --query "LoadBalancers[].[DNSName,CanonicalHostedZoneId]" --output text',
    `  | grep -F "$(cat dist/endpoint-${index}.txt)" | cut -f2 | head -n1)`,
    // An empty zone id must stop the deploy here: passed through it becomes an alias
    // record CloudFormation rejects at the DNS stack, three phases later and far from
    // its cause.
    '&& if test -z "$ZID"; then',
    `  echo "no load balancer in ${region} matches the captured endpoint" >&2; exit 1;`,
    'fi',
    `&& printf "APP_LB_ZONE_${index}=%s\\n" "$ZID" >> dist/app-endpoint-${index}.env`,
    // STEP 10: the app NLB ARN, for the cockpit's zonal-shift ResourceIdentifier
    // condition key. Resolved exactly like the argocd NLB ARN below — same
    // describe-load-balancers listing (DNSName cannot be filtered server-side), same
    // runner permission, same fail-here-not-three-phases-later rule: an empty ARN
    // passed through becomes a condition key that matches nothing, and StartZonalShift
    // fails at DEMO time, far from its cause. Appended to the app-endpoint dotenv the
    // standby front door already sources.
    `&& APPARN=$(aws elbv2 describe-load-balancers --region ${region}`,
    '  --query "LoadBalancers[].[DNSName,LoadBalancerArn]" --output text',
    `  | grep -F "$(cat dist/endpoint-${index}.txt)" | cut -f2 | head -n1)`,
    '&& if test -z "$APPARN"; then',
    `  echo "no load balancer in ${region} matches the app endpoint" >&2; exit 1;`,
    'fi',
    `&& printf "APP_NLB_ARN_${index}=%s\\n" "$APPARN" >> dist/app-endpoint-${index}.env`,
    `&& echo "app endpoint ${index}: $(cat dist/endpoint-${index}.txt) (zone $ZID, arn $APPARN)"`,
    // Step 12: the argocd-server NLB, discovered like the app's but resolved to an ARN
    // rather than a zone id -- the ARN is only an INTERMEDIATE here, used below to derive
    // the NLB's ENI ip addresses (its ENI description embeds the ARN's resource path).
    // Those ips are what the operator access door's ALB IP-targets. Same
    // describe-load-balancers listing (DNSName cannot be filtered server-side), same
    // runner permission (elasticloadbalancing:DescribeLoadBalancers, already a
    // prerequisite from step 4b), same fail-here-not-three-phases-later rule: an empty
    // ARN means an empty ip list, caught at the count assertion below rather than as an
    // Fn::Select index error inside the access-door changeset.
    `&& aws s3 cp "${stage}/argocd-endpoint-${region}.txt" dist/argocd-endpoint-${index}.txt --region ${region}`,
    `&& printf "ARGO_NLB_DNS_${index}=%s\\n" "$(cat dist/argocd-endpoint-${index}.txt)" > dist/argo-nlb-${index}.env`,
    `&& AARN=$(aws elbv2 describe-load-balancers --region ${region}`,
    '  --query "LoadBalancers[].[DNSName,LoadBalancerArn]" --output text',
    `  | grep -F "$(cat dist/argocd-endpoint-${index}.txt)" | cut -f2 | head -n1)`,
    '&& if test -z "$AARN"; then',
    `  echo "no load balancer in ${region} matches the argocd endpoint" >&2; exit 1;`,
    'fi',
    `&& printf "ARGO_NLB_ARN_${index}=%s\\n" "$AARN" >> dist/argo-nlb-${index}.env`,
    // The ENI addresses, for the operator access door ALB's IP target group. The ENI
    // description for a load balancer is "ELB <type>/<name>/<id>", which is exactly
    // fields 2-4 of the ARN's resource path -- so no second name lookup is needed.
    // Asserted to be exactly AZ_COUNT so a short list fails HERE rather than as an
    // Fn::Select index error inside the access-door changeset.
    '&& LBPATH=$(echo "$AARN" | cut -d/ -f2-4)',
    `&& NLBIPS=$(aws ec2 describe-network-interfaces --region ${region}`,
    '  --filters "Name=description,Values=ELB $LBPATH"',
    // NO BACKTICKS. JMESPath spells string literals with them, but the shell reads them
    // as command substitution -- the generated exec would run `,` as a command. Squeeze
    // the tab-separated --output text into commas instead. Single quotes are avoided for
    // the neighbouring reason: a bash -c wrapper cannot contain them.
    '  --query "NetworkInterfaces[].PrivateIpAddress" --output text | tr -s "[:blank:]" ",")',
    '&& NIPCOUNT=$(echo "$NLBIPS" | tr , "\\n" | grep -c .)',
    `&& if test "$NIPCOUNT" != "${AZ_COUNT}"; then`,
    `  echo "argocd NLB ${index}: expected ${AZ_COUNT} ENI ips, got $NIPCOUNT ($NLBIPS)" >&2; exit 1;`,
    'fi',
    `&& printf "ARGO_NLB_IPS_${index}=%s\\n" "$NLBIPS" >> dist/argo-nlb-${index}.env`,
    `&& echo "argocd NLB ${index}: $AARN ips=$NLBIPS"`,
  ].join(' ');
};

const postDeploy = [
  {
    name: 'read the Aurora global writer endpoint',
    region: primary,
    sourceFiles: [GLOBAL_DATA_SUFFIX],
    run: [
      'ENDPOINT=$(aws rds describe-global-clusters',
      '--global-cluster-identifier "$GLOBALDATA_GLOBALCLUSTERIDENTIFIER"',
      '--query "GlobalClusters[0].Endpoint" --output text)',
      // A missing endpoint must stop the deploy here. Left unchecked it becomes the
      // literal string None in a pod env var, and the pods then start, pass a health
      // probe that makes no database call, and fail every write with a DNS error.
      '&& if test -z "$ENDPOINT" || test "$ENDPOINT" = None; then',
      'echo "global cluster reported no writer endpoint" >&2; exit 1; fi',
      '&& printf "GLOBAL_WRITER_ENDPOINT=%s\\n" "$ENDPOINT" > dist/global-writer.env',
      '&& echo "global writer endpoint: $ENDPOINT"',
    ].join(' '),
  },
  {
    name: 'stage kubectl for the in-VPC installers',
    region: primary,
    sourceFiles: [regionDotenv(primary)],
    env: { CLUSTER_NAME: '$REGION_0_EKSCLUSTERNAME' },
    // The installer builds have NO route to the internet, so they cannot fetch kubectl
    // themselves. This runner does, so it downloads once and stages the binary into every
    // region's assets bucket for the builds to read over the S3 gateway endpoint.
    //
    // Version comes FROM THE CLUSTER rather than a literal pin here: the cluster version
    // is not pinned in the stack (EKS picks its default at create time), so any literal
    // would silently drift outside the supported one-minor skew the first time EKS moved.
    //
    // linux/arm64 is HARDCODED and must stay matched to the installer's ARM build image.
    // Deriving it from this runner would be wrong — the runner's architecture is
    // incidental, the build image's is the contract. A mismatch fails as
    // `exec format error` inside the build. A test asserts the pairing.
    run: [
      'KVER=$(aws eks describe-cluster --name "$CLUSTER_NAME" --query cluster.version --output text)',
      '&& PATCH=$(curl -fsSL "https://dl.k8s.io/release/stable-$KVER.txt")',
      '&& echo "staging kubectl $PATCH (linux/arm64) for cluster version $KVER"',
      '&& curl -fsSLo dist/kubectl "https://dl.k8s.io/release/$PATCH/bin/linux/arm64/kubectl"',
      `&& for R in ${REGIONS.map((r) => r.name).join(' ')}; do`,
      '  aws s3 cp dist/kubectl "s3://$ASSETS_BUCKET_PREFIX-$R/$(cat dist/assets_prefix)k8s/kubectl" --region "$R";',
      'done',
    ].join(' '),
  },
  {
    name: `install the workload in ${primary}`,
    region: primary,
    sourceFiles: [regionDotenv(primary), GLOBAL_DATA_SUFFIX, 'dist/global-writer.env'],
    env: {
      ...manifestEnv(0, '$REGION_0_DBREADERENDPOINT'),
      INSTALLER_PROJECT: '$REGION_0_INSTALLERPROJECTNAME',
    },
    // SCHEMA_JOB_SUFFIX is computed in `run`, not `env`: values in `env` are emitted as
    // escaped data, so a command substitution with inner double quotes is corrupted into
    // `\"` and dies at runtime with `command not found`. Proven by running the step, and
    // now rejected at synth time.
    //
    // Derived from the image tag so the Job name changes only when the image does. A Job
    // pod template is IMMUTABLE, so a stable name plus a new image fails the apply with
    // "field is immutable"; a name tied to the image makes a re-deploy of unchanged code a
    // clean no-op and a code change a fresh Job.
    //
    // Schema first — the app 500s on every route except /health until the stored
    // procedures exist. Both manifests go in one apply so the namespace is created once.
    run: [
      'export SCHEMA_JOB_SUFFIX=$(echo "$APP_IMAGE_URI" | sed "s|.*:||" | cut -c1-8)',
      runInstaller(
        0,
        primary,
        `${NAMESPACES_MANIFEST} ${FLUENTBIT_MANIFEST} ${APP_MANIFEST} ${SCHEMA_JOB_MANIFEST} ${KARPENTER_MANIFEST} ${METRICS_SERVER_MANIFEST} ${ARGOCD_MANIFEST} ${ARGOCD_CONFIG_MANIFEST} ${CHART_REPO_MANIFEST}`,
        `${KARPENTER_NODEPOOL_MANIFEST} ${ARGO_APPLICATION_MANIFEST}`,
      ),
    ].join(' && '),
  },
  {
    name: `install the workload in ${secondary}`,
    region: secondary,
    sourceFiles: [
      regionDotenv(secondary),
      // The primary's dotenv is sourced for the SECRET NAME only.
      regionDotenv(primary),
      SECONDARY_DB_SUFFIX,
      'dist/global-writer.env',
    ],
    // No schema Job here: it writes, and only the primary cluster accepts writes.
    env: {
      ...manifestEnv(1, '$SECONDARYDB_DBREADERENDPOINT'),
      INSTALLER_PROJECT: '$REGION_1_INSTALLERPROJECTNAME',
    },
    run: runInstaller(
      1,
      secondary,
      `${NAMESPACES_MANIFEST} ${FLUENTBIT_MANIFEST} ${APP_MANIFEST} ${KARPENTER_MANIFEST} ${METRICS_SERVER_MANIFEST} ${ARGOCD_MANIFEST} ${ARGOCD_CONFIG_MANIFEST} ${CHART_REPO_MANIFEST}`,
      `${KARPENTER_NODEPOOL_MANIFEST} ${ARGO_APPLICATION_MANIFEST}`,
    ),
  },
  // Step 12: the ACCEPTER side of the observer peerings, one step per workload region.
  // The observer stack (singleton phase) is the REQUESTER — it created each peering with
  // PeerRegion and routed the observer subnet toward the workload CIDRs. There is no
  // native cross-region accept or cross-region route resource, so the peer-side accept
  // and the return route into the observer CIDR are done here with the AWS CLI, from the
  // workload region, exactly as PeeringStack's mesh Lambda would but scoped to the two
  // observer spokes. Idempotent: accepting an already-active peering and re-creating an
  // existing route are both tolerated, so a re-run is a no-op.
  ...REGIONS.map((r, i) => ({
    name: `accept the observer peering and route the observer CIDR in ${r.name}`,
    region: r.name,
    sourceFiles: [
      // The observer stack's outputs (PeeringTo<i>Id, observer CIDR) and this region's
      // route tables. Both are prefixed dotenv vars; postDeployStep exports the env map
      // below so the CLI sees them, and references the sourced $OBSERVER_*/$REGION_* vars.
      `dist/$PROJECT_NAME-${OBSERVER_SUFFIX}.env`,
      `dist/$PROJECT_NAME-${regionSuffix(r)}.env`,
    ],
    env: {
      // Intermediate names deliberately do NOT look like `<STACKPREFIX>_<OUTPUTKEY>`:
      // the consumed-vs-produced contract test parses every `$PREFIX_KEY` in the deploy
      // task, and `$PEERING_ID` would read as output `ID` of the PEERING stack (which
      // does not exist) and fail the build for the wrong reason. `ACCEPT_*` is no stack.
      ACCEPT_PCX: `$OBSERVER_PEERINGTO${i}ID`,
      ACCEPT_CIDR: '$OBSERVER_VPCCIDR',
      RTBS: `$REGION_${i}_ROUTETABLEIDS`,
    },
    // Wait for the requester-created peering to be visible in this region, accept it
    // (tolerating already-active), then add the observer-CIDR route to every non-public
    // route table (tolerating RouteAlreadyExists). No single quotes: postDeployStep wraps
    // this in bash -c and asserts the invariant at synth.
    run: [
      'aws ec2 wait vpc-peering-connection-exists --vpc-peering-connection-ids "$ACCEPT_PCX"',
      '&& aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id "$ACCEPT_PCX" 2>/dev/null || true',
      '&& for RTB in $(echo "$RTBS" | tr , " "); do',
      '  aws ec2 create-route --route-table-id "$RTB" --destination-cidr-block "$ACCEPT_CIDR"',
      '    --vpc-peering-connection-id "$ACCEPT_PCX" 2>/dev/null || true;',
      'done',
      `&& echo "observer peering $ACCEPT_PCX accepted and routed in ${r.name}"`,
    ].join(' '),
  })),
];

// GitLab builds the image with kaniko (shared runners block DinD) + pushes with crane,
// so the build/deploy docker lifecycle tasks are registered when load-gen is on.
//
// REGIONS / STACK_SUFFIXES are imported from src/cdk/regions.ts — the SAME module
// src/cdk/app.ts uses to name its stacks. Packaging names stacks
// `$PROJECT_NAME-<suffix>` while the deploy factory names them
// `$PROJECT_NAME-region-${r.name}`; deriving both from one array is what stops those
// drifting into a green build with a broken deploy.
//
// peering: TRUE as of step 4, reversing D-008.
//
// D-008 dropped peering because nothing appeared to be VPC-routed across regions — Aurora
// replication rides the AWS network, ARC Region switch uses per-region service endpoints,
// traffic shifting is DNS. Every one of those is true and all of them are beside the point:
// DNS resolves names, it does not move packets. The load generator lives in ONE region and
// follows DNS to whichever region is currently active, so it needs a route to the other
// region's INTERNAL load balancer.
//
// The factory's Phase 3 deploys $PROJECT_NAME-peering into the first region after both
// region stacks, threading R<i>{Region,VpcId,VpcCidr,RouteTableIds} from their dotenvs.
createBuildTasks(project, { enableLoadGen, containerBuild: 'kaniko', stackSuffixes: STACK_SUFFIXES });
// Karpenter manifest regeneration (step 11b).
//
// DELIBERATELY NOT part of `build`. Rendering needs helm and internet egress, and making
// the gate depend on either would stop a builder on a restricted network from running it.
// The rendered manifest is COMMITTED and reviewed like source; this task regenerates it
// when a version moves. A test asserts the committed output still agrees with the versions
// pinned in src/mirror/images.json, which is what catches a bump that forgot to re-render.
// Argo CD + metrics-server manifest regeneration (step 10b). Same reasoning as
// karpenter:render -- needs egress, so NOT part of `build`; output is committed.
project.addTask('argo:render', {
  description:
    'Regenerate src/argo/*.yaml from the upstream Argo CD and metrics-server manifests (needs egress).',
  steps: [{ exec: 'bash src/argo/render.sh' }],
});

project.addTask('karpenter:render', {
  description:
    'Regenerate src/karpenter/karpenter.yaml from the upstream Helm chart (needs egress).',
  steps: [{ exec: 'bash src/karpenter/render.sh' }],
});

// AWS Load Balancer Controller manifest regeneration (single-AZ / zonal-shift feature). Same
// reasoning as karpenter:render -- needs egress and a helm binary, so NOT part of `build`;
// the output is committed and reviewed like source. A test asserts the committed manifest's
// pinned tag and arm64 digest still agree with src/mirror/images.json, which is what catches
// a mirror bump that forgot to re-render (and would otherwise ship a manifest pointing at an
// image the mirror never pushed).
project.addTask('lbc:render', {
  description:
    'Regenerate src/lbc/lbc.yaml from the upstream aws-load-balancer-controller chart (needs egress).',
  steps: [{ exec: 'bash src/lbc/render.sh' }],
});

createDeployTasks(project, [...REGIONS], {
  enableLoadGen,
  containerBuild: 'kaniko',
  peering: true,
  // Step 10a. Argo CD, metrics-server and nginx are pulled by pods in isolated
  // subnets, which can only reach PRIVATE ECR — so the pinned upstream images in
  // src/mirror/images.json are copied there before anything deploys.
  mirrorImages: true,
  // Order is forced by Aurora Global Database, not chosen. A member joins a global
  // cluster by declaring globalClusterIdentifier, which requires that cluster to already
  // exist; the cluster in turn adopts the primary member. So the primary region must
  // deploy, then the global cluster, then the secondary member. Reordering these two
  // entries produces a deploy that fails on the second one.
  //
  // Output variable names are `<OUTPUTS_PREFIX>_<OUTPUTKEY-uppercased>`, per
  // build/deploy-stack.sh. Region stacks use REGION_<index>.
  singletons: [
    {
      suffix: GLOBAL_DATA_SUFFIX,
      region: PRIMARY_REGION,
      sourceSuffixes: [regionSuffix(REGIONS[0])],
      outputsPrefix: 'GLOBALDATA',
      stackParameters: { PrimaryDbClusterArn: '$REGION_0_DBCLUSTERARN' },
    },
    {
      suffix: SECONDARY_DB_SUFFIX,
      region: REGIONS[1].name,
      sourceSuffixes: [GLOBAL_DATA_SUFFIX, regionSuffix(REGIONS[1])],
      outputsPrefix: 'SECONDARYDB',
      stackParameters: {
        GlobalClusterIdentifier: '$GLOBALDATA_GLOBALCLUSTERIDENTIFIER',
        VpcId: '$REGION_1_VPCID',
        IsolatedSubnetIds: '$REGION_1_ISOLATEDSUBNETIDS',
        IsolatedSubnetAzs: '$REGION_1_ISOLATEDSUBNETAZS',
        // Aurora must admit 5432 from the group the secondary region's nodes carry.
        // Without it the standby pods fail every request at the TCP connect while
        // synth, build and deploy all stay green.
        EksClusterSecurityGroupId: '$REGION_1_EKSCLUSTERSECURITYGROUPID',
      },
    },
    // Step 12: the observer VPC + bastion, in a THIRD region. It is the REQUESTER of
    // both cross-region peerings, so it needs both workload VPC ids (threaded off the
    // dotenv rail, never Fn::ImportValue). No installer dependency, so it deploys in the
    // singleton phase after both region stacks. Its peering-id outputs feed the
    // accepter-side postDeploy step below.
    {
      suffix: OBSERVER_SUFFIX,
      region: OBSERVER_REGION,
      sourceSuffixes: [regionSuffix(REGIONS[0]), regionSuffix(REGIONS[1])],
      outputsPrefix: 'OBSERVER',
      stackParameters: {
        R0VpcId: '$REGION_0_VPCID',
        R0VpcCidr: '$REGION_0_VPCCIDROUT',
        R1VpcId: '$REGION_1_VPCID',
        R1VpcCidr: '$REGION_1_VPCCIDROUT',
      },
    },
  ],
  postDeploy,
  // Step 4b: the DNS stack deploys AFTER the installer phases (factory Phase 6) because
  // its alias targets are Kubernetes-created load balancers — DNS name and canonical
  // hosted zone id are discovered by the installers and land on the dotenv rail as
  // APP_ENDPOINT_<i> / APP_LB_ZONE_<i> in dist/app-endpoint-<i>.env.
  postDeployStacks: [
    {
      suffix: DNS_SUFFIX,
      region: PRIMARY_REGION,
      // Only the VPC associations: the app RECORDS moved to the failover stack, which owns
      // them alongside the plan whose health checks they carry.
      sourceSuffixes: [regionSuffix(REGIONS[0]), regionSuffix(REGIONS[1])],
      outputsPrefix: 'DNS',
      stackParameters: {
        R0VpcId: '$REGION_0_VPCID',
        R1VpcId: '$REGION_1_VPCID',
      },
    },
    // Step 4c: the load generator, AFTER dns — its tasks resolve the latency record at
    // startup, so the record must exist first or the availability alarm floods with
    // deploy-sequencing noise. Target URL is a synth-time constant (APP_RECORD_NAME),
    // so only the primary VPC placement values are threaded.
    {
      suffix: LOADGEN_SUFFIX,
      region: PRIMARY_REGION,
      sourceSuffixes: [regionSuffix(REGIONS[0])],
      outputsPrefix: 'LOADGEN',
      stackParameters: {
        VpcId: '$REGION_0_VPCID',
        IsolatedSubnetIds: '$REGION_0_ISOLATEDSUBNETIDS',
        IsolatedSubnetAzs: '$REGION_0_ISOLATEDSUBNETAZS',
      },
    },
    // Step 7: the ARC Region Switch plan. AFTER dns — its activate workflow's
    // Route53HealthCheck block needs a real hosted zone id, and that zone is created by
    // the dns stack (which itself waits on the Kubernetes-created load balancers).
    {
      suffix: FAILOVER_SUFFIX,
      region: PRIMARY_REGION,
      sourceSuffixes: [
        regionSuffix(REGIONS[0]),
        regionSuffix(REGIONS[1]),
        GLOBAL_DATA_SUFFIX,
        SECONDARY_DB_SUFFIX,
        DNS_SUFFIX,
        // Plain paths: written by the installer phases, not by a stack deploy. This stack
        // owns the app DNS records, so it needs the Kubernetes-created NLB coordinates.
        'dist/app-endpoint-0.env',
        'dist/app-endpoint-1.env',
      ],
      outputsPrefix: 'FAILOVER',
      stackParameters: {
        HostedZoneId: '$DNS_HOSTEDZONEID',
        R0LbDns: '$APP_ENDPOINT_0',
        R0LbZoneId: '$APP_LB_ZONE_0',
        R1LbDns: '$APP_ENDPOINT_1',
        R1LbZoneId: '$APP_LB_ZONE_1',
        PrimaryClusterName: '$REGION_0_EKSCLUSTERNAME',
        R0ClusterArn: '$REGION_0_EKSCLUSTERARN',
        R1ClusterArn: '$REGION_1_EKSCLUSTERARN',
        R0AppHealthAlarmArn: '$REGION_0_APPHEALTHALARMARN0',
        R1AppHealthAlarmArn: '$REGION_0_APPHEALTHALARMARN1',
        GlobalClusterIdentifier: '$GLOBALDATA_GLOBALCLUSTERIDENTIFIER',
        R0DbClusterArn: '$REGION_0_DBCLUSTERARN',
        R1DbClusterArn: '$SECONDARYDB_DBCLUSTERARN',
      },
    },
    // Step 7: the standby cluster's access entry, in the SECONDARY region because an EKS
    // access entry is regional — and after the plan stack, which creates the role.
    {
      suffix: STANDBY_ACCESS_SUFFIX,
      region: REGIONS[1].name,
      sourceSuffixes: [regionSuffix(REGIONS[1]), FAILOVER_SUFFIX],
      outputsPrefix: 'STANDBYACCESS',
      stackParameters: {
        ClusterName: '$REGION_1_EKSCLUSTERNAME',
        ExecutionRoleArn: '$FAILOVER_EXECUTIONROLEARN',
      },
    },
    // Step 12: the per-region operator access doors. AFTER the installer phases for the
    // same reason as `dns`: the ALB target group takes the Kubernetes-created
    // argocd-server NLB ENI ips, which the installer phases wrote to dist/argo-nlb-<i>.env.
    //
    // Also sources the REGION env: the ALB lives in the region's VPC, so it needs the
    // vpc id, the isolated subnets and their AZs. The ALB ingress source is the observer
    // VPC CIDR, resolved at synth time in operator-access-stack.ts, so no CIDR parameter
    // is threaded. ArgoNlbDns/ArgoNlbArn are deliberately NOT passed -- a target group
    // takes IPs, not a hostname or an ARN.
    ...REGIONS.map((r, i) => ({
      suffix: operatorAccessSuffix(r),
      region: r.name,
      sourceSuffixes: [
        `dist/argo-nlb-${i}.env`,
        `dist/$PROJECT_NAME-${regionSuffix(r)}.env`,
        // STANDBY ONLY, and only because the Cockpit lives there: its scoped ARNs come
        // from the PRIMARY region stack (FIS templates + role, cluster, node group, knob)
        // and from the failover stack (the ARC plan ARN). Sourcing these into the primary
        // access door would be harmless but pointless — the primary template declares no
        // cockpit parameters at all.
        ...(i === 1
          ? [
            `dist/$PROJECT_NAME-${regionSuffix(REGIONS[0])}.env`,
            'dist/$PROJECT_NAME-failover.env',
            // STEP 10: the app NLB ARN (installer-captured, primary) for the cockpit's
            // zonal-shift condition key. Already on the rail — the failover stack
            // sources this same file.
            'dist/app-endpoint-0.env',
          ]
          : []),
      ],
      outputsPrefix: `ACCESS_${i}`,
      stackParameters: {
        ArgoNlbIps: `$ARGO_NLB_IPS_${i}`,
        VpcId: `$REGION_${i}_VPCID`,
        IsolatedSubnetIds: `$REGION_${i}_ISOLATEDSUBNETIDS`,
        IsolatedSubnetAzs: `$REGION_${i}_ISOLATEDSUBNETAZS`,
        // STEP 5 — the cockpit's scoped ARNs, STANDBY ONLY. These MUST match the
        // CfnParameters operator-access-stack.ts declares inside its own standby guard,
        // in BOTH directions: a declared-but-unthreaded parameter fails the changeset with
        // "Parameters: [X] must have values", and a threaded-but-undeclared one fails with
        // "do not exist in the template". Neither shows up in a build — which is why
        // test/cockpit.test.ts derives the required set from the synthesized template and
        // compares it to this map.
        ...(i === 1
          ? {
            PlanArn: '$FAILOVER_PLANARN',
            PrimaryKnobParam: '$REGION_0_ERRORRATEPARAMNAME',
            StandbyKnobParam: '$REGION_1_ERRORRATEPARAMNAME',
            FisRoleArn: '$REGION_0_FISROLEARN',
            FisPacketLossTemplateIds: '$REGION_0_FISPACKETLOSSTEMPLATEIDS',
            FisLatencyTemplateIds: '$REGION_0_FISLATENCYTEMPLATEIDS',
            FisLatencyTemplatesByAz: '$REGION_0_FISLATENCYTEMPLATESBYAZ',
            FisPacketLossTemplatesByAz: '$REGION_0_FISPACKETLOSSTEMPLATESBYAZ',
            FisPowerTemplatesByAz: '$REGION_0_FISPOWERTEMPLATESBYAZ',
            FisBrownoutTemplatesByAz: '$REGION_0_FISBROWNOUTTEMPLATESBYAZ',
            PrimaryClusterName: '$REGION_0_EKSCLUSTERNAME',
            PrimaryNodeGroupName: '$REGION_0_NODEGROUPNAME',
            // STEP 10: the zonal-shift control. AppNlbArn is installer-captured (the NLB
            // is Kubernetes-created, so no CfnOutput exists); AzNameIdPairs is the primary
            // region stack's live DescribeAvailabilityZones lookup.
            AppNlbArn: '$APP_NLB_ARN_0',
            AzNameIdPairs: '$REGION_0_AZNAMEIDPAIRS',
          }
          : {}),
      },
    })),
  ],
  // Phase 7: post-deploy VERIFICATIONS that nothing mutates. The signed-cookie 403
  // bounce-page upload that used to live here is gone with the old CloudFront front
  // door; these two checks remain because they guard silent, deploy-only failure modes.
  finalSteps: [
    // VERIFY that the app records carry the health checks the plan vended, and clear the
    // transient evaluation warning. The failover stack's TEMPLATE owns the attachment (the
    // records take their HealthCheckId from the plan's PlanHealthChecks GetAtt attribute),
    // so nothing here mutates DNS. This step exists because that attribute's format is
    // OBSERVED, not documented -- if AWS changes it the template would bind a wrong id, the
    // plan would still report success, and the failover would shift traffic the wrong way.
    // Silent, so this makes it loud.
    //
    // It also forces one no-op plan re-evaluation: CloudFormation creates the plan BEFORE the
    // records (they depend on it), so ARC's first evaluation always warns "No records with
    // the record name ..." and caches that result.
    {
      name: 'verify the ARC health checks are attached and the plan evaluates clean',
      region: PRIMARY_REGION,
      sourceFiles: [
        `dist/$PROJECT_NAME-${DNS_SUFFIX}.env`,
        `dist/$PROJECT_NAME-${FAILOVER_SUFFIX}.env`,
      ],
      // The script reads os.environ, and sourcing a dotenv sets UNEXPORTED shell vars
      // under prefixed names (DNS_*, FAILOVER_*). Without this mapping the step fails
      // with "HOSTEDZONEID is not set" -- which is exactly how it died on every deploy
      // until 2026-09-01. `env` entries are EXPORTED by postDeployStep, so the Python
      // child sees them; values may reference the sourced vars.
      env: {
        HOSTEDZONEID: '$DNS_HOSTEDZONEID',
        APPRECORDNAME: '$DNS_APPRECORDNAME',
        PLANARN: '$FAILOVER_PLANARN',
      },
      run: 'python3 build/verify-arc-health-checks.py',
    },
    // VERIFY the zonal-shift control's two deploy-only, silent-failure risks (Step 10).
    // Nothing here mutates anything. (1) The threaded AZ name=id pairs must agree with a
    // LIVE DescribeAvailabilityZones — a wrong pairing mis-binds StartZonalShift.awayFrom
    // silently: the shift reports ACTIVE and drains a different AZ than the fault is
    // degrading (bug classes 18/19). (2) The app NLB must actually be OPTED IN to zonal
    // shift by the LB Controller Service annotation — if the migration didn't land,
    // StartZonalShift 404s at DEMO time; this makes it fail the deploy instead.
    {
      name: 'verify the zonal-shift AZ mapping and that the app NLB is opted in',
      region: PRIMARY_REGION,
      sourceFiles: [
        `dist/$PROJECT_NAME-${regionSuffix(REGIONS[0])}.env`,
        'dist/app-endpoint-0.env',
      ],
      // Same bug-class-20 rule as the step above: the script reads os.environ, and a
      // sourced dotenv sets UNEXPORTED, PREFIXED shell vars a Python child cannot see.
      env: {
        APPNLBARN: '$APP_NLB_ARN_0',
        AZNAMEIDPAIRS: '$REGION_0_AZNAMEIDPAIRS',
      },
      run: 'python3 build/verify-zonal-shift-azs.py',
    },
  ],
});
// CI for this sample is generated by the monorepo ROOT .projenrc.ts (GitHub Actions
// build / e2e / cleanup jobs via its `patterns[]` entry), not here. Deploy-time inputs
// the rail reads from the environment -- set them in the CI job or the shell before
// `npx projen deploy`; there are deliberately NO baked-in defaults so a deploy that
// forgot them fails at the first AWS call instead of landing in the wrong account:
//   AWS_REGION            primary region (REGIONS[0]; assets bucket suffix)
//   ASSETS_BUCKET_PREFIX  e.g. eks-multi-region
// The operator reaches the Argo UIs and the cockpit through the observer bastion over
// SSM -- see build/tunnel.sh and docs/runbook.md; no public front door.

project.synth();
