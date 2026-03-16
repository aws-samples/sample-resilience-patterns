import { awscdk, javascript } from 'projen';

const project = new awscdk.AwsCdkTypeScriptApp({
  name: 's3mrap-crr',
  cdkVersion: '2.200.0',
  defaultReleaseBranch: 'main',
  projenrcTs: true,
  packageManager: javascript.NodePackageManager.NPM,

  deps: ['cdk-nag'],

  appEntrypoint: 'bin/app.ts',
  testdir: 'test',
  srcdir: '.',
  libdir: '.',

  // GitHub Actions are managed at the repo root (.github/workflows/) because
  // this is a monorepo where each subdirectory is a separate sample project.
  // Projen's generated workflows would be placed inside s3mrap-crr/.github/
  // which GitHub ignores — it only reads from the repo root .github/.
  // Each sample has its own build/deploy workflows at the repo root with
  // path filters (e.g. paths: ['s3mrap-crr/**']) so only changed samples
  // are built and deployed.
  github: false,

  eslint: false,
  prettier: false,
  sampleCode: false,

  tsconfig: {
    compilerOptions: {
      rootDir: '.',
    },
  },

  context: {
    '@aws-cdk/core:target-partitions': ['aws'],
  },

  gitignore: [
    'cdk.out.*/',
    '/temporary/',
  ],
});

project.synth();
