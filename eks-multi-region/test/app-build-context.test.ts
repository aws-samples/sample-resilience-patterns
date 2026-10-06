import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';

// Both region stacks name the app image by fingerprinting src/app, the image's build
// context. Running the app's Python modules locally -- including the jest tests that
// import them -- leaves __pycache__/ in that directory, and while nothing kept it out, the
// bytecode changed the fingerprint: every deploy from a checkout whose tests had run
// rebuilt the image and rolled the pods with no source change, and left the image it
// replaced in ECR, still carrying its scan findings.
//
// src/app/.dockerignore keeps it out. CDK applies that file to the fingerprint and to the
// directory it stages as the build context, so these tests fingerprint a copy of the
// directory the way the region stack does.

const appDir = path.join(__dirname, '..', 'src', 'app');

/** The asset hash the region stack's DockerImageAsset gets for `directory`. */
function imageHash(directory: string): string {
  // CDK caches fingerprints by path and props for the life of the process.
  cdk.AssetStaging.clearAssetHashCache();
  const stack = new cdk.Stack(new cdk.App(), 'AppImageHash');
  return new ecrAssets.DockerImageAsset(stack, 'AppImage', {
    directory,
    platform: ecrAssets.Platform.LINUX_ARM64,
  }).assetHash;
}

describe('the app image build context', () => {
  let context: string;

  beforeEach(() => {
    // A copy of the directory's files only: no bytecode a local run left behind.
    context = fs.mkdtempSync(path.join(os.tmpdir(), 'app-context-'));
    for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        fs.copyFileSync(path.join(appDir, entry.name), path.join(context, entry.name));
      }
    }
  });

  afterEach(() => {
    fs.rmSync(context, { recursive: true, force: true });
  });

  test('Python bytecode does not change the image asset hash', () => {
    const before = imageHash(context);
    fs.mkdirSync(path.join(context, '__pycache__'));
    fs.writeFileSync(path.join(context, '__pycache__', 'server.cpython-312.pyc'), 'bytecode');
    // CPython writes a .pyc under a temporary name (<file>.pyc.<id>) and renames it into
    // place; a write interrupted midway leaves that name behind, which only the directory
    // pattern matches.
    fs.writeFileSync(path.join(context, '__pycache__', 'server.cpython-312.pyc.140339'), 'partial write');
    fs.writeFileSync(path.join(context, 'schema.pyc'), 'bytecode');
    expect(imageHash(context)).toBe(before);
  });

  test('a source change still moves the image asset hash', () => {
    // Without this, the test above would also pass if nothing were fingerprinted.
    const before = imageHash(context);
    fs.appendFileSync(path.join(context, 'server.py'), '\n');
    expect(imageHash(context)).not.toBe(before);
  });
});
