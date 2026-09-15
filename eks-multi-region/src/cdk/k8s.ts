/**
 * Kubernetes object names for the demo workload — the SINGLE source of truth.
 *
 * These strings appear in four places that must agree, in four different file formats,
 * with nothing in the type system connecting them:
 *
 *   1. `k8s/app.yaml` + `k8s/schema-job.yaml`  — what actually gets created.
 *   2. The EKS access entry's `AmazonARCRegionSwitchScalingPolicy` access SCOPE (step 7) — a
 *      namespace-scoped policy naming a namespace that does not match the manifest
 *      authorizes nothing, and the failure appears only when the apply runs.
 *   3. The ARC Region switch plan's `scalingResources` (step 8) — `{name, namespace}`
 *      naming the workload to scale. A wrong name there means the scaling step reports
 *      success having scaled nothing, and the DNS shift in a LATER block still succeeds,
 *      so traffic lands on an unscaled standby with every check green.
 *   4. This module.
 *
 * That is the exact defect class this build keeps hitting: two things that must agree,
 * living in different files, with nothing checking them — green build, broken deploy or
 * broken demo. Declaring them once and asserting the YAML against them in a test is the
 * mechanism that closes it. `test/topology.test.ts` reads the manifests as text and
 * checks BOTH directions, so neither side can drift.
 *
 * Keep this module free of `aws-cdk-lib` imports: `.projenrc.ts` imports it to build the
 * deploy task's substitution environment.
 */

/** Namespace holding every demo workload object. */
export const APP_NAMESPACE = 'demo';

/** Deployment name. Named by the ARC plan's scaling block in step 7/8. */
export const APP_DEPLOYMENT_NAME = 'orders-api';

/** Service name. Owns the internal NLB the load generator and Route 53 target. */
export const APP_SERVICE_NAME = 'orders-api';

/** Pod label value for `app`, shared by the Deployment selector and the Service. */
export const APP_LABEL = 'orders-api';

/**
 * The app's HorizontalPodAutoscaler (step 10d).
 *
 * A CONSTANT because three separate things must agree on it and none of them would notice a
 * mismatch: the manifest that creates it, the ARC plan's `hpaName` (step 10e), and the Argo
 * Application's ignoreDifferences entry. Name it wrong in the ARC plan and the scaling step
 * silently skips the HPA patch, so the autoscaler is free to undo ARC's scale-up on its next
 * 15-second cycle -- with the plan reporting success.
 */
export const APP_HPA_NAME = 'orders-api';

/** Port the container listens on. Must match `PORT` in the app and the probes. */
export const APP_CONTAINER_PORT = 8080;

/** Port the Service (and therefore the NLB) listens on. */
export const APP_SERVICE_PORT = 80;

/** Base name of the schema Job. A per-deploy suffix is appended — see below. */
export const SCHEMA_JOB_NAME = 'orders-schema';

/** Manifests, relative to the repo root. Applied in this order. */
/**
 * Namespaces, applied FIRST.
 *
 * `kubectl apply -f` on a concatenated manifest applies documents IN ORDER and does not sort
 * by kind, so a namespaced resource ahead of its Namespace fails with `not found`. Argo CD's
 * vendored install.yaml does not create its own namespace, and the only thing that did was
 * applied last -- a green build that would have failed at the installer.
 */
export const NAMESPACES_MANIFEST = 'k8s/namespaces.yaml';

export const APP_MANIFEST = 'k8s/app.yaml';
export const SCHEMA_JOB_MANIFEST = 'k8s/schema-job.yaml';

/**
 * Cluster-wide pod log shipping (fluent-bit).
 *
 * The namespace is NOT a free choice and must not be "tidied" into `demo`. A log shipper
 * mounts /var/log from the host, and the BASELINE Pod Security Standards profile FORBIDS
 * hostPath volumes -- which is exactly what `demo` enforces. Placed there the DaemonSet is
 * admitted and every POD is rejected, giving 0/0 ready with no logs and no error beyond a
 * pod event: indistinguishable from a bad IAM grant or an unreachable endpoint. So `logging`
 * is declared `enforce: privileged` in k8s/namespaces.yaml, and both this namespace and the
 * service account name are pinned by the IRSA trust policy in lib/fluentbit-iam.ts -- a
 * mismatch there yields WebIdentityErr on every AWS call, which reads as a network fault.
 */
export const LOGGING_NAMESPACE = 'logging';
export const FLUENTBIT_SERVICE_ACCOUNT = 'fluent-bit';
export const FLUENTBIT_MANIFEST = 'k8s/fluent-bit.yaml';

/**
 * Destination log group for EVERY namespace's pod stdout/stderr, one per region.
 *
 * Single group rather than one per namespace so a single Logs Insights query correlates the
 * app, Argo CD and kube-system during a failover -- the reason collection is cluster-wide at
 * all. Records carry a `namespace` field, so narrowing to one component is a filter clause.
 *
 * A function rather than a constant because the name is derived from the app id, and because
 * fluent-bit runs with `auto_create_group false`: the shipper and the CDK log group must
 * agree on this string exactly or every PutLogEvents fails ResourceNotFoundException inside
 * the one pod whose stderr nothing is collecting.
 */
export const podLogGroupName = (appId: string): string => `/eks/${appId}/pods`;

/**
 * The rendered Karpenter install (step 11b) and its custom resources (step 11c).
 *
 * TWO constants because they are applied in TWO passes. karpenter.yaml installs the CRDs;
 * karpenter-nodepool.yaml contains instances of them, and `kubectl apply -f` does not wait
 * for a CRD to become established -- one combined file races and the custom resource fails
 * with "no matches for kind" while the CRDs sit earlier in the same document.
 */
/**
 * The rendered AWS Load Balancer Controller install (single-AZ / zonal-shift feature).
 *
 * GENERATED by src/lbc/render.sh, with the image repointed at the private ECR mirror --
 * pods in the isolated subnets cannot reach public.ecr.aws.
 *
 * MUST BE APPLIED BEFORE {@link APP_MANIFEST}. The controller's mutating webhook injects
 * `spec.loadBalancerClass` on Service CREATE, and that field is IMMUTABLE afterwards. Apply
 * the app Service first and the in-tree controller claims it, producing an NLB with
 * `instance` targets that no zonal shift can meaningfully drain -- and the only fix is to
 * delete and recreate the Service.
 *
 * Applying the manifest is NOT the same as the webhook being READY. `kubectl apply` returns
 * as soon as the objects exist; the webhook only injects once the controller pod is serving.
 * The installer therefore waits for the Deployment to be available before applying the app.
 */
export const LBC_MANIFEST = 'src/lbc/lbc.yaml';

export const KARPENTER_MANIFEST = 'src/karpenter/karpenter.yaml';
export const KARPENTER_NODEPOOL_MANIFEST = 'k8s/karpenter-nodepool.yaml';

/**
 * Vendored Argo CD and metrics-server installs (step 10b).
 *
 * Both are GENERATED by src/argo/render.sh, with every image reference repointed at the
 * private ECR mirror -- pods in the isolated subnets cannot reach quay.io, ghcr.io or
 * registry.k8s.io. metrics-server is a hard prerequisite for the HPA: without it an HPA
 * reports <unknown>/target forever and never acts, silently removing one of the three
 * controllers the coexistence story depends on.
 */
export const ARGOCD_MANIFEST = 'src/argo/argocd-install.yaml';
export const METRICS_SERVER_MANIFEST = 'src/argo/metrics-server.yaml';

/**
 * Argo CD server config for the CloudFront front door (step 12): populates the
 * `argocd-cmd-params-cm` ConfigMap upstream ships EMPTY (`server.insecure: "true"` —
 * the argocd-server Deployment already wires ARGOCD_SERVER_INSECURE from that key), and
 * declares the internal NLB Service the VPC origin targets.
 *
 * MUST RENDER AFTER {@link ARGOCD_MANIFEST}: `kubectl apply -f` processes documents in
 * order, so the populated ConfigMap only wins because it comes later. Reversed, the
 * upstream empty ConfigMap silently erases the setting and the front door 502s/loops
 * with nothing obviously wrong. Same defect class as the namespace ordering; a test
 * pins this order too.
 */
export const ARGOCD_CONFIG_MANIFEST = 'k8s/argocd-config.yaml';
/** Namespace and Service the installer polls for the front door's NLB hostname. */
export const ARGOCD_NAMESPACE = 'argocd';
export const ARGOCD_LB_SERVICE_NAME = 'argocd-server-lb';

/**
 * In-cluster Helm chart repository (step 10c) -- nginx serving the chart that
 * build/package-chart.py produces from the RENDERED app manifest.
 *
 * The chart's only template IS k8s/app.yaml, copied in verbatim after substitution, so Argo
 * CD manages exactly the Deployment the installer applies and ARC later scales. A separate
 * copy of the app spec inside a chart could drift, and the failure would be Argo either
 * reporting OutOfSync against a difference nobody made or "correcting" the live app to a
 * stale spec.
 */
export const CHART_REPO_MANIFEST = 'k8s/chart-repo.yaml';

/**
 * The Argo CD Application (step 10d). Applied in the SECOND installer pass alongside the
 * Karpenter custom resources, because `kubectl apply -f` does not wait for a CRD to become
 * established and an Application in the same file as its CRD fails with "no matches for
 * kind".
 */
export const ARGO_APPLICATION_MANIFEST = 'k8s/argo-application.yaml';
