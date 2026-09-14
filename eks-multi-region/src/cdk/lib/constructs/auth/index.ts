/**
 * Auth pattern family barrel (authentication-changeset §2).
 *
 * M1c ships the always-on baseline {@link AllowedCidrSecurityGroup}. M6 adds the on-demand
 * Cognito constructs: the shared {@link CognitoAuthConstruct} (user pool + client + optional
 * hosted-UI domain + OIDC no-op seam), and the two front-end variants
 * {@link CognitoAlbAuthConstruct} (ALB authenticate-cognito) and
 * {@link CognitoApiGwAuthConstruct} (HTTP API JWT authorizer + /amplify-config).
 */
export * from './allowed-cidr-security-group.js';
export * from './oidc-federation-props.js';
export * from './cognito-auth-construct.js';
export * from './cognito-alb-auth-construct.js';
export * from './cognito-apigw-auth-construct.js';
