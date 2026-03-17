#!/usr/bin/env node

/**
 * Copyright 2025 Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { getConfig } from '../lib/utils/config';
import { NetworkStack } from '../lib/network-stack';

const app = new cdk.App();

// Enable cdk-nag with: -c nag=true
if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

const config = getConfig();

const project = config.appName;
const envName = config.envName;
const accountId = config.awsAccountId;
const primaryRegion = config.primaryRegion.region;
const secondaryRegion = config.secondaryRegion.region;

cdk.Tags.of(app).add('App', project);
cdk.Tags.of(app).add('Env', envName);

// Global nag suppressions for CDK framework internals
const globalSuppressions = [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for Lambda functions' },
  { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for dynamic resource discovery' },
  { id: 'AwsSolutions-L1', reason: 'CDK Provider framework Lambda runtimes are not user-configurable' },
];

function addSuppressions(stack: cdk.Stack, extra: { id: string; reason: string }[] = []) {
  NagSuppressions.addStackSuppressions(stack, [...globalSuppressions, ...extra], true);
}

// --- Primary Region: Network ---
const primaryNetworkStack = new NetworkStack(
  app,
  `${project}-${envName}-${config.primaryRegion.regionPrefix}-network-stack`,
  {
    config,
    regionConfig: config.primaryRegion,
    env: { account: accountId, region: primaryRegion },
  },
);
addSuppressions(primaryNetworkStack);

// --- Secondary Region: Network (with VPC peering to primary) ---
const secondaryNetworkStack = new NetworkStack(
  app,
  `${project}-${envName}-${config.secondaryRegion.regionPrefix}-network-stack`,
  {
    config,
    regionConfig: config.secondaryRegion,
    peerRegionConfig: config.primaryRegion,
    env: { account: accountId, region: secondaryRegion },
  },
);
addSuppressions(secondaryNetworkStack);

// Secondary depends on primary (needs VPC ID secret to be replicated)
secondaryNetworkStack.addDependency(primaryNetworkStack);

app.synth();
