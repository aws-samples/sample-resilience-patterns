import * as fs from 'fs';
import * as path from 'path';

/**
 * The public workflow YAML carries no AWS account id. The e2e role ARN reads the account from the
 * E2E_ACCOUNT_ID repository variable, so a fork points the same workflows at its own account by
 * setting one variable, and the sample's test account is not part of the published source.
 * The workflows are generated from .projenrc.ts (E2E_ACCOUNT); fix drift there, not in the YAML.
 */
const WORKFLOWS = path.join(__dirname, '..', '..', '.github', 'workflows');
const files = ['drs-ec2-e2e.yml', 'drs-ec2-cleanup.yml', 'drs-ec2-build.yml'];

describe('drs-ec2 GitHub workflows: no account id in the published YAML', () => {
  test.each(files)('%s names no 12-digit account id', (f) => {
    const yaml = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
    expect(yaml).not.toMatch(/\b\d{12}\b/);
  });

  test('the AWS-facing workflows assume the role through the E2E_ACCOUNT_ID variable', () => {
    for (const f of ['drs-ec2-e2e.yml', 'drs-ec2-cleanup.yml']) {
      const yaml = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
      const arns = yaml.match(/role-to-assume: (.*)/g) ?? [];
      expect(arns.length).toBeGreaterThan(0);
      for (const line of arns) {
        expect(line).toBe('role-to-assume: arn:aws:iam::${{ vars.E2E_ACCOUNT_ID }}:role/github-actions-drs-ec2');
      }
    }
  });

  test('the build workflow never touches AWS', () => {
    const yaml = fs.readFileSync(path.join(WORKFLOWS, 'drs-ec2-build.yml'), 'utf8');
    expect(yaml).not.toMatch(/configure-aws-credentials|id-token: write/);
  });

  test('the documented role policy and trust policy keep the ACCOUNT_ID placeholder', () => {
    for (const f of ['github-actions-role-policy.json', 'github-actions-role-trust.json']) {
      const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'iam', f), 'utf8');
      expect(doc).toMatch(/ACCOUNT_ID/);
      expect(doc).not.toMatch(/\b\d{12}\b/);
    }
  });
});
