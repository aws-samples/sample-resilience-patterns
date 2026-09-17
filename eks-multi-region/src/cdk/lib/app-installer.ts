import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { APP_NAMESPACE, APP_SERVICE_NAME, ARGOCD_LB_SERVICE_NAME, ARGOCD_NAMESPACE } from '../k8s';

export interface AppInstallerProps {
  /** VPC the build runs inside. Placed in the private-isolated tier. */
  readonly vpc: ec2.IVpc;
  /** The EKS cluster this installer applies manifests to. */
  readonly cluster: eks.CfnCluster;
  /** Cluster name, for the buildspec's `aws eks update-kubeconfig`. */
  readonly clusterName: string;
  /** Assets bucket the pipeline stages rendered manifests and kubectl into. */
  readonly assetsBucketName: string;
}

/**
 * Applies the Kubernetes manifests from INSIDE the VPC.
 *
 * WHY THIS EXISTS. The cluster API endpoint is private-only (`endpointPublicAccess:
 * false`), so its ENIs live in this VPC and are resolvable only from inside it. The
 * the CI runners are not in this VPC and therefore cannot reach the API server at
 * all — `aws eks update-kubeconfig` still succeeds, because that is an AWS API call
 * rather than a cluster call, so the failure would otherwise be a silent multi-minute TCP
 * timeout inside kubectl. A build project attached to the VPC is the smallest thing that
 * can hold a connection to the API server.
 *
 * HOW THE PIPELINE DRIVES IT. Nothing is fetched from a source repository:
 *
 *   1. The pipeline renders the manifests locally (build/render-manifest.py, which fails
 *      on any unresolved placeholder) and uploads the RESULT to the assets bucket.
 *   2. The pipeline uploads a kubectl binary to the same bucket — see KUBECTL below.
 *   3. The pipeline calls StartBuild with the two object URIs, waits, and on failure
 *      prints this project's log stream.
 *   4. The build writes the Service's load-balancer hostname back to S3, which the
 *      pipeline reads into a dotenv for the load generator and the Route 53 records.
 *
 * Rendering stays in the pipeline deliberately: the placeholder check is the thing that
 * stops a manifest with an empty database host reaching the cluster, and it is better run
 * where its failure is a visible pipeline error than buried in a build log.
 *
 * KUBECTL IS STAGED THROUGH S3, NOT DOWNLOADED. The build has no route to the internet,
 * so it cannot fetch kubectl from dl.k8s.io. The pipeline runner does have one, so it
 * downloads the binary and puts it in the assets bucket, which the build reads over the
 * S3 GATEWAY endpoint. This also pins the two sides to one binary rather than letting the
 * build resolve a version of its own.
 *
 * ARM64. The build image is deliberately the ARM variant so it matches the demo's
 * architecture end to end, and the pipeline stages the arm64 kubectl to match. Changing
 * one without the other yields `exec format error` when the build runs kubectl — the same
 * failure the node group already had to be corrected for. A test asserts the pairing.
 *
 * NOT VERIFIED FROM HERE: whether a build in a subnet with no NAT and no internet gateway
 * completes. AWS documents the CodeBuild interface endpoint as removing the NAT
 * requirement, and the VPC carries endpoints for every service this buildspec calls — but
 * CodeBuild's own VPC guidance separately recommends a NAT gateway, and the two pages do
 * not obviously agree. This is the main risk in the private-endpoint approach and only a
 * live run settles it.
 */
export class AppInstaller extends Construct {
  public readonly project: codebuild.Project;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AppInstallerProps) {
    super(scope, id);

    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'In-VPC manifest installer. Egress only.',
      // Egress to the cluster API endpoint and to the interface endpoints. CodeBuild
      // needs no inbound rules at all — AWS guidance is explicit that build security
      // groups should allow no ingress.
      allowAllOutbound: true,
    });

    this.project = new codebuild.Project(this, 'Project', {
      projectName: `${props.clusterName}-installer`,
      description: 'Applies the demo Kubernetes manifests from inside the VPC.',
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      environment: {
        // ARM to match the demo architecture and the staged kubectl. See the class note.
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      timeout: cdk.Duration.minutes(20),
      environmentVariables: {
        // Known at synth time, so baked in rather than passed per run — fewer values to
        // thread and fewer chances for the pipeline and the manifests to disagree.
        CLUSTER_NAME: { value: props.clusterName },
        APP_NAMESPACE: { value: APP_NAMESPACE },
        APP_SERVICE_NAME: { value: APP_SERVICE_NAME },
        ARGOCD_NAMESPACE: { value: ARGOCD_NAMESPACE },
        ARGOCD_LB_SERVICE_NAME: { value: ARGOCD_LB_SERVICE_NAME },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'aws s3 cp "$KUBECTL_S3_URI" /usr/local/bin/kubectl',
              'chmod +x /usr/local/bin/kubectl',
              'kubectl version --client=true',
            ],
          },
          build: {
            commands: [
              'aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION"',
              // ── AWS Load Balancer Controller: its OWN pass, FIRST ────────────────────
              //
              // WHY A SEPARATE PASS AND NOT PART OF THE CONCATENATED MANIFEST.
              // The controller's `mservice.elbv2.k8s.aws` mutating webhook is
              // `failurePolicy: Fail` and intercepts CREATE on every Service in the cluster.
              // Its `caBundle` is BLANKED in the vendored manifest on purpose — the chart
              // bakes a real TLS private key into a Secret, and committing that would put
              // live key material in git history (the no-secrets-in-version-control rule lists private keys
              // in version control as its first common pitfall; secrets-management guidance requires
              // secrets live in Secrets Manager or KMS).
              //
              // So the CA and serving cert are generated HERE, in-cluster, and the caBundle
              // is patched in. Concatenating this with the app manifest would register a
              // Fail-policy webhook holding a blank CA, and EVERY Service create in the
              // cluster — including the app's own, later in the same file — would fail. That
              // is a guaranteed break, not a race worth tolerating.
              //
              // WHY THE ORDER INSIDE THIS BLOCK MATTERS. `kubectl apply` returning is NOT the
              // webhook being ready to inject: the objects exist, but nothing serves the
              // admission request until the controller pod is up. The app Service must not be
              // created before then, or the in-tree controller claims it and produces an NLB
              // with `instance` targets that no zonal shift can meaningfully drain.
              //
              // Gated on the variable so this stays a no-op for an installer run with no
              // controller to install.
              [
                'if [ -n "$LBC_MANIFEST_S3_URI" ]; then',
                '  aws s3 cp "$LBC_MANIFEST_S3_URI" /tmp/lbc.yaml;',
                // kube-system always exists on a fresh cluster, so the Secret can be created
                // before namespaces.yaml is ever applied.
                '  WEBHOOK_SVC=aws-load-balancer-webhook-service;',
                '  CERT_DIR=$(mktemp -d);',
                // A self-signed CA plus a serving cert signed by it. -addext for the SANs
                // because the webhook is addressed by its in-cluster service DNS names; a
                // cert without them is rejected by the API server with a hostname mismatch,
                // which surfaces as a generic webhook call failure.
                '  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256'
                  + ' -subj "/CN=aws-load-balancer-controller-ca"'
                  + ' -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt";',
                '  openssl req -newkey rsa:2048 -nodes -sha256'
                  + ' -subj "/CN=$WEBHOOK_SVC.kube-system.svc"'
                  + ' -keyout "$CERT_DIR/tls.key" -out "$CERT_DIR/tls.csr";',
                '  printf "subjectAltName=DNS:%s,DNS:%s,DNS:%s\\n"'
                  + ' "$WEBHOOK_SVC" "$WEBHOOK_SVC.kube-system.svc"'
                  + ' "$WEBHOOK_SVC.kube-system.svc.cluster.local" > "$CERT_DIR/san.cnf";',
                '  openssl x509 -req -in "$CERT_DIR/tls.csr" -CA "$CERT_DIR/ca.crt"'
                  + ' -CAkey "$CERT_DIR/ca.key" -CAcreateserial -days 3650 -sha256'
                  + ' -extfile "$CERT_DIR/san.cnf" -out "$CERT_DIR/tls.crt";',
                // Recreated every run: the cert is cheap, and a stale Secret whose CA no
                // longer matches the patched caBundle is a webhook that fails closed.
                '  kubectl -n kube-system delete secret aws-load-balancer-tls'
                  + ' --ignore-not-found;',
                '  kubectl -n kube-system create secret generic aws-load-balancer-tls'
                  + ' --type=kubernetes.io/tls'
                  + ' --from-file=ca.crt="$CERT_DIR/ca.crt"'
                  + ' --from-file=tls.crt="$CERT_DIR/tls.crt"'
                  + ' --from-file=tls.key="$CERT_DIR/tls.key";',
                '  kubectl apply --server-side --force-conflicts -f /tmp/lbc.yaml;',
                // BOTH webhook kinds. The chart ships a Mutating AND a Validating
                // configuration; patching only the mutating one leaves the validating
                // webhook failing closed on TargetGroupBinding writes, which reads as a
                // broken controller rather than a missing CA.
                //
                // BY EXACT NAME, fail-loud -- and this line has history. The first version
                // discovered configs by grepping NAMES for elbv2.k8s.aws, a string that
                // appears only in the webhook ENTRIES inside them (the objects are named
                // aws-load-balancer-webhook). Zero matches, || true swallowed it, zero
                // patches -- and the ;-joined block reported success. The blank-caBundle
                // Fail-policy webhook then blocked EVERY Service create in the cluster,
                // Argo selfHeal included, right after the D6 migration had deleted
                // orders-api: a full primary outage from a grep against the wrong field
                // (live, 2026-09-02 12:11 UTC). The name is pinned by a test DERIVED from
                // the vendored manifest, and an empty selection now fails the deploy.
                '  CA_B64=$(base64 -w0 < "$CERT_DIR/ca.crt");',
                '  WEBHOOK_CFG=aws-load-balancer-webhook;',
                '  for KIND in mutatingwebhookconfiguration validatingwebhookconfiguration; do',
                '    COUNT=$(kubectl get "$KIND" "$WEBHOOK_CFG"'
                  + ' -o jsonpath="{range .webhooks[*]}x{end}" | wc -c);',
                '    if [ "$COUNT" -lt 1 ]; then',
                '      echo "$KIND/$WEBHOOK_CFG not found or has no webhooks --'
                  + ' the caBundle patch would patch NOTHING and every Service create'
                  + ' in the cluster would fail" >&2; exit 1;',
                '    fi;',
                '    for i in $(seq 0 $((COUNT - 1))); do',
                '      kubectl patch "$KIND" "$WEBHOOK_CFG" --type=json'
                  + ' -p "[{\\"op\\":\\"replace\\",\\"path\\":\\"/webhooks/$i/clientConfig/caBundle\\",'
                  + '\\"value\\":\\"$CA_B64\\"}]";',
                '    done;',
                // VERIFY the patch landed on every entry -- the failure mode above was a
                // pass that patched nothing, so presence of the loop is not evidence.
                '    PATCHED=$(kubectl get "$KIND" "$WEBHOOK_CFG"'
                  + ' -o jsonpath="{range .webhooks[*]}{.clientConfig.caBundle}{\\"\\\\n\\\"}{end}"'
                  + ' | grep -cxF "$CA_B64");',
                '    if [ "$PATCHED" != "$COUNT" ]; then',
                '      echo "caBundle patch INCOMPLETE on $KIND/$WEBHOOK_CFG:'
                  + ' $PATCHED of $COUNT entries carry the new CA" >&2; exit 1;',
                '    fi;',
                '  done;',
                // RESTART, not just wait. On a RE-run the Secret is recreated with a NEW
                // cert but the deployment spec is unchanged -- already-Available pods keep
                // serving the OLD cert (kubelet volume sync + cert reload are not awaited
                // by anything), so rollout status returns instantly while the freshly
                // patched caBundle no longer matches what the pods present: the same
                // unknown-authority failure, now as a race. A restart forces new pods that
                // mount the new Secret before the wait below can pass.
                '  kubectl -n kube-system rollout restart deploy/aws-load-balancer-controller;',
                // The wait is the point. Without it the app Service can be created while the
                // webhook is registered but unserved, and loadBalancerClass -- which is
                // IMMUTABLE after create -- never gets injected.
                '  kubectl -n kube-system rollout status deploy/aws-load-balancer-controller'
                  + ' --timeout=300s;',
                'fi',
              ].join(' '),
              'aws s3 cp "$MANIFEST_S3_URI" /tmp/manifest.yaml',
              // ── MIGRATION: the in-tree Service must be DELETED, not updated ────────────
              //
              // `spec.loadBalancerClass` is IMMUTABLE. The pre-migration Service carries the
              // legacy in-tree annotation and no loadBalancerClass, so `kubectl apply` of the
              // new spec fails with "field is immutable" -- server-side apply and
              // --force-conflicts do not help, because this is immutability, not a conflict.
              //
              // CONDITIONAL, so it is a one-time migration and not an outage on every deploy.
              // Deletes ONLY when a live Service exists and lacks loadBalancerClass; a no-op
              // forever after the first run, and a no-op on a fresh cluster.
              //
              // ORDERING (design decision D6). The app Service is INSIDE the Argo-managed chart
              // and the Application has selfHeal: true, so Argo will recreate a missing
              // chart-declared resource. If it recreated from a CACHED OLD chart version we
              // would get the in-tree Service back, or two controllers fighting over one
              // object. The apply immediately below both publishes the NEW chart and creates
              // the new Service, seconds after this delete and far inside Argo's sync interval,
              // so the installer is the writer that wins. Do NOT move this delete into a
              // separate earlier build phase -- the gap is what makes it unsafe.
              [
                'if kubectl -n demo get svc orders-api'
                  + ' -o jsonpath={.spec.loadBalancerClass} 2>/dev/null'
                  + ' | grep -q . ; then',
                '  echo "orders-api already migrated to a loadBalancerClass; no delete needed";',
                'elif kubectl -n demo get svc orders-api >/dev/null 2>&1 ; then',
                '  echo "MIGRATING orders-api: deleting the in-tree Service so the LBC webhook'
                  + ' can inject an immutable loadBalancerClass on recreate";',
                '  kubectl -n demo delete svc orders-api --wait=true --timeout=120s;',
                'else',
                '  echo "no orders-api Service yet; nothing to migrate";',
                'fi',
              ].join(' '),
              // SERVER-SIDE apply, and it is not optional. Client-side `kubectl apply`
              // records the whole object in the `last-applied-configuration` ANNOTATION,
              // and annotations are capped at 262144 bytes -- Argo CD's
              // `applicationsets.argoproj.io` CRD is far bigger than that, so a client-side
              // apply of this manifest dies with:
              //   The CustomResourceDefinition "applicationsets.argoproj.io" is invalid:
              //   metadata.annotations: Too long: may not be more than 262144 bytes
              // Live-proven 2026-08-26 mid-install, AFTER the namespaces/chart-repo
              // documents had already applied. Argo CD's own 3.2->3.3 upgrade notes require
              // SSA for exactly this reason (SSA keeps field ownership server-side and
              // writes no annotation).
              //
              // --force-conflicts is required alongside it, not decoration: objects created
              // by an earlier CLIENT-side apply (every partial run before this fix) already
              // carry the annotation, and migrating them to SSA reports field-manager
              // conflicts unless we take ownership.
              //
              // Document ORDER is unchanged -- kubectl still processes a concatenated file
              // sequentially under SSA -- so the namespaces-first / config-after-override
              // contracts in k8s.ts still hold.
              // CLEANUP OF THE MIS-PLACED ARGO CD COPY, before the apply. Upstream's
              // install manifest carries no metadata.namespace on 50 of its 59 docs,
              // and every apply before the namespace-injection fix ran without `-n` —
              // so an ENTIRE Argo CD instance landed in `default` while the Service
              // and config override sat in `argocd` selecting nothing (empty NLB
              // endpoints, dead front door, Application never reconciled). Delete
              // that copy by its part-of label or two application controllers fight
              // over the same Application CR after the fixed apply. Idempotent:
              // matches nothing on a healthy cluster.
              'kubectl -n default delete deploy,statefulset,service,configmap,secret,serviceaccount,role,rolebinding,networkpolicy -l app.kubernetes.io/part-of=argocd --ignore-not-found',
              'kubectl apply --server-side --force-conflicts -f /tmp/manifest.yaml',
              // Custom resources go in a SECOND apply, after their CRDs are established.
              //
              // `kubectl apply -f` does not wait for a CRD to become established, so a
              // single file containing both a CRD and an instance of it RACES — the custom
              // resource fails with "no matches for kind" even though the CRD appears
              // earlier in the same document. Karpenter's EC2NodeClass and NodePool are
              // exactly that case.
              //
              // Gated on the variable being set so this stays a no-op for any installer run
              // that has no custom resources to apply.
              [
                'if [ -n "$CR_MANIFEST_S3_URI" ]; then',
                '  aws s3 cp "$CR_MANIFEST_S3_URI" /tmp/cr-manifest.yaml;',
                // Named explicitly rather than --all: waiting on --all would also wait for
                // CRDs owned by anything else in the cluster, and a single unrelated
                // unestablished CRD would fail the install.
                '  kubectl wait --for=condition=established --timeout=180s',
                '    crd/ec2nodeclasses.karpenter.k8s.aws crd/nodepools.karpenter.sh;',
                '  kubectl apply -f /tmp/cr-manifest.yaml;',
                'fi',
              ].join(' '),
              // Poll for the load balancer Kubernetes provisions for the Service. It is a
              // KUBERNETES value, not a CloudFormation output, so this is the only place
              // it can be read — and it takes a couple of minutes to appear. The whole
              // loop is one command block because each buildspec command is a separate
              // entry and keeping HOST in scope matters.
              //
              // 25 MINUTES, not 10 — sized to the LBC's EXPONENTIAL BACKOFF, measured
              // live 2026-09-02: after transient reconcile failures the controller's
              // retries were ~7 minutes apart, and the cluster converged (listener
              // created, hostname set) at 13:26 — three minutes AFTER the old 10-minute
              // wait died at 13:23. That run failed the pipeline while the fix it carried
              // was succeeding on the cluster; the retry would have been green. A wait
              // shorter than a few backoff periods turns any transient first failure
              // into a deploy failure.
              [
                'for i in $(seq 1 150); do',
                '  HOST=$(kubectl get svc -n "$APP_NAMESPACE" "$APP_SERVICE_NAME"',
                '    -o "jsonpath={.status.loadBalancer.ingress[0].hostname}");',
                '  if [ -n "$HOST" ]; then break; fi;',
                '  sleep 10;',
                'done;',
                'if [ -z "$HOST" ]; then',
                '  echo "Service never received a load balancer hostname." >&2;',
                '  kubectl describe svc -n "$APP_NAMESPACE" "$APP_SERVICE_NAME" >&2;',
                '  exit 1;',
                'fi;',
                'echo "app endpoint: $HOST";',
                'printf "%s" "$HOST" | aws s3 cp - "$ENDPOINT_S3_URI"',
              ].join(' '),
              // Same poll for the argocd-server NLB (step 12) — the front-door stack's
              // VPC origin targets it, and like the app's it is a KUBERNETES value only
              // readable here. Gated on ARGOCD_ENDPOINT_S3_URI being set so any
              // installer run without a front door stays a no-op, mirroring the
              // CR_MANIFEST gate above. Same 60x10s budget: the in-tree controller has
              // no reason to be slower for the second Service, and a Service that
              // never gets a hostname must fail the deploy HERE rather than three
              // phases later as an empty CfnParameter.
              [
                'if [ -n "$ARGOCD_ENDPOINT_S3_URI" ]; then',
                '  for i in $(seq 1 60); do',
                '    AHOST=$(kubectl get svc -n "$ARGOCD_NAMESPACE" "$ARGOCD_LB_SERVICE_NAME"',
                '      -o "jsonpath={.status.loadBalancer.ingress[0].hostname}");',
                '    if [ -n "$AHOST" ]; then break; fi;',
                '    sleep 10;',
                '  done;',
                '  if [ -z "$AHOST" ]; then',
                '    echo "argocd Service never received a load balancer hostname." >&2;',
                '    kubectl describe svc -n "$ARGOCD_NAMESPACE" "$ARGOCD_LB_SERVICE_NAME" >&2;',
                '    exit 1;',
                '  fi;',
                '  echo "argocd endpoint: $AHOST";',
                '  printf "%s" "$AHOST" | aws s3 cp - "$ARGOCD_ENDPOINT_S3_URI";',
                'fi',
              ].join(' '),
            ],
          },
        },
      }),
    });

    // Read the manifests and kubectl, write the endpoint back. Scoped to this demo's
    // assets bucket rather than the account's buckets.
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`arn:aws:s3:::${props.assetsBucketName}/*`],
      }),
    );
    // update-kubeconfig reads the cluster endpoint and CA certificate.
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['eks:DescribeCluster'],
        resources: [props.cluster.attrArn],
      }),
    );

    // IAM lets the build CALL EKS. Kubernetes RBAC is what lets it act INSIDE the
    // cluster, and the two are separate systems — without an access entry every kubectl
    // call returns a 403 while IAM, synth, the deploy and even plan evaluation all look
    // correct. This is only honoured because the cluster sets
    // authenticationMode API_AND_CONFIG_MAP; under the CloudFormation default of
    // CONFIG_MAP an access entry does nothing at all.
    //
    // CLUSTER-SCOPED CLUSTER-ADMIN, deliberately, and this is the least comfortable part
    // of the design. The installer creates the demo NAMESPACE, and a namespace is a
    // cluster-scoped object: the namespace-scoped policies (Edit, Admin) map to
    // Kubernetes roles that can read namespaces but not create them, so none of them is
    // sufficient. Narrowing path, if that matters more than one-shot provisioning:
    // pre-create the namespace once out of band, then reduce this to AmazonEKSEditPolicy
    // with an access scope of type namespace.
    //
    // What limits the blast radius is not the policy but the principal: this role is
    // assumable only by CodeBuild, and the project it belongs to can only be started by a
    // caller with codebuild:StartBuild on it.
    new eks.CfnAccessEntry(this, 'AccessEntry', {
      clusterName: props.cluster.ref,
      principalArn: this.project.role!.roleArn,
      type: 'STANDARD',
      accessPolicies: [
        {
          policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
          accessScope: { type: 'cluster' },
        },
      ],
    });

    // The API server's ENIs carry the EKS-managed cluster security group, so this is the
    // rule that actually admits the installer. Added as an L1 ingress on a group EKS owns
    // rather than by importing it, which keeps the rule one-directional and leaves the
    // managed group otherwise untouched.
    new ec2.CfnSecurityGroupIngress(this, 'ClusterApiIngress', {
      groupId: props.cluster.attrClusterSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: this.securityGroup.securityGroupId,
      description: 'In-VPC installer to the Kubernetes API server',
    });
  }
}
