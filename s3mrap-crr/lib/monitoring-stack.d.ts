import * as cdk from 'aws-cdk-lib';
export interface MonitoringStackProps extends cdk.StackProps {
    readonly project: string;
    readonly sourceBucketName: string;
    readonly destBucketName: string;
    readonly replicationRuleId: string;
    readonly sourceRegionLabel: string;
    readonly destRegionLabel: string;
    readonly reverseRuleId: string;
    readonly reverseSourceBucketName: string;
    readonly reverseDestBucketName: string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
    readonly accountId: string;
    readonly mrapAlias: string;
    readonly encryptionKeyArn: string;
}
export declare class MonitoringStack extends cdk.Stack {
    constructor(scope: cdk.App, id: string, props: MonitoringStackProps);
}
