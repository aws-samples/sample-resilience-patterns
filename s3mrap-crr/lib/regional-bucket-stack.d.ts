import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
export interface RegionalBucketStackProps extends cdk.StackProps {
    readonly project: string;
}
export declare class RegionalBucketStack extends cdk.Stack {
    readonly bucket: s3.Bucket;
    constructor(scope: cdk.App, id: string, props: RegionalBucketStackProps);
}
