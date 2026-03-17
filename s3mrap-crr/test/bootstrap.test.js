"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = __importStar(require("aws-cdk-lib"));
const assertions_1 = require("aws-cdk-lib/assertions");
const bootstrap_stack_1 = require("../lib/bootstrap-stack");
const app = new cdk.App();
const stack = new bootstrap_stack_1.BootstrapStack(app, 'TestBootstrap', {
    project: 's3mrap',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    env: { account: '123456789012', region: 'us-east-1' },
});
const template = assertions_1.Template.fromStack(stack);
test('CodeBuild project exists', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
        Name: 's3mrap-deploy',
    });
});
test('Artifact bucket exists with encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
            ServerSideEncryptionConfiguration: [
                { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } },
            ],
        },
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYm9vdHN0cmFwLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJib290c3RyYXAudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx1REFBa0Q7QUFDbEQsNERBQXdEO0FBRXhELE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBQzFCLE1BQU0sS0FBSyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxHQUFHLEVBQUUsZUFBZSxFQUFFO0lBQ3JELE9BQU8sRUFBRSxRQUFRO0lBQ2pCLGFBQWEsRUFBRSxXQUFXO0lBQzFCLGVBQWUsRUFBRSxXQUFXO0lBQzVCLEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRTtDQUN0RCxDQUFDLENBQUM7QUFDSCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUUzQyxJQUFJLENBQUMsMEJBQTBCLEVBQUUsR0FBRyxFQUFFO0lBQ3BDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyx5QkFBeUIsRUFBRTtRQUN4RCxJQUFJLEVBQUUsZUFBZTtLQUN0QixDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQyx3Q0FBd0MsRUFBRSxHQUFHLEVBQUU7SUFDbEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLGlCQUFpQixFQUFFO1FBQ2hELGdCQUFnQixFQUFFO1lBQ2hCLGlDQUFpQyxFQUFFO2dCQUNqQyxFQUFFLDZCQUE2QixFQUFFLEVBQUUsWUFBWSxFQUFFLFNBQVMsRUFBRSxFQUFFO2FBQy9EO1NBQ0Y7S0FDRixDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuaW1wb3J0IHsgQm9vdHN0cmFwU3RhY2sgfSBmcm9tICcuLi9saWIvYm9vdHN0cmFwLXN0YWNrJztcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbmNvbnN0IHN0YWNrID0gbmV3IEJvb3RzdHJhcFN0YWNrKGFwcCwgJ1Rlc3RCb290c3RyYXAnLCB7XG4gIHByb2plY3Q6ICdzM21yYXAnLFxuICBwcmltYXJ5UmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgc2Vjb25kYXJ5UmVnaW9uOiAndXMtd2VzdC0yJyxcbiAgZW52OiB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH0sXG59KTtcbmNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxudGVzdCgnQ29kZUJ1aWxkIHByb2plY3QgZXhpc3RzJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q29kZUJ1aWxkOjpQcm9qZWN0Jywge1xuICAgIE5hbWU6ICdzM21yYXAtZGVwbG95JyxcbiAgfSk7XG59KTtcblxudGVzdCgnQXJ0aWZhY3QgYnVja2V0IGV4aXN0cyB3aXRoIGVuY3J5cHRpb24nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgIEJ1Y2tldEVuY3J5cHRpb246IHtcbiAgICAgIFNlcnZlclNpZGVFbmNyeXB0aW9uQ29uZmlndXJhdGlvbjogW1xuICAgICAgICB7IFNlcnZlclNpZGVFbmNyeXB0aW9uQnlEZWZhdWx0OiB7IFNTRUFsZ29yaXRobTogJ2F3czprbXMnIH0gfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgfSk7XG59KTtcbiJdfQ==