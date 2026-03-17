import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
export interface KmsStackProps extends cdk.StackProps {
    readonly project: string;
}
export declare class KmsStack extends cdk.Stack {
    readonly key: kms.Key;
    constructor(scope: cdk.App, id: string, props: KmsStackProps);
}
export interface KmsReplicaStackProps extends cdk.StackProps {
    readonly project: string;
    readonly primaryKeyArn: string;
    readonly accountId: string;
}
export declare class KmsReplicaStack extends cdk.Stack {
    readonly replicaKeyArn: string;
    constructor(scope: cdk.App, id: string, props: KmsReplicaStackProps);
}
