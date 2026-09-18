# Lessons: failure modes this sample has actually hit

Every item below shipped, was diagnosed the slow way, and cost hours. Comments throughout
the code cite them as `docs/lessons.md #N`. Read before changing anything; several have
tests that fail without their fix. Keep them that way.

Two habits found most of these: **prove a new test fails without its fix before landing it**,
and **verify claims against the live account rather than inferring them from a green pipeline**.
Synth proves nothing about `Fn::GetAtt`, and CloudFormation validates attribute paths only at
deploy.

Carried forward from demos already built on this template. These are **not** hypothetical. Each
one shipped, was diagnosed the slow way, and cost hours. Read before writing code, and append
this demo's own findings as PDD uncovers them.

1. **projen's dax shell is not bash.** `${VAR}` braces pass through **literally** and `set -a` is
   unimplemented, so any dotenv-sourcing step must be wrapped in `bash -c '…'`. That wrapper has
   one invariant: **the generated command must contain no single quotes.** Adding an inner
   `bash -c '…'` broke a real deploy with `unexpected EOF` seven phases in. Audit
   `.projen/tasks.json` after every regen and validate the **generated** `exec` string
   (`bash -n`), not the snippet you wrote.
2. **Default botocore timeouts defeat design guarantees.** Hit *six* separate times in one demo.
   Every boto3 client needs an explicit
   `botocore.config.Config(connect_timeout=…, read_timeout=…, retries=…)` at **module scope**,
   sized under the caller's budget. A *hanging* call outlives the caller's own timeout, so the
   `except`/retry path never runs and the failure looks like a hang, not an error.
3. **Spec values that do not exist in reality.** Engine versions, prop names, and API fields that
   appear in a design doc but not in the SDK. Verify against the installed `aws-cdk-lib` `.d.ts`
   or the live API before trusting any design doc, including a design doc you wrote.
4. **Template-vs-deploy-contract mismatches that synth cannot catch.** A `CfnParameter` declared
   but never threaded through the deploy scripts breaks the *deploy*, not the build. Write a test
   that derives the required parameter set **from the synthesized templates** so it fails at build
   time instead of at phase 9 of a live deploy.
5. **IAM grants that are necessary but not sufficient.** `secretsmanager:GetSecretValue` without
   `kms:Decrypt` on a CMK-encrypted secret fails as *"Access to KMS is not allowed."* A knob you
   both read and flip needs **both** grants. If the caller degrades instead of raising, the
   service can return a stub. One demo did so for days and looked healthy.
6. **UI fields nothing supplies.** A SPA reading `foo.bar` when the backend returns a bare list
   renders `—` or `?` rather than failing. If the UI reads a field, something must produce it.
   A test fixture claiming to mirror a real payload **must actually mirror it**, or the test is
   green against a fiction.
7. **An HTTP front door is NOT a secure browser context.** `crypto.randomUUID()` and friends throw
   there; called at module scope they kill the whole SPA, which is indistinguishable from a
   backend outage. The tunnelled internal ALB has no ACM cert and so serves over
   plain **HTTP**. Never add a secure-context-only browser API to such a UI without adding TLS
   first.
8. **Never pattern-match LLM prose to drive state.** In agentic demos the model paraphrases tool
   output, so prose-matching can fail without an error. Emit a structured event from the tool
   instead.
9. **`kubectl apply -f` runs concatenated manifests in document order** and does not kind-sort
   like Helm. The argocd Namespace sat at line 37026 while its first use was at 34569; the synth
   succeeded, but the install failed on first use. Namespaces apply first (`k8s/namespaces.yaml`);
   config overrides (e.g. `k8s/argocd-config.yaml` populating upstream's EMPTY
   `argocd-cmd-params-cm`) apply AFTER what they override. Both orders are pinned by tests.
10. **Airgapped digests are the arm64 CHILD, never the multi-platform INDEX.** Mirror only one
    platform and the chart-default index digest simply doesn't exist in ECR; pods time out
    pulling and it reads as a network fault. Same family: assert manifest-rewrite COUNTS
    (silent zero-match applies cleanly), chart-repo nginx listens on 8080 with a /index.yaml
    probe, and chart versions are monotonic timestamps (Argo caches by version; hashes can
    resolve backwards).
11. **Operator access is a cross-file contract too.** The observer bastion reaches each
    region's Argo CD and cockpit through an INTERNAL ALB whose only ingress is the observer
    VPC CIDR (`operator-access-stack.ts`), over a VPC peering whose accepter side and return
    route are added by a post-deploy step, not by CloudFormation (`.projenrc.ts`). Edit the
    CIDR, the peering threading or the ALB rule alone and the tunnel connects and then times out,
    which is indistinguishable from a dead ALB. `test/observer.test.ts` pins the pair and asserts
    no `AWS::CloudFront::*` resource exists anywhere: this sample has NO public ingress, and an
    earlier CloudFront-based front door was removed because it depended on an identity service a
    public deployer does not have.
12. **ARC's EKS block sizes the standby from a 24-hour max-replica sample.** Same-day deploy →
    desired collapses toward 0 → the block scales nothing and reports success, so the Argo
    coexistence claim is unsupported. Deploy the day before; on day 2 verify replicas moved 2→4
    BEFORE reading Argo's Synced status. hpaName patches HPA scaleDown.selectPolicy (never
    minReplicas). The ignoreDifferences pair in k8s/argo-application.yaml matches that and must
    not drift to /spec/minReplicas.
13. **Upstream k8s manifests carry NO `metadata.namespace` and assume `apply -n`.** Our
    installer applies ONE concatenated file with no `-n`, so argocd's entire install landed in
    `default` while our Service + config override sat in `argocd` selecting nothing: empty NLB
    endpoints, dead front door, an Application CR no controller ever reconciled, and every stack
    green. Namespace must be IN the document (injected at vendor time); a test requires every
    namespaced doc in every manifest to name its namespace, and the installer deletes the
    mis-placed `default` copy by part-of label before applying.
14. **A green image build does not prove the image can start, and an IN-IMAGE smoke test is not
    enough either.** Attempts 10 AND 11 shipped images missing urllib3; attempt 11's passed
    `RUN python -c "import server, schema"` in CI and still crash-looped, because the loss happens
    at layer EXPORT, after the build filesystem is checked. Mechanism: build-docker.sh looped
    kaniko's SINGLE-USE executor over multiple images in one container. Run N+1 exports layers
    contaminated by run N's leftover filesystem. Fixes (all pinned by tests): `--cleanup` on every
    executor invocation, a post-export check that every ==-pinned package appears in the exported
    tarball's layers (fail-loud exit 1), and a Dockerfile cache-bust whenever the script fix lives
    outside the build context (pods run IfNotPresent, so a same-tag push leaves nodes serving the
    cached bad image).
15. **A CloudFront VPC origin's traffic does NOT source from your VPC CIDR.** The ALB SG must
    admit the CloudFront origin-facing managed prefix list (us-east-2 `pl-b6a144df`,
    us-west-2 `pl-82a045eb`) or the service-managed VPCOrigins SG. VPC-CIDR ingress reads as
    RequestCount=0 plus a 504 from the CloudFront edge, indistinguishable from a dead origin.
    Removing the leftover
    `VpcCidr` CfnParameter requires removing its deploy-step threading in the SAME commit.
16. **An unbounded query against an append-only table is a time bomb with a fuse measured in
    uptime.** `sp_query_orders` had no LIMIT and deletes are soft (rows never leave the
    table), so every `GET /orders` shipped the whole table: read p90 grew 1.7s→5.15s over
    14 hours until it crossed the load generator's 5s timeout, with reads failing at 3,133/hr and
    inverting the demo's core story ("reads stay healthy while writes fail"). Green gate, green
    deploy, perfect at hour one; only a long-running baseline exposes it. Fix:
    `ORDER BY created_at DESC LIMIT 100` + a partial index on live rows, pinned by a
    comment-stripped SQL test. When a demo runs a loadgen for days, every read path needs a bound
    and every soft-deleting table needs a growth story.

17. **A Route 53 routing-policy change is legal ONLY as one atomic change batch, which two
    `AWS::Route53::RecordSet` resources can never produce.** Route 53 refuses records sharing a
    name+type under different routing policies (`marked as primary cannot be created because a
    non-failover RRSet with the same name and type already exists`). Converting BOTH records in
    one batch succeeds; converting one at a time is rejected, and CloudFormation updates separate
    resources individually. Keep the pair in ONE `CfnRecordSetGroup` (a test pins this). Related,
    same family: a record whose live configuration was changed OUT-OF-BAND (an added
    `HealthCheckId`) no longer matches CloudFormation's stored view, so a CFN DELETE of it fails
    mid-operation. Align the live record to the template before any CFN change that removes it.
    All four cases proven in a throwaway hosted zone before touching the live one; do that, and use
    ALIAS records in the probe, because non-alias failover records fail for an unrelated reason
    (`must have an associated health check`) and will "prove" the wrong thing.
18. **ARC creates its Route 53 health checks but does NOT attach them, and their ids are reachable
    only one specific way.** The docs are explicit: the block "creates Amazon Route 53 health
    checks, which you then attach to Route 53 DNS records in your account." Unattached, an
    execution flips check state while the records reference nothing: the plan reports SUCCESS and
    shifts NO traffic. The checks are service-owned (absent from `route53 list-health-checks`,
    `get-health-check` → AccessDenied to Admin). The ONLY CloudFormation route to their ids is
    `Fn::GetAtt [Plan, PlanHealthChecks]`; nested paths like `Route53HealthChecks.HealthCheckIds`
    are rejected at deploy (`must be a readonly property in schema`) even though synth emits
    them happily. Each `PlanHealthChecks` entry uses the format
    `<hostedZoneId>:<recordName>:<region>:<healthCheckId>`, which the docs do not describe. Select
    by MATCHING the region field, never by list index, and keep a post-deploy verifier that fails
    loudly if the format shifts. Mis-binding produces no error.
19. **Latency-routed records have no single "active region" to read.** They resolve
    per-resolver, so "who is serving?" has a different answer per client and an ALB target
    group (fixed IPs, one region) can never follow a failover. Do not build an active-region
    display on a DNS or HTTP probe. Observed traffic has one answer,
    `RegionSuccess{Region=...}`, and it needs no new infrastructure. Corollary: ARC holds the
    standby's health check `unhealthy` in steady state, so latency records were NOT behaving
    active-active in practice; the failover-record migration was for declared intent, not to
    fix live traffic splitting.
    A follow-on issue from the same family: selecting that id by MATCHING the region field is
    the correct design, but doing it with a `CfnCondition` is REJECTED at deploy:
    `Cannot reference resources in the Conditions block of the template`. Conditions may only
    reference parameters, pseudo-parameters and mappings; `Fn::GetAtt` is fine inside Resources.
    CDK synthesizes the illegal form without an error, so only a deploy catches it. The working
    implementation is a positional `Fn::Select` PLUS the post-deploy verifier that re-derives the
    true pairing and fails loudly. The index is an assumption, so something must check it.
20. **Sourcing a stack dotenv sets PREFIXED, UNEXPORTED shell variables, so a child process
    reading `os.environ` sees NONE of them.** Two independent gaps, either fatal alone:
    `deploy-stack.sh` writes keys as `<PREFIX>_<OUTPUTKEY>` (`DNS_HOSTEDZONEID`), and `.`-sourcing
    sets them unexported. The ARC verify step failed with "HOSTEDZONEID is not set" on EVERY
    deploy tail after the failover refactor while all 11 stacks were green, so nothing looked
    wrong, and manual verification masked it twice. Any `finalSteps`/post-deploy step whose
    `run` invokes a script that reads the environment MUST map values through
    `PostDeployPhase.env` (those are emitted after `export`): e.g.
    `env: { HOSTEDZONEID: '$DNS_HOSTEDZONEID' }`. Pinned by two tests: a derived contract
    (required names parsed from the script's own `env()` calls must appear in the generated
    export segment) and a functional round-trip (the REAL generated `bash -c` payload runs
    against fake dotenvs and a Python child must observe the values).

21. **An ALB in front of a Lambda target DISCARDS any response whose `statusDescription`
    is not `<code> <reason-phrase>`** and serves its own HTML 502 instead. A bare `"400"`
    is malformed. The failure is maximally misleading: the Lambda ran, returned in ~2ms,
    and logged success, while the browser got an HTML error page. That makes every diagnosis
    point at the handler, or at the request never arriving. This removed EVERY error message the
    cockpit produced for days, including the "type exactly 'arm' to confirm" hint that would have
    explained the
    original user-facing failure. Two lessons beyond the format itself: put the header construction
    in ONE shared helper so a single fix covers all paths, and treat "the UI shows the load
    balancer's error page" as a *response-contract* suspicion, never as evidence about the
    backend. Pinned by a test asserting the reason phrase on every status the handler can emit.

22. **A fault that reports success is not a fault that did anything, and FIS gives you
    three separate ways to be fooled.** All three were hit live on 2026-09-01.
    (a) `StartExperiment` returning 200 means *accepted*, not *injecting*. Target resolution
    happens afterwards, so an experiment can go `failed` with
    `"Target resolution returned empty set"` (3 AZ templates, nodes in only 2 AZs) while
    the caller has already reported it started. Poll `GetExperiment` for `state`; a fixed
    3-second sleep is a race, so the durable answer is surfacing failed experiments in the
    status poll. (b) `stress-ng`-based faults (`AWSFIS-Run-CPU-Stress`,
    `AWSFIS-Run-Memory-Stress`) delivered cleanly over SSM and moved NOTHING. CPU stress was
    already at all-stressors/100%, and memory-stress at `Percent=85` on 8 GiB nodes left
    availability flat at 100.0% with no eviction. Two causes were never distinguished: the OOM
    killer takes `stress-ng` (the node's largest allocator), or `stress-ng` cannot install at all,
    because these nodes sit in isolated subnets with no NAT and `InstallDependencies: True` must
    fetch it from a package repo. The network faults work *only* because `tc` ships with AL2023.
    Both faults were REMOVED from the cockpit menu rather than shipped with a claim they could not
    deliver. The construct still builds the templates, so re-enabling is one line once a stressor
    is proven to run here. (c) `fis:ListExperiments` / `ListExperimentTemplates` declare NO
    resource type, so a resource-scoped grant yields `AccessDenied`; they need their own
    `'*'`-resource statement.

23. **FIS severity has a CEILING as well as a floor.** At `delay=500ms` the amplified read p90
    (~6.2s) put every read past the 5s `read_timeout` and availability hit 0%. At the time a
    50% `ClientAvailabilityGuardrail` was every experiment's stop condition, so **FIS halted
    the experiment itself** ~3 minutes in and the demo healed before an operator could decide,
    which is the failure mode `region-stack.ts` warns about. That guardrail no longer exists:
    it was removed when the load generator moved to the observer region, because FIS requires
    a stop-condition alarm in the experiment's region and no client metric lands in the
    primary any more (an alarm cannot read across regions). Experiments are bounded by their
    fixed 15-minute duration and the cockpit's Stop button instead; the ceiling is now the
    chart itself, since a fault that drives availability to 0% leaves nothing readable to
    decide from. The usable band is `readable chart < target < ~99% decision alarm`; shipped
    values are `delay=400ms` and `packetLossPercent=25` (10% loss was absorbed ENTIRELY by TCP
    retransmission). Amplification is by DB round trips per request: reads ~12.3x, writes
    ~3.0x. Two corollaries: a halted or stopped experiment can leave a residual `tc netem`
    qdisc on the nodes, and `networkSources` must include the **READER** endpoint
    (`cluster-ro-*`), because a writer-only list reaches reads only when a single-instance
    cluster resolves both names to the same address. The moment a reader instance existed,
    the calibrated read amplification would stop meaning anything, and nothing would report
    it. Severity assertions must be TWO-SIDED; the original one-sided "must exceed the
    timeout" test is what allowed the 500ms overshoot to look correct.

24. **A no-VPC Lambda cannot reach a cluster whose endpoint is `endpointPublicAccess:
    false`**. There is no route, and the symptom is a timeout that reads like a broken cluster.
    For anything that must query the Kubernetes API for demo status (replica counts, pod state),
    the working pattern is an **in-cluster CronJob** that pushes the value out to CloudWatch, not a
    Lambda that pulls it in. Same family: `NodeGroup`'s CFN `Ref` returns a `cluster/nodegroup`
    composite and the EKS API rejects the slash, so
    split it with `Fn::Select [1, Fn::Split ['/', ...]]` rather than passing the Ref
    through.


25. **The AWS CLI applies `--query` PER PAGE, so any JMESPath that aggregates across the
    whole result set breaks, with no error, on the day the result set outgrows one page.** This is
    a time bomb fused to
    *data growth*, not to a code change: `restore-steady-state.sh` picked the newest staged kubectl
    with `sort_by(Contents[?ends_with(Key,'k8s/kubectl')], &LastModified)[-1].Key` and ran clean
    four times, then on 2026-09-08 the assets bucket crossed 1,000 objects and the per-page query
    returned **one key per page**. The two keys concatenated into a malformed multi-line "URI" and
    the cleanup build died at `INSTALL` on `aws s3 cp` before any kubectl ran. That failure points
    at S3 or credentials, not at a pagination boundary. `length()` is the same bug wearing
    different clothes: `length(InstanceInformationList)` in `start-region-wide-injection.sh` yields
    one count per page past SSM's default `MaxResults` of 10, making `MANAGED` = `"10<tab>2"` so
    the `-eq 0` guard dies with *integer expression expected*. Because `set -e` is suppressed
    inside an `if` condition, the script carries on. (That particular guard still protected its
    real case, since zero results is always one page; the damage was the operator-facing count.
    Severity varies. Diagnose it, do not assume it.)
    **The fix is always to aggregate CLIENT-side:** keep the per-page query but emit enough to
    re-aggregate (`[-1].[LastModified,Key]` then `sort | tail -n 1 | cut -f2`; ISO-8601 sorts
    lexicographically so that is a correct max), or ask for the raw list and count with `wc -w`.
    `--no-paginate` is NOT a fix because it discards data. Neither `--page-size` nor a larger
    `MaxResults` is a fix; both just move the threshold. Two tests pin both call sites. **Audit any
    `sort_by` / `max_by` / `min_by` / `length()` inside a `--query` on a list-or-describe that can
    return more than one page.** `[0]` / `[-1]` on a SINGLE-resource describe
    (`Stacks[0].StackStatus` for one named stack, `AutoScalingGroups[0]` for one named ASG) is
    perfectly safe, so this is not a blanket ban on indexing.

26. **A namespace's Pod Security Standards label can reject every POD of a workload while
    admitting the workload OBJECT, and the symptom looks like IAM or networking.** The BASELINE
    profile forbids `hostPath` volumes. AWS's own EKS pod-security guidance says so outright ("You
    can use the Pod Security Standards Baseline or Restricted policies to prevent the use of
    hostPath"). `k8s/namespaces.yaml` puts `enforce: baseline` on `demo`, and a log shipper cannot
    work without mounting `/var/log` from the host. Placed in `demo`, the fluent-bit DaemonSet is
    created without complaint and reports 0 desired / 0 ready, no log group activity, and no error
    anywhere except a pod event. That is indistinguishable from a missing `logs:PutLogEvents` grant
    or an unreachable interface endpoint, both of which are the FIRST things anyone checks on this
    cluster (the nodes sit in isolated subnets with no NAT, so "it cannot reach the endpoint" is
    always plausible). Hence the `logging` namespace with `enforce: privileged`, as `argocd`
    already carries it, and `privileged` buys hostPath and NOTHING else. The pod still drops ALL
    capabilities, forbids privilege escalation, runs a read-only root filesystem and mounts every
    host path readOnly. Two general rules follow. First, when adding a workload, read the target
    namespace's `pod-security.kubernetes.io/enforce` label BEFORE choosing the namespace, because
    the admission decision is a property of the namespace and not of the manifest. Second, a "no
    pods, no logs" symptom on this cluster should have PodSecurity checked before IAM, since
    `kubectl describe` on the DaemonSet names the violated policy immediately while the IAM
    hypothesis takes far longer to disprove. Pinned by a test asserting the shipper's namespace is
    privileged and is not the app namespace, plus a namespace-inventory test that now asserts the
    NAMED set (`argocd`, `demo`, `logging`) rather than a bare count. A count reports that something
    changed without saying what was expected, and passes for the wrong reason when one namespace
    is renamed while another is added.

    Same family, cheaper to hit: **`${AWS_REGION}` in a rendered manifest resolves to the
    PIPELINE RUNNER's region, not the target region.** `build/render-manifest.py` substitutes from
    `os.environ`, and `AWS_REGION` is already set there by the deploy job. A shipper rendered that
    way points the STANDBY's pods at the PRIMARY region's CloudWatch Logs endpoint. The standby is
    the region ARC switches to, so the failure surfaces only during the failover it was meant to
    record. Use the explicit per-region value the manifest env already supplies (`APP_REGION`); a
    test asserts `${AWS_REGION}` appears nowhere in the manifest.

### Operational facts to know early

- **A permissions boundary cloned from `PlanRoleBoundary` will BREAK any role that must
  pass a service role.** That policy denies `iam:PassRole` outright, and a boundary is an
  INTERSECTION, so the deny wins over a correct-looking identity-policy grant. AWS FIS
  cannot start an experiment without the caller passing it a role, so the cockpit's
  `CockpitRoleBoundary` denies `iam:PassRole` with
  `StringNotEquals {iam:PassedToService: fis.amazonaws.com}` instead. The identity policy
  allows the exact role with the matching `StringEquals`, and the two halves must be edited
  together. "Harmonizing" the two boundaries would produce an authorization failure whose
  message points at the role policy, where the grant is present and looks right. Pinned by
  a test that fails when the condition is inverted. Related: never blanket-deny `iam:*` in
  either boundary. That also blocks the read-only `iam:SimulatePrincipalPolicy` which ARC
  plan evaluation calls, and it parked evaluation in `actionRequired` for a day (2026-08-26).
- **Threading ARNs as CfnParameters is a security change, not just tidiness.** The cockpit
  handler originally discovered ARNs with `cloudformation:DescribeStacks`; AWS
  privilege-escalation guidance documents `iam:PassRole` + `cloudformation:CreateStack` +
  `cloudformation:DescribeStacks` as an escalation chain, so that role held two of three
  legs. Threading removed the grant and simultaneously tightened three resource scopes from
  wildcards to exact ARNs. See `docs/cockpit-threat-model.md`.

- **`projen build` now cfn-lints the synthesized templates** (`build/lint-templates.sh`,
  postCompile, after synth and before the container build). It exists because synth cannot
  see template-level errors and CloudFormation rejects some of them only at
  `CreateChangeSet`, mid-deploy. It caught the bug-class-19 `CfnCondition` as `E8003`.
  Two traps are baked into it. `--ignore-checks` is VARIADIC, so
  `cfn-lint --ignore-checks E3018 <files>` eats the paths as check names and lints
  **nothing** while printing `E1001 ... None:1:1`; pass the files FIRST, because a form with
  another flag in between only works by accident. And `E3018` on the ARC plan's
  `ReportConfiguration` is a linter schema gap, not a defect: the identical template reached
  `CREATE_COMPLETE` on 2026-08-29. The script hard-fails on zero templates or a
  lint-that-checked-nothing, and skips with a loud warning when cfn-lint is absent so a CI
  image without it cannot block a deploy (`CFN_LINT_REQUIRED=1` makes it fatal).

- **CI does NOT run `projen build`.** It runs `yarn ci:build:cdk`, a separate composite
  task (`compile → synth:silent → lint:templates → test → package:assets`). A gate wired
  only into `postCompile` therefore runs locally and **never in CI**. Add lifecycle steps to
  BOTH or the pipeline stays green while checking nothing. The CI build job must also
  install any tool such a step depends on: it installs `cfn-lint==1.45.0` and sets
  `CFN_LINT_REQUIRED=1` so a missing linter FAILS CI instead of skipping without an error.
  (On an Alpine-based CI image, `pip install` needs `--break-system-packages`. PEP 668 marks
  its Python externally-managed and plain pip exits 1.)

- **The installer CodeBuild projects bake in only `CLUSTER_NAME` + namespace vars.**
  `KUBECTL_S3_URI` / `MANIFEST_S3_URI` / endpoint URIs are per-run overrides supplied by the
  deploy task. A diagnostic `start-build` must pass `--environment-variables-override
  name=KUBECTL_S3_URI,value="s3://<assets-bucket>/<prefix>/k8s/kubectl"` (latest prefix via
  `aws s3api list-objects-v2 ... k8s/kubectl`), or `aws s3 cp "$KUBECTL_S3_URI"` fails on an
  empty arg before any kubectl runs.

- **Renaming a stack destroys and recreates the ARC plan.** CloudFormation stack names are
  immutable, so a rename is a delete followed by a create. That gives a NEW plan ARN (breaking
  anything pinning it) and resets the plan's ~24h replica-sample window, leaving the EKS
  scaling block scaling nothing while reporting success for about a day (bug class 12). Fine
  on an intended teardown; never a drive-by tidy-up. The plan's own `Name` property is
  likewise Replacement-on-change.
- **`get-plan-evaluation-status` serves the LAST CACHED evaluation.** Fixing the underlying
  resource does not clear the banner. Force a rescan with a verbatim no-op `update-plan` (the
  ARN does not change) and confirm `lastEvaluationTime` moved. `UpdatePlan` accepts only
  `arn, description, workflows, executionRole, recoveryTimeObjectiveMinutes, associatedAlarms,
  triggers, reportConfiguration`; echoing back `primaryRegion`/`regions` from `get-plan` fails
  parameter validation.
- **`AllowedCidr` gates the EKS API private endpoint SG, NOT the demo UI.** Every deploy
  resets it to `0.0.0.0/32` (deny-all CfnParameter default), and that is safe and correct
  to leave alone. The EKS endpoint is `endpointPublicAccess: false`, so an open CIDR is
  meaningless from the internet anyway; in-VPC traffic rides EKS's own cluster-managed SG.
  Operator access to the UIs goes through the observer bastion over SSM (the ALB admits
  only the observer CIDR); `AllowedCidr` has nothing to do with it. Verified by reading the
  live SG rule 2026-08-31; an earlier version of this note claimed the parameter "closes
  the demo UI", which was wrong.
- **`yarn` (berry), never `npm install`.** An `npm install` corrupts `yarn.lock`.
- **Python 3.11+** for anything agentic (`strands-agents` needs ≥3.10; system `python3` may be
  3.9).

### Process that works

Do not conclude "impossible" from a type or from silence. Twice in one session a capability was
declared unavailable on inference: once from a resource schema typing an attribute
`array<string>` (its STRINGS turned out to carry the pairing that was assumed missing), once
from a doc saying "Property description not available" (read as absence rather than as
undocumented). Both were wrong, and both were settled in minutes by deploying the thing and
reading the value. Synth in particular proves nothing about `Fn::GetAtt`: CloudFormation does
not validate attribute paths until deploy.

Prove a new test **fails without its fix** before landing it; several tests have been green for
the wrong reason until checked that way. And verify claims against the **live account** rather
than inferring them from a green pipeline: the worst defects found so far were only findable that
way.


### Known security deviations (open, intentional, documented)

Found by the pre-publication review against AWS EKS hardening, least-privilege and
secrets-management guidance. Each is a conscious trade for a teardown-able sample, named here
so a production derivative closes it rather than inheriting it unnoticed.

- **The app authenticates to Aurora as the master user (`dbadmin`).** Least-privilege guidance
  for databases wants a dedicated application role with schema-only privileges. The design:
  the schema job (already the one place that runs DDL) creates `orders_app`, grants it the
  table and the `sp_*` functions, and stores its password in a SECOND Secrets Manager secret;
  the app reads that one. The secondary region inherits database users by replication but
  not secrets, so the second secret must exist in both regions (a replicated secret is the
  simplest). Not done here because it needs a live round trip to prove the writer-failover
  story still holds under the new role.
- **IMDSv2 hop limit is 2 on both node types.** The hardening bar is 1; 2 is what lets a
  pod on the pod network reach IMDS, and the pods hold no identity of their own (no IRSA /
  Pod Identity for the app; see `region-stack.ts`). Closing it means giving `orders-api`
  an EKS Pod Identity association and dropping the node role's Secrets Manager / SSM grants,
  after which both launch templates can go to 1. Pinned at 2 by tests until then, so the
  change is deliberate when it comes.
- **Operator access ALBs listen on HTTP.** In-VPC only, reached through an SSM tunnel, but
  the bastion-to-ALB and ALB-to-Argo hops are cleartext. Fix: an ACM certificate parameter
  on the access stacks, an HTTPS listener with a TLS 1.2+ policy, and Argo without
  `server.insecure`.
- **No Kubernetes NetworkPolicy.** Requires enabling network policy in the VPC CNI add-on
  and a default-deny plus allow rules per namespace; untested on this cluster.
- **CloudWatch log groups use the service default key, not a CMK**, and the operator ALBs
  have no access logs. Both are one property each once a per-region key exists.
