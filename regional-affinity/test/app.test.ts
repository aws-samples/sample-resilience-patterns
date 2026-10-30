import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SAMPLE_TAG } from '../lib/names';

/**
 * Runs bin/app.ts as the CDK CLI does (`cdk synth` runs the same command, from cdk.json), with the
 * cdk-nag checks on, into a temporary directory, and reads the cloud assembly. The tags that
 * `cdk deploy` puts on a stack are only in the assembly's manifest, and the findings of the checks
 * only in each stack's metadata file, so the fixtures the other tests build cannot show either.
 * The type check is skipped here (TS_NODE_TRANSPILE_ONLY): jest and `cdk synth` already do it.
 */
const ROOT = path.join(__dirname, '..');
const STACKS = ['regional-affinity-data', 'regional-affinity-plan', 'regional-affinity-records',
  'regional-affinity-region-us-east-1', 'regional-affinity-region-us-east-2'];

let out: string;
let manifest: any;

beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-synth-'));
  const result = spawnSync(process.execPath,
    [path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js'), '-P', 'tsconfig.json', '--prefer-ts-exts', 'bin/app.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 100_000,
      env: {
        PATH: process.env.PATH ?? '', HOME: os.tmpdir(),
        CDK_OUTDIR: out, CDK_CONTEXT_JSON: JSON.stringify({ nag: 'true' }), TS_NODE_TRANSPILE_ONLY: 'true',
      },
    });
  if (result.status !== 0) throw new Error(`bin/app.ts failed (${result.status}):\n${result.stdout}${result.stderr}`);
  manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
}, 120_000);

afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

const stackArtifacts = (): Array<[string, any]> =>
  Object.entries<any>(manifest.artifacts).filter(([, a]) => a.type === 'aws:cloudformation:stack');

test('the app synthesizes the five stacks', () => {
  expect(stackArtifacts().map(([name]) => name).sort()).toEqual(STACKS);
});

test('every stack carries the sample tag, which is where cleanup.sh reads it', () => {
  for (const [name, artifact] of stackArtifacts()) {
    expect([name, artifact.properties.tags]).toEqual([name, { [SAMPLE_TAG.key]: SAMPLE_TAG.value }]);
  }
});

test('every stack passes cdk-nag with the suppressions written for its own kind of stack', () => {
  for (const [name, artifact] of stackArtifacts()) {
    const metadata = JSON.parse(fs.readFileSync(path.join(out, artifact.additionalMetadataFile), 'utf8'));
    const findings = Object.values<any[]>(metadata).flat()
      .filter((entry) => entry.type === 'aws:cdk:error' || entry.type === 'aws:cdk:warning')
      .map((entry) => String(entry.data));
    expect([name, findings]).toEqual([name, []]);
  }
});
