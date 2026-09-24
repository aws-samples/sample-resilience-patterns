/**
 * Auth pattern family barrel.
 *
 * Ships the always-on baseline {@link AllowedCidrSecurityGroup}, which gates the EKS
 * API private endpoint. Operator access to the Argo CD UI and the cockpit does not go
 * through an identity provider at all: it is an SSM Session Manager port-forward from
 * the observer bastion (src/cdk/lib/observer-stack.ts, build/tunnel.sh), so IAM is the
 * only identity in the path and there is no public ingress to authenticate.
 */
export * from './allowed-cidr-security-group.js';
