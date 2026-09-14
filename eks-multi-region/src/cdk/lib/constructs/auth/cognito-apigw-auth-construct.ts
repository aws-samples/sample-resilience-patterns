import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { CognitoAuthConstruct } from './cognito-auth-construct.js';

/**
 * Props for {@link CognitoApiGwAuthConstruct} (authentication-changeset §2.4 / §3b).
 */
export interface CognitoApiGwAuthProps {
  /** Shared Cognito construct — public SPA client (`generateClientSecret: false`). */
  readonly auth: CognitoAuthConstruct;
  /** HTTP API the authorizer attaches to (business routes are added by the caller). */
  readonly httpApi: apigwv2.HttpApi;
  /** Authorizer name. Default 'CognitoJwtAuthorizer'. */
  readonly authorizerName?: string;
  /**
   * Add the public `GET /amplify-config` runtime-config route (Lambda returning
   * `{ region, userPoolId, appClientId }`). Default true. Set false to opt for the
   * deploy-time S3 `config.json` delivery alternative (documented in §2.4).
   */
  readonly addAmplifyConfigRoute?: boolean;
  /** Path for the runtime-config route. Default '/amplify-config'. */
  readonly amplifyConfigPath?: string;
}

/**
 * Variant B — API Gateway (HTTP API) Cognito JWT authorizer + `/amplify-config` runtime
 * config (authentication-changeset §2.4).
 *
 * Designed fresh — makes real the commented-out `HttpUserPoolAuthorizer` line from the
 * reinvent-agents-workshop precedent. The SPA runs the Cognito/Amplify login (public
 * client, NO hosted UI required) and sends `Authorization: Bearer <jwt>`; the authorizer
 * validates the JWT against the shared user pool.
 *
 * Caller usage for protected routes:
 * ```ts
 * httpApi.addRoutes({ path: '/api/...', methods: [...], integration, authorizer: c.authorizer });
 * ```
 *
 * The `/amplify-config` route is created here (PUBLIC, no authorizer) so the static SPA
 * bundle discovers the Cognito IDs at runtime — decoupling the build from per-deploy /
 * per-account IDs. If the API is CloudFront-fronted, add the `Authorization`-header cache
 * policy (changeset §2.4) so the bearer token is not stripped before reaching API GW.
 */
export class CognitoApiGwAuthConstruct extends Construct {
  /** Pass to `httpApi.addRoutes({ authorizer })` for protected routes. */
  public readonly authorizer: authorizers.HttpUserPoolAuthorizer;
  /** Present iff the `/amplify-config` route was created. */
  public readonly amplifyConfigFunction?: lambda.Function;

  constructor(scope: Construct, id: string, props: CognitoApiGwAuthProps) {
    super(scope, id);

    // Exactly the commented-out line at apigatewayv2-cloudfront-construct.ts:75, now real.
    this.authorizer = new authorizers.HttpUserPoolAuthorizer(
      props.authorizerName ?? 'CognitoJwtAuthorizer',
      props.auth.userPool,
      { userPoolClients: [props.auth.userPoolClient] },
    );

    if (props.addAmplifyConfigRoute ?? true) {
      this.amplifyConfigFunction = new lambda.Function(this, 'AmplifyConfigFn', {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, 'amplify-config', 'lambda')),
        timeout: cdk.Duration.seconds(10),
        environment: {
          REGION: cdk.Stack.of(this).region,
          USER_POOL_ID: props.auth.userPool.userPoolId,
          APP_CLIENT_ID: props.auth.userPoolClient.userPoolClientId,
        },
      });

      props.httpApi.addRoutes({
        path: props.amplifyConfigPath ?? '/amplify-config',
        methods: [apigwv2.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration(
          'AmplifyConfigIntegration',
          this.amplifyConfigFunction,
        ),
        // Intentionally PUBLIC: returns non-secret, client-discoverable identifiers.
      });
    }
  }
}
