import * as cdk from 'aws-cdk-lib';
export interface GlobalRoutingStackProps extends cdk.StackProps {
    readonly project: string;
    readonly primaryBucketName: string;
    readonly secondaryBucketName: string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
    readonly accountId: string;
}
export declare class GlobalRoutingStack extends cdk.Stack {
    readonly mrapAlias: string;
    constructor(scope: cdk.App, id: string, props: GlobalRoutingStackProps);
}
