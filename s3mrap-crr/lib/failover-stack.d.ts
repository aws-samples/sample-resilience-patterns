import * as cdk from 'aws-cdk-lib';
export interface FailoverStackProps extends cdk.StackProps {
    readonly project: string;
    readonly primaryBucketName: string;
    readonly secondaryBucketName: string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
    readonly accountId: string;
    readonly mrapName: string;
    readonly primaryRoutingLambdaArn: string;
    readonly secondaryRoutingLambdaArn: string;
}
export declare class FailoverStack extends cdk.Stack {
    constructor(scope: cdk.App, id: string, props: FailoverStackProps);
}
