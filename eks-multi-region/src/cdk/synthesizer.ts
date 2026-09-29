import * as cdk from 'aws-cdk-lib';

/**
 * Workshop-style synthesizer. Shared by `src/cdk/app.ts` and the tests.
 *
 * Extracted into its own module deliberately. A test that builds stacks WITHOUT this
 * synthesizer synthesizes a materially different template — the default synthesizer
 * injects a `BootstrapVersion` parameter and a bootstrap version rule that the real
 * deploy never sees — so it would assert against a template that does not exist. A
 * fixture claiming to mirror the deployed artifact has to actually mirror it, and the
 * only reliable way is for both callers to use one definition.
 *
 * ONE SYNTHESIZER PER STACK: this is a factory, not a constant, because CDK mutates
 * synthesizers during synth and they cannot be shared between stacks.
 *
 * The `${AssetsBucketName}/${AssetsBucketPrefix}` placeholders are substituted by
 * `build/package.py` before `aws cloudformation deploy`, so the template targets the
 * uploaded S3 prefix. Those references only appear when a stack owns file assets, which
 * is why every stack declares both as CfnParameters explicitly.
 */
export const makeSynthesizer = (): cdk.IStackSynthesizer =>
  new cdk.DefaultStackSynthesizer({
    fileAssetsBucketName: '${AssetsBucketName}',
    bucketPrefix: '${AssetsBucketPrefix}',
    qualifier: undefined,
    generateBootstrapVersionRule: false,
  });
