import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { checkDomain, checkLabel, checkProject, parseRegions, recordNames, regionLabel } from '../lib/names';

describe('region labels', () => {
  test.each([
    ['us-east-1', 'ue1'], ['us-west-2', 'uw2'], ['eu-central-1', 'ec1'], ['ap-southeast-2', 'as2'], ['us-gov-west-1', 'ugw1'],
  ])('%s is %s', (region, label) => expect(regionLabel(region)).toBe(label));

  test.each(['useast1', 'us-east', 'US-EAST-1', 'us-east-x', ''])('rejects %p', (bad) => {
    expect(() => regionLabel(bad)).toThrow(/not an AWS Region name/);
  });
});

test('record names for the defaults', () => {
  expect(recordNames('ingest', 'example.com', ['us-east-1', 'us-east-2'])).toEqual({
    regionLess: 'ingest.example.com',
    regional: { 'us-east-1': 'ingest.ue1.example.com', 'us-east-2': 'ingest.ue2.example.com' },
    app: { 'us-east-1': 'ingest-app.ue1.example.com', 'us-east-2': 'ingest-app.ue2.example.com' },
  });
});

test('regions must be two, distinct, with distinct labels', () => {
  expect(parseRegions(' us-east-1 , us-west-2 ')).toEqual(['us-east-1', 'us-west-2']);
  expect(() => parseRegions('us-east-1')).toThrow(/exactly two/);
  expect(() => parseRegions('us-east-1,us-east-2,us-west-2')).toThrow(/exactly two/);
  expect(() => parseRegions('us-east-1,us-east-1')).toThrow(/different labels/);
  expect(() => parseRegions('ap-south-1,ap-southeast-1')).toThrow(/different labels/); // both "as1"
});

test('project, label and domain checks', () => {
  expect(checkProject('regional-affinity-abc123')).toBe('regional-affinity-abc123'); // the e2e's 24 characters
  expect(() => checkProject('regional-affinity-abc1234')).toThrow();
  expect(() => checkProject('Regional')).toThrow();
  expect(checkLabel('ingest')).toBe('ingest');
  expect(() => checkLabel('in.gest')).toThrow();
  expect(checkDomain('example.com')).toBe('example.com');
  expect(() => checkDomain('Demo.io')).toThrow();
  expect(() => checkDomain('demo')).toThrow();
});

describe('the project name is also the plan name, which must end in a letter or digit', () => {
  test.each(['ab', 'a1', 'demo-1', 'a-b-c', 'a'.repeat(24), 'regional-affinity'])('%p is accepted', (project) => {
    expect(checkProject(project)).toBe(project);
  });

  test.each(['demo-', 'a-', 'regional-affinity-', 'a'.repeat(23) + '-', 'a', '', '-demo', '1demo', 'a'.repeat(25), 'Demo', 'de mo', 'de_mo'])(
    '%p is refused', (project) => {
      expect(() => checkProject(project)).toThrow(/2 to 24 lowercase letters, digits and hyphens/);
    });
});

/**
 * The e2e names every run's stacks `regional-affinity-<first N characters of the commit>`. The
 * workflow is generated from .projenrc.ts, so N is only in the workflow file: if it grew past what
 * checkProject accepts, the first live run would fail at synth.
 */
test('the longest project name the e2e workflow builds is one checkProject accepts', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'regional-affinity-e2e.yml'), 'utf8');
  const [, prefix, length] = workflow.match(/PROJECT=([a-z-]+)-\$\(echo \$HEAD_SHA \| cut -c1-(\d+)\)/) ?? [];
  expect(prefix).toBe('regional-affinity');
  const longest = `${prefix}-${'f'.repeat(Number(length))}`; // a commit SHA is hexadecimal: it ends in a letter or digit
  expect(longest.length).toBeLessThanOrEqual(24);
  expect(checkProject(longest)).toBe(longest);
});

/**
 * scripts/demo.py derives the same names from the same settings (it is standard-library Python and
 * cannot import lib/names.ts). A rule change on one side only would make the operator script look
 * for records that do not exist.
 */
describe('scripts/demo.py derives the same names', () => {
  const python = (env: Record<string, string>) => JSON.parse(execFileSync('python3',
    [path.join(__dirname, '..', 'scripts', 'demo.py'), 'names', '--json'],
    { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' }));

  test('with the defaults', () => {
    expect(python({})).toEqual(recordNames('ingest', 'example.com', ['us-east-1', 'us-east-2']));
  });

  test('with other Regions, domain and label', () => {
    const env = { REGIONS: 'eu-west-1,eu-central-1', DOMAIN: 'example.internal', APP_LABEL: 'orders' };
    expect(python(env)).toEqual(recordNames('orders', 'example.internal', ['eu-west-1', 'eu-central-1']));
  });
});
