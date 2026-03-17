import * as cdk from 'aws-cdk-lib';
export interface RoutingLambdaStackProps extends cdk.StackProps {
    readonly project: string;
    readonly primaryBucketName: string;
    readonly secondaryBucketName: string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
    readonly accountId: string;
    readonly mrapName: string;
    readonly mrapAlias: string;
}
export declare class RoutingLambdaStack extends cdk.Stack {
    readonly functionArn: string;
    constructor(scope: cdk.App, id: string, props: RoutingLambdaStackProps);
}
