import * as fs from 'fs';
import * as path from 'path';

const appDir = path.join(__dirname, '..', 'src', 'app');

describe('the app image base', () => {
  // The image is rebuilt only when its build context changes, so a base named by tag alone
  // stayed at whatever the tag pointed at on the last source change and never picked up a
  // base-image fix. A digest pin makes the bump a one-line change that moves the fingerprint.
  // This keeps the pin from sliding back to a bare tag.
  test('every FROM pins its base image by digest', () => {
    const dockerfile = fs.readFileSync(path.join(appDir, 'Dockerfile'), 'utf8');
    const froms = dockerfile.split('\n').filter((line) => /^FROM\s/i.test(line));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) {
      expect(from).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}(\s|$)/i);
    }
  });
});
