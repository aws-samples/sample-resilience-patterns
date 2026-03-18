import { awscdk, javascript } from 'projen';

const project = new awscdk.AwsCdkTypeScriptApp({
  name: 'aurora-dsql',
  cdkVersion: '2.200.0',
  defaultReleaseBranch: 'main',
  projenrcTs: true,
  packageManager: javascript.NodePackageManager.NPM,

  deps: ['cdk-nag'],

  appEntrypoint: 'bin/app.ts',
  testdir: 'test',
  srcdir: '.',
  libdir: '.',

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
