// Barrel for the provider-agnostic projen task factories.
//
// Lives once in skeleton/_shared/projenrc/tasks/ and is copied (not symlinked) into
// BOTH the CI-provider trees at scaffold time, matching the construct-copy /
// self-containment model. Both providers' .projenrc.ts import these factories; the
// only provider divergence is the workflow module + the `github` boolean.
export { createBuildTasks } from './build-tasks';
export { createDeployTasks } from './deploy-tasks';
