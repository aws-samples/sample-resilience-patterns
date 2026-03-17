import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { AppConfig } from '../lib/utils/config';

const testConfig: AppConfig = {
  appName: 'msk-crr',
  envName: 'test',
  awsAccountId: '123456789012',
  awsDefaultRegion: 'us-east-1',
  primaryRegion: {
    region: 'us-east-1',
    regionPrefix: 'primary',
    vpcCidr: '10.0.0.0/16',
    isPrimary: true,
  },
  secondaryRegion: {
    region: 'us-west-2',
    regionPrefix: 'secondary',
    vpcCidr: '10.1.0.0/16',
    isPrimary: false,
  },
};

test('Primary network stack creates VPC and MSK security group', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'test-primary-network', {
    config: testConfig,
    regionConfig: testConfig.primaryRegion,
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for MSK cluster',
  });
});
