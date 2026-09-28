// Refreshes test/fixtures/action-resource-types.json from the AWS Service Reference for every
// action the runner policy grants. Run after adding an action to docs/iam/github-actions-role-policy.json:
//   node test/fixtures/refresh-action-resource-types.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(here, '..', '..', 'docs', 'iam', 'github-actions-role-policy.json'), 'utf8'));
const actions = [...new Set(policy.Statement.flatMap((s) => [s.Action].flat()))].sort();
const byService = new Map();
for (const a of actions) { const [svc, name] = a.split(':'); byService.set(svc, [...(byService.get(svc) ?? []), name]); }
const out = {};
for (const [svc, names] of byService) {
  const res = await fetch(`https://servicereference.us-east-1.amazonaws.com/v1/${svc}/${svc}.json`);
  if (!res.ok) throw new Error(`${svc}: HTTP ${res.status}`);
  const ref = new Map((await res.json()).Actions.map((x) => [x.Name, x]));
  for (const n of names) {
    const x = ref.get(n);
    out[`${svc}:${n}`] = x ? (x.Resources ?? []).map((r) => r.Name).sort() : null;
  }
}
const path = join(here, 'action-resource-types.json');
const prev = JSON.parse(readFileSync(path, 'utf8'));
writeFileSync(path, JSON.stringify({ _source: prev._source.replace(/fetched \d{4}-\d{2}-\d{2}/, `fetched ${new Date().toISOString().slice(0, 10)}`), actions: out }, null, 1) + '\n');
console.log(`wrote ${Object.keys(out).length} actions to ${path}`);
