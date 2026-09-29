/**
 * Installer simulation — the gate that replays the SYNTHESIZED installer buildspec
 * against a modeled cluster, locally, before any merge/deploy cycle is spent.
 *
 * Exists because of 2026-09-02: three consecutive main-pipeline deploys failed, each one
 * layer past the last (caBundle patch selecting nothing -> zonal-shift prerequisite
 * violated -> hostname wait losing a race with LBC backoff), each invisible to synth,
 * cfn-lint, and every unit test, and each costing a ~40-minute cycle plus live outage
 * time. The simulator has been proven to reproduce all three with the same failure
 * signatures the real cluster produced (see build/simulate-installer.py header).
 *
 * The sim consumes cdk.out (bug class 1: validate the GENERATED artifact). Both the
 * local gate (postCompile synth) and CI (ci:build:cdk synth:silent) produce it before
 * jest runs. A missing template is a hard failure, never a skip — a skipped gate is
 * how gates die.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('installer simulation (generated buildspec vs modeled cluster)', () => {
  const template = path.join(__dirname, '..', 'cdk.out', 'eks-mr-demo-region-us-east-2.template.json');

  test('all scenarios pass: fresh install, D6 migration, idempotent rerun', () => {
    expect({ template, synthesized: fs.existsSync(template) })
      .toEqual({ template, synthesized: true });
    const out = execSync(
      `python3 ${path.join(__dirname, '..', 'build', 'simulate-installer.py')}`,
      { encoding: 'utf8', cwd: path.join(__dirname, '..'), timeout: 240_000 },
    );
    expect(out).toContain('scenario fresh: OK');
    expect(out).toContain('scenario migration: OK');
    expect(out).toContain('scenario rerun: OK (2 pass(es)');
    expect(out).toContain('ALL SCENARIOS PASSED');
  }, 300_000);
});
