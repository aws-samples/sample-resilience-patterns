// Barrel for the GitLab tree's projenrc customizations. Keeps .projenrc.ts thin —
// import the factories from here and call them.
//
// `./tasks` is the provider-agnostic tasks module copied from skeleton/_shared/
// at scaffold time (the recipe copies _shared/projenrc/tasks/ → projenrc/tasks/).
// `./workflows/gitlab-workflow` is GitLab-specific.
export { createBuildTasks, createDeployTasks } from './tasks';
export { createGitlabWorkflow } from './workflows/gitlab-workflow';
