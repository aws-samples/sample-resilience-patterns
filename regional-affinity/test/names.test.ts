import { execFileSync } from 'child_process';
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
  expect(recordNames('ingest', 'demo.io', ['us-east-1', 'us-east-2'])).toEqual({
    regionLess: 'ingest.demo.io',
    regional: { 'us-east-1': 'ingest.ue1.demo.io', 'us-east-2': 'ingest.ue2.demo.io' },
    app: { 'us-east-1': 'ingest-app.ue1.demo.io', 'us-east-2': 'ingest-app.ue2.demo.io' },
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
  expect(checkDomain('demo.io')).toBe('demo.io');
  expect(() => checkDomain('Demo.io')).toThrow();
  expect(() => checkDomain('demo')).toThrow();
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
    expect(python({})).toEqual(recordNames('ingest', 'demo.io', ['us-east-1', 'us-east-2']));
  });

  test('with other Regions, domain and label', () => {
    const env = { REGIONS: 'eu-west-1,eu-central-1', DOMAIN: 'example.internal', APP_LABEL: 'orders' };
    expect(python(env)).toEqual(recordNames('orders', 'example.internal', ['eu-west-1', 'eu-central-1']));
  });
});
