/**
 * Copyright 2025 Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

export interface RegionConfig {
  readonly region: string;
  readonly regionPrefix: string;
  readonly vpcCidr: string;
  readonly isPrimary: boolean;
}

export interface AppConfig {
  readonly appName: string;
  readonly envName: string;
  readonly awsAccountId: string;
  readonly awsDefaultRegion: string;
  readonly primaryRegion: RegionConfig;
  readonly secondaryRegion: RegionConfig;
}

export function getConfig(): AppConfig {
  const env = typeof process !== 'undefined' ? process.env : {};
  const primaryRegion = env.PRIMARY_REGION || 'us-east-1';
  const secondaryRegion = env.SECONDARY_REGION || 'us-west-2';
  const awsAccountId = env.AWS_ACCOUNT_ID || env.CDK_DEFAULT_ACCOUNT || '';

  return {
    appName: env.APP_NAME || 'msk-crr',
    envName: env.ENV_NAME || 'demo',
    awsAccountId,
    awsDefaultRegion: primaryRegion,
    primaryRegion: {
      region: primaryRegion,
      regionPrefix: 'primary',
      vpcCidr: env.PRIMARY_VPC_CIDR || '10.0.0.0/16',
      isPrimary: true,
    },
    secondaryRegion: {
      region: secondaryRegion,
      regionPrefix: 'secondary',
      vpcCidr: env.SECONDARY_VPC_CIDR || '10.1.0.0/16',
      isPrimary: false,
    },
  };
}
