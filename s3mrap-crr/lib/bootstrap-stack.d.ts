import * as cdk from 'aws-cdk-lib';
export interface BootstrapStackProps extends cdk.StackProps {
    readonly project: string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
}
export declare class BootstrapStack extends cdk.Stack {
    constructor(scope: cdk.App, id: string, props: BootstrapStackProps);
}
