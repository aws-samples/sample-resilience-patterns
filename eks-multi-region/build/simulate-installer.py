#!/usr/bin/env python3
"""Run the SYNTHESIZED installer buildspec locally against a modeled cluster.

WHY THIS EXISTS. On 2026-09-02 three consecutive main-pipeline deploys failed, each one
layer past the last, each costing a ~40-minute merge/deploy cycle and a live outage window:

  1. The LBC caBundle patch selected NOTHING (grep against the wrong field) -- every
     Service create in the cluster failed x509 while the pass reported success.
  2. The zonal-shift prerequisite attribute was left at its real default (enabled):
     CreateListener rejected the NLB as "not compatible with zonal shift".
  3. The fixed run converged 3 minutes after the installer's hostname wait expired
     (LBC exponential backoff) -- the pipeline failed while the cluster was healing.

Every one of them was invisible to synth, cfn-lint, and the unit tests, because the
failure lives in the INTERACTION between the generated buildspec and cluster/AWS
behavior. This simulator closes that gap: it extracts the installer's build commands
from the synthesized template (the artifact that actually runs -- AGENTS.md bug class 1
discipline) and executes them with shimmed `kubectl` / `aws` / `sleep` binaries against
a small model of the cluster. The model encodes only VERIFIED behaviors, each annotated
with the incident or doc that proved it. An invocation the shim does not recognize is a
hard failure, so new installer commands must be modeled before they ship.

Scenarios (all run by default):
  fresh      empty cluster -> full build phase -> webhook CA correct, Service migrated
             to the LBC, hostname captured
  migration  a live in-tree orders-api pre-exists -> the D6 delete fires exactly once
  rerun      the full build phase runs TWICE against persistent state -> idempotency;
             this is what catches the stale-pod-cert race the rollout restart fixes

Requires: cdk.out/<region template>.json (run `npx cdk synth -q` first), PyYAML
(present locally and in CI via cfn-lint), and openssl (real certs, real mismatches).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(REPO, 'cdk.out', 'eks-mr-demo-region-us-east-2.template.json')

# ---------------------------------------------------------------------------------------
# Modeled AWS behavior. ONLY verified facts belong here; cite the proof on every rule.
# ---------------------------------------------------------------------------------------

# ELBv2 target-group attribute keys (NLB-relevant subset). ModifyTargetGroupAttributes
# rejects unknown keys, and an INVENTED key inside the annotation is exactly the Step 8
# near-miss (aws-load-balancer-attributes-zonal-shift-config) one level down. Source:
# ELBv2 API reference, describe-target-group-attributes.
TG_ATTR_KEYS = {
    'deregistration_delay.timeout_seconds',
    'deregistration_delay.connection_termination.enabled',
    'preserve_client_ip.enabled',
    'proxy_protocol_v2.enabled',
    'stickiness.enabled',
    'stickiness.type',
    'target_health_state.unhealthy.connection_termination.enabled',
    'target_health_state.unhealthy.draining_interval_seconds',
    'load_balancing.cross_zone.enabled',
    'target_group_health.dns_failover.minimum_healthy_targets.count',
    'target_group_health.dns_failover.minimum_healthy_targets.percentage',
}
# NLB load-balancer attribute keys (subset). Same rejection semantics.
LB_ATTR_KEYS = {
    'load_balancing.cross_zone.enabled',
    'zonal_shift.config.enabled',
    'deletion_protection.enabled',
    'access_logs.s3.enabled',
    'access_logs.s3.bucket',
    'access_logs.s3.prefix',
    'dns_record.client_routing_policy',
}
# AWS DEFAULT for unhealthy-target connection termination is ENABLED ("Connection
# termination is enabled by default" -- NLB guide, edit-target-group-attributes).
# Leaving it unset while enabling zonal shift is the LIVE 2026-09-02 12:49 failure:
# CreateListener -> InvalidConfigurationRequest "not compatible with zonal shift".
TG_CONN_TERM_DEFAULT = 'true'


def fail(msg: str) -> None:
    print(f'simulate-installer: FAILED: {msg}', file=sys.stderr)
    sys.exit(1)


def extract_buildspec() -> tuple[list[str], dict[str, str]]:
    """Install+build commands and baked env vars from the SYNTHESIZED template."""
    try:
        import yaml  # provided locally and in CI by cfn-lint's dependency set
    except ImportError:
        fail('PyYAML missing -- `pip install pyyaml` (CI gets it via cfn-lint)')
    if not os.path.exists(TEMPLATE):
        fail(f'{TEMPLATE} not found -- run `npx cdk synth -q` first')
    t = json.load(open(TEMPLATE))
    for res in t['Resources'].values():
        if res['Type'] != 'AWS::CodeBuild::Project':
            continue
        spec = res['Properties']['Source'].get('BuildSpec', '')
        if 'LBC_MANIFEST_S3_URI' not in spec:
            continue
        doc = yaml.safe_load(spec)
        cmds = doc['phases']['build']['commands']
        env = {e['Name']: str(e['Value'])
               for e in res['Properties']['Environment']['EnvironmentVariables']
               if isinstance(e.get('Value'), str)}
        return cmds, env
    fail('no installer CodeBuild project with an LBC pass found in the template')
    return [], {}


def render_manifests(workdir: str) -> dict[str, str]:
    """Run the REAL render pipeline over the REAL file lists the deploy task uses."""
    files_main = ['k8s/namespaces.yaml', 'k8s/app.yaml', 'k8s/schema-job.yaml',
                  'src/karpenter/karpenter.yaml', 'src/argo/metrics-server.yaml',
                  'src/argo/argocd-install.yaml', 'k8s/argocd-config.yaml',
                  'k8s/chart-repo.yaml']
    files_lbc = ['src/lbc/lbc.yaml']
    files_cr = ['k8s/karpenter-nodepool.yaml', 'k8s/argo-application.yaml']
    # Fake every ${UPPER_SNAKE} placeholder the files reference; render-manifest.py
    # fails loud on a missing one, which is its job, not ours.
    env = dict(os.environ)
    ph = re.compile(r'\$\{([A-Z][A-Z0-9_]*)\}')
    for f in files_main + files_lbc + files_cr:
        for var in ph.findall(open(os.path.join(REPO, f)).read()):
            env.setdefault(var, f'sim-{var.lower().replace("_", "-")}')
    out = {}
    for name, files in (('manifest', files_main), ('lbc', files_lbc), ('cr-manifest', files_cr)):
        p = os.path.join(workdir, f'{name}.yaml')
        with open(p, 'w') as fh:
            subprocess.run([sys.executable, os.path.join(REPO, 'build', 'render-manifest.py'),
                            *files], cwd=REPO, env=env, stdout=fh, check=True)
        out[name] = p
    return out


KUBECTL_SHIM = r'''#!/usr/bin/env python3
"""kubectl shim: a MODEL, not a mock. State lives in $SIM_STATE (JSON). Unrecognized
invocations are hard failures so an installer change cannot silently bypass the sim."""
import base64, json, os, re, sys

STATE = os.environ['SIM_STATE']


def load():
    return json.load(open(STATE))


def save(s):
    json.dump(s, open(STATE, 'w'), indent=1)


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def parse_docs(path):
    """Minimal multi-doc YAML reader: kind, metadata.name/namespace, annotations, and
    webhook entry counts/caBundles. String-level on purpose -- it reads the RENDERED
    manifest the way the pass sees it."""
    docs = []
    for raw in open(path).read().split('\n---'):
        kind = re.search(r'^kind:\s*(\S+)', raw, re.M)
        if not kind:
            continue
        name = re.search(r'^metadata:\n(?:.*\n)*?\s{2}name:\s*(\S+)', raw, re.M)
        ns = re.search(r'^metadata:\n(?:.*\n)*?\s{2}namespace:\s*(\S+)', raw, re.M)
        annotations = dict(re.findall(
            r'^\s{4}(service\.beta\.kubernetes\.io/[\w.-]+):\s*"?([^"\n]*)"?\s*$', raw, re.M))
        webhooks = re.findall(r'^- (?:admissionReviewVersions|clientConfig|name):', raw, re.M)
        # count entries under `webhooks:` -- each starts with `- ` at col 0 in the chart
        n_hooks = len(re.findall(r'^- clientConfig:|^- admissionReviewVersions:', raw, re.M))
        lbc = re.search(r'^\s{2}loadBalancerClass:\s*(\S+)', raw, re.M)
        docs.append({'kind': kind.group(1), 'name': name.group(1) if name else '',
                     'namespace': ns.group(1) if ns else 'default',
                     'annotations': annotations, 'n_webhooks': n_hooks,
                     'loadBalancerClass': lbc.group(1) if lbc else ''})
    return docs


def admit_service_create(s, svc):
    """The admission model. A MutatingWebhookConfiguration intercepting Services with
    failurePolicy Fail: TLS verifies iff caBundle == the CA the pods were STARTED with.
    Proven live 2026-09-02 12:11: blank caBundle -> every Service create fails x509."""
    for cfg in s['webhooks'].get('mutatingwebhookconfiguration', {}).values():
        pods_ca = s.get('lbc_pods_ca', '')
        for ca in cfg['caBundles']:
            if not ca or not pods_ca or ca != base64.b64encode(pods_ca.encode()).decode():
                die('Error from server (InternalError): Internal error occurred: failed '
                    'calling webhook "mservice.elbv2.k8s.aws": failed to call webhook: '
                    'tls: failed to verify certificate: x509: certificate signed by '
                    'unknown authority  [SIMULATED -- caBundle does not match the CA '
                    'the controller pods are serving]')
    # Mutation: the LBC webhook injects loadBalancerClass on NEW Services that opt in.
    if svc['annotations'].get('service.beta.kubernetes.io/aws-load-balancer-type') == 'external':
        svc['loadBalancerClass'] = svc['loadBalancerClass'] or 'eks.amazonaws.com/nlb'
        svc['lbcManaged'] = True
    return svc


def lbc_reconcile(s, svc):
    """The LBC->ELBv2 model for a managed Service. Returns (hostname, event)."""
    ann = svc['annotations']
    lb_attrs = dict(kv.split('=', 1) for kv in ann.get(
        'service.beta.kubernetes.io/aws-load-balancer-attributes', '').split(',') if '=' in kv)
    tg_attrs = dict(kv.split('=', 1) for kv in ann.get(
        'service.beta.kubernetes.io/aws-load-balancer-target-group-attributes', '').split(',') if '=' in kv)
    known_lb = json.loads(os.environ['SIM_LB_ATTR_KEYS'])
    known_tg = json.loads(os.environ['SIM_TG_ATTR_KEYS'])
    for k in lb_attrs:
        if k not in known_lb:
            return '', f'ValidationError: Load balancer attribute {k} is not supported [SIMULATED]'
    for k in tg_attrs:
        if k not in known_tg:
            return '', f'ValidationError: Attribute {k} is not a valid target group attribute [SIMULATED]'
    # THE 2026-09-02 12:49 RULE. AWS default for unhealthy-target connection termination
    # is ENABLED; with zonal shift opted in, CreateListener rejects it unless explicitly
    # disabled ("Enable zonal shift for your Network Load Balancer", prerequisites).
    conn_term = tg_attrs.get(
        'target_health_state.unhealthy.connection_termination.enabled',
        os.environ['SIM_TG_CONN_TERM_DEFAULT'])
    if lb_attrs.get('zonal_shift.config.enabled') == 'true' and conn_term != 'false':
        return '', ('Failed deploy model due to operation error Elastic Load Balancing '
                    'v2: CreateListener, InvalidConfigurationRequest: The current target '
                    'group attribute configuration of your load balancer is not '
                    'compatible with zonal shift. [SIMULATED]')
    return f"sim-nlb-{svc['namespace']}-{svc['name']}.elb.amazonaws.com", ''


def main():
    a = sys.argv[1:]
    line = ' '.join(a)
    s = load()

    if a[:2] == ['version', '--client=true']:
        print('Client Version: sim'); return
    if line.startswith('wait --for=condition=established'):
        return
    if ' delete deploy,statefulset,service,' in ' ' + line:
        return  # argocd default-ns cleanup: modeled as a no-op

    m = re.match(r'-n (\S+) get svc (\S+) -o jsonpath=\{\.spec\.loadBalancerClass\}$', line)
    if m:
        svc = s['services'].get(f'{m.group(1)}/{m.group(2)}')
        if not svc:
            die('', 1)
        print(svc.get('loadBalancerClass', ''), end=''); return

    m = re.match(r'-n (\S+) get svc (\S+)$', line)
    if m:
        if f'{m.group(1)}/{m.group(2)}' not in s['services']:
            die('Error from server (NotFound)', 1)
        return

    m = re.match(r'-n (\S+) delete svc (\S+) --wait=true', line)
    if m:
        s['services'].pop(f'{m.group(1)}/{m.group(2)}', None)
        s['migration_deletes'] = s.get('migration_deletes', 0) + 1
        save(s); return

    if line.startswith('-n kube-system delete secret aws-load-balancer-tls'):
        s.pop('secret_ca', None); save(s); return

    if line.startswith('-n kube-system create secret generic aws-load-balancer-tls'):
        ca_file = re.search(r'--from-file=ca\.crt=(\S+)', line).group(1)
        s['secret_ca'] = open(ca_file).read()
        save(s); print('secret/aws-load-balancer-tls created'); return

    m = re.match(r'apply (?:--server-side --force-conflicts )?-f (\S+)$', line)
    if m:
        for doc in parse_docs(m.group(1)):
            kind = doc['kind'].lower()
            if kind in ('mutatingwebhookconfiguration', 'validatingwebhookconfiguration'):
                existing = s['webhooks'].setdefault(kind, {}).get(doc['name'])
                # server-side apply of the SAME manifest re-blanks caBundle only if the
                # manifest carries the field; ours carries "" so it does. Model that.
                s['webhooks'][kind][doc['name']] = {
                    'caBundles': [''] * doc['n_webhooks'] if doc['n_webhooks'] else
                                 (existing or {}).get('caBundles', ['']),
                }
            elif kind == 'deployment' and doc['name'] == 'aws-load-balancer-controller':
                if 'lbc_pods_ca' not in s:  # first create: pods mount the CURRENT secret
                    s['lbc_pods_ca'] = s.get('secret_ca', '')
                # unchanged spec on re-apply does NOT restart pods (the rerun race)
            elif kind == 'service':
                key = f"{doc['namespace']}/{doc['name']}"
                if key not in s['services']:
                    doc = admit_service_create(s, doc)
                    s['services'][key] = doc
            print(f"{kind}/{doc['name']} serverside-applied [SIM]")
        save(s); return

    m = re.match(r'get (mutatingwebhookconfiguration|validatingwebhookconfiguration) (\S+) '
                 r'-o jsonpath=\{range \.webhooks\[\*\]\}x\{end\}$', line)
    if m:
        cfg = s['webhooks'].get(m.group(1), {}).get(m.group(2))
        if not cfg:
            die(f'Error from server (NotFound): {m.group(1)} {m.group(2)} not found', 1)
        print('x' * len(cfg['caBundles']), end=''); return

    m = re.match(r'get (mutatingwebhookconfiguration|validatingwebhookconfiguration) (\S+) '
                 r'-o jsonpath=\{range \.webhooks\[\*\]\}\{\.clientConfig\.caBundle\}', line)
    if m:
        cfg = s['webhooks'].get(m.group(1), {}).get(m.group(2))
        if not cfg:
            die('NotFound', 1)
        print('\n'.join(cfg['caBundles'])); return

    m = re.match(r'patch (mutatingwebhookconfiguration|validatingwebhookconfiguration) (\S+) '
                 r'--type=json -p (.*)$', line)
    if m:
        cfg = s['webhooks'].get(m.group(1), {}).get(m.group(2))
        if not cfg:
            die(f'Error from server (NotFound): {m.group(2)}', 1)
        for op in json.loads(m.group(3)):
            idx = int(op['path'].rsplit('/', 3)[-3])
            if idx >= len(cfg['caBundles']):
                die(f'jsonpatch index {idx} out of bounds', 1)
            cfg['caBundles'][idx] = op['value']
        save(s); print(f'{m.group(1)}/{m.group(2)} patched [SIM]'); return

    if line.startswith('-n kube-system rollout restart deploy/aws-load-balancer-controller'):
        # THE RERUN FIX: new pods mount the CURRENT secret.
        s['lbc_pods_ca'] = s.get('secret_ca', '')
        save(s); print('restarted [SIM]'); return

    if line.startswith('-n kube-system rollout status deploy/aws-load-balancer-controller'):
        return

    m = re.match(r'get svc -n (\S+) (\S+) -o jsonpath=\{\.status\.loadBalancer\.ingress\[0\]\.hostname\}$', line)
    if m:
        svc = s['services'].get(f'{m.group(1)}/{m.group(2)}')
        if not svc:
            print('', end=''); return
        if svc.get('lbcManaged'):
            host, event = lbc_reconcile(s, svc)
            if event:
                svc['event'] = event
                save(s)
            print(host, end=''); return
        # in-tree Services get a hostname promptly in the model
        print(f"sim-intree-{m.group(1)}-{m.group(2)}.elb.amazonaws.com", end=''); return

    m = re.match(r'describe svc -n (\S+) (\S+)$', line)
    if m:
        svc = s['services'].get(f'{m.group(1)}/{m.group(2)}', {})
        print(f"Events: {svc.get('event', '(none)')}"); return

    die(f'SIM GAP: unmodeled kubectl invocation -- model it before shipping it:\n  kubectl {line}', 99)


main()
'''

AWS_SHIM = r'''#!/usr/bin/env bash
# aws shim: s3 cp maps URIs onto the staged files in $SIM_S3; everything else no-ops.
set -e
if [ "$1" = s3 ] && [ "$2" = cp ]; then
  if [ "$3" = - ]; then cat > "$SIM_S3/$(basename "$4")"; exit 0; fi
  base=$(basename "$3")
  if [ -f "$SIM_S3/$base" ]; then cp "$SIM_S3/$base" "$4"; exit 0; fi
  echo "aws shim: no staged file for $3" >&2; exit 1
fi
if [ "$1" = eks ]; then exit 0; fi
echo "SIM GAP: unmodeled aws invocation: aws $*" >&2; exit 99
'''

SLEEP_SHIM = '''#!/usr/bin/env bash
# 100x compressed time so wait loops keep their shape without their duration.
exec /bin/sleep "$(python3 -c "import sys; print(float(sys.argv[1])/100)" "$1")"
'''


def run_build_phase(cmds, env, workdir, label):
    for i, c in enumerate(cmds):
        r = subprocess.run(['bash', '-c', c], env=env, cwd=workdir,
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            print(r.stdout[-2000:], file=sys.stderr)
            print(r.stderr[-2000:], file=sys.stderr)
            fail(f'[{label}] build command [{i}] exited {r.returncode}')
    return True


def assert_end_state(state_file, label, expect_migration_deletes=None):
    s = json.load(open(state_file))
    ca = s.get('secret_ca', '')
    if not ca:
        fail(f'[{label}] no webhook CA in the cluster state')
    ca_b64 = base64.b64encode(ca.encode()).decode()
    # SERVABILITY, not just patch completion. mservice fires on Service CREATE only, so
    # a webhook whose caBundle no longer matches what the pods actually serve is a
    # DORMANT break: nothing fails until the next Service create, potentially deploys
    # later. The invariant is three-way: caBundle == CA in the secret == CA the pods
    # were (re)started with. A rerun that recreates the secret without restarting the
    # pods satisfies the first equality and violates the second -- the race the
    # rollout restart exists to close.
    pods_ca = s.get('lbc_pods_ca', '')
    if pods_ca != ca:
        fail(f'[{label}] controller pods are serving a STALE cert (not the current '
             f'secret) -- the webhook is dormant-broken and the NEXT Service create '
             f'in the cluster will fail x509. The rollout restart is what prevents this.')
    for kind in ('mutatingwebhookconfiguration', 'validatingwebhookconfiguration'):
        cfgs = s['webhooks'].get(kind, {})
        if not cfgs:
            fail(f'[{label}] no {kind} exists after the pass')
        for name, cfg in cfgs.items():
            for j, cb in enumerate(cfg['caBundles']):
                if cb != ca_b64:
                    fail(f'[{label}] {kind}/{name} webhook[{j}] caBundle does not match '
                         f'the generated CA (empty={not cb}) -- the exact 12:11 defect')
    svc = s['services'].get('demo/orders-api')
    if not svc:
        fail(f'[{label}] demo/orders-api does not exist after the pass')
    if not svc.get('lbcManaged') or not svc.get('loadBalancerClass'):
        fail(f'[{label}] orders-api is not LBC-managed after the pass (in-tree revert)')
    if expect_migration_deletes is not None and s.get('migration_deletes', 0) != expect_migration_deletes:
        fail(f"[{label}] migration deletes = {s.get('migration_deletes', 0)}, "
             f'expected {expect_migration_deletes}')


def scenario(name, cmds, baked_env, manifests):
    workdir = tempfile.mkdtemp(prefix=f'installer-sim-{name}-')
    bindir = os.path.join(workdir, 'bin')
    s3dir = os.path.join(workdir, 's3')
    os.makedirs(bindir)
    os.makedirs(s3dir)
    state_file = os.path.join(workdir, 'state.json')
    shim_py = os.path.join(workdir, 'kubectl-shim.py')
    open(shim_py, 'w').write(KUBECTL_SHIM)
    open(os.path.join(bindir, 'kubectl'), 'w').write(
        f'#!/usr/bin/env bash\nexec python3 {shim_py} "$@"\n')
    open(os.path.join(bindir, 'aws'), 'w').write(AWS_SHIM)
    open(os.path.join(bindir, 'sleep'), 'w').write(SLEEP_SHIM)
    for b in ('kubectl', 'aws', 'sleep'):
        os.chmod(os.path.join(bindir, b), 0o755)

    for key, path in manifests.items():
        shutil.copy(path, os.path.join(s3dir, os.path.basename(path)))

    state = {'services': {}, 'webhooks': {}}
    if name == 'migration':
        # a LIVE in-tree Service, as the real cluster had before the feature deployed
        state['services']['demo/orders-api'] = {
            'kind': 'Service', 'name': 'orders-api', 'namespace': 'demo',
            'annotations': {}, 'loadBalancerClass': '', 'lbcManaged': False,
        }
    json.dump(state, open(state_file, 'w'))

    env = dict(os.environ)
    env.update(baked_env)
    env.update({
        'PATH': f"{bindir}:{env['PATH']}",
        'SIM_STATE': state_file,
        'SIM_S3': s3dir,
        'SIM_LB_ATTR_KEYS': json.dumps(sorted(LB_ATTR_KEYS)),
        'SIM_TG_ATTR_KEYS': json.dumps(sorted(TG_ATTR_KEYS)),
        'SIM_TG_CONN_TERM_DEFAULT': TG_CONN_TERM_DEFAULT,
        'AWS_REGION': 'us-east-2',
        'LBC_MANIFEST_S3_URI': 's3://sim/lbc.yaml',
        'MANIFEST_S3_URI': 's3://sim/manifest.yaml',
        'CR_MANIFEST_S3_URI': 's3://sim/cr-manifest.yaml',
        'ENDPOINT_S3_URI': 's3://sim/endpoint.txt',
        'ARGOCD_ENDPOINT_S3_URI': 's3://sim/argocd-endpoint.txt',
        'KUBECTL_S3_URI': 's3://sim/kubectl-bin',
    })
    open(os.path.join(s3dir, 'kubectl-bin'), 'w').write('')

    passes = 2 if name == 'rerun' else 1
    for p in range(passes):
        run_build_phase(cmds, env, workdir, f'{name} pass {p + 1}')
    assert_end_state(state_file, name,
                     expect_migration_deletes=1 if name == 'migration' else 0)
    endpoint = os.path.join(s3dir, 'endpoint.txt')
    if not os.path.exists(endpoint) or 'sim-nlb-demo-orders-api' not in open(endpoint).read():
        fail(f'[{name}] app endpoint was not captured, or is not the LBC-provisioned NLB')
    print(f'simulate-installer: scenario {name}: OK '
          f'({passes} pass(es), endpoint {open(endpoint).read().strip()})')
    shutil.rmtree(workdir)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--scenario', default='all', choices=['all', 'fresh', 'migration', 'rerun'])
    args = ap.parse_args()
    cmds, baked_env = extract_buildspec()
    workdir = tempfile.mkdtemp(prefix='installer-sim-render-')
    try:
        manifests = render_manifests(workdir)
        names = ['fresh', 'migration', 'rerun'] if args.scenario == 'all' else [args.scenario]
        for n in names:
            scenario(n, cmds, baked_env, manifests)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    print('simulate-installer: ALL SCENARIOS PASSED')


if __name__ == '__main__':
    main()
