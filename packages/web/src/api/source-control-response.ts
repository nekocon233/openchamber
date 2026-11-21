import type {
  CI,
  CISummary,
  CiWorkflowRun,
  Project,
  SourceControlIdentity,
  SourceControlUser,
} from '@openchamber/ui/lib/api/types';
import { isExtensionProviderId } from '../../server/lib/source-control/provider-id.js';
import type { SourceControlProviderDescriptor } from '@openchamber/ui/lib/source-control/providers/descriptor';

export interface SourceUserDTO {
  id: string | number;
  provider?: string;
  instance?: string;
  username?: string;
  login?: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

type InstanceFormat = SourceControlProviderDescriptor['instances']['format'];

export const providerInstances = new Map<string, { format: InstanceFormat; label: string; pathStyle: boolean }>();

export const isProjectOwner = (identity: SourceControlIdentity, owner: BoundaryScalar): owner is string => (
  isStringValue(owner)
    && (owner.trim().length > 0 || (owner === '' && providerInstances.get(identity.provider)?.pathStyle !== false))
);

export const parseSourceUser = (user: SourceUserDTO, identity: SourceControlIdentity): SourceControlUser => {
  const username = user?.username || user?.login;
  const validId = isExtensionProviderId(identity.provider)
    ? typeof user?.id === 'string' && user.id.length > 0 && user.id.length <= 256 || isPositiveSafeInteger(user?.id)
    : user && isValidId(user.id);
  if (!user || !validId || !isNonEmptyString(username)
    || !hasCompatibleIdentity(user, identity)
    || (user.avatarUrl !== undefined && !isHttpUrl(user.avatarUrl))
    || (user.name !== undefined && !isStringValue(user.name))
    || (user.email !== undefined && !isStringValue(user.email))) {
    throw new Error('Source control response contained an invalid user');
  }
  const result: SourceControlUser = { ...identity, id: String(user.id), username };
  if (user.avatarUrl) result.avatarUrl = user.avatarUrl;
  if (user.name) result.name = user.name;
  if (user.email) result.email = user.email;
  return result;
};

export const parseSourceProject = (project: Project, identity: SourceControlIdentity): Project => {
  if (!project || !isValidId(project.id) || !isProjectOwner(identity, project.owner) || !isNonEmptyString(project.name)
    || !isHttpUrl(project.url) || !hasMatchingIdentity(project, identity)
    || (project.cloneUrl !== undefined && !isNonEmptyString(project.cloneUrl))
    || (project.sshUrl !== undefined && !isNonEmptyString(project.sshUrl))
    || (project.defaultBranch !== undefined && !isNonEmptyString(project.defaultBranch))
    || (project.defaultBranchSha !== undefined && project.defaultBranchSha !== null && !isNonEmptyString(project.defaultBranchSha))
    || (project.remoteName !== undefined && project.remoteName !== null && !isNonEmptyString(project.remoteName))) {
    throw new Error('Source control response contained an invalid project');
  }
  const result: Project = { ...identity, id: String(project.id), owner: project.owner, name: project.name, url: project.url };
  if (project.cloneUrl) result.cloneUrl = project.cloneUrl;
  if (project.sshUrl) result.sshUrl = project.sshUrl;
  if (project.defaultBranch) result.defaultBranch = project.defaultBranch;
  if (project.defaultBranchSha !== undefined) result.defaultBranchSha = project.defaultBranchSha;
  if (project.remoteName !== undefined) result.remoteName = project.remoteName;
  return result;
};

export const parseSourceCI = (ci: CI | null | undefined, identity: SourceControlIdentity): CI | null => {
  if (ci === null || ci === undefined) return null;
  if (!ci.summary) throw new Error('Source control response contained an invalid CI summary');
  validateCISummary(ci.summary);
  if (ci.runs !== undefined) {
    if (!Array.isArray(ci.runs) || ci.runs.some((run) => !run || !isValidId(run.id)
      || !isNonEmptyString(run.name) || !hasMatchingIdentity(run, identity)
      || (run.detailsUrl !== undefined && !isHttpUrl(run.detailsUrl)))) {
      throw new Error('Source control response contained invalid CI runs');
    }
    for (const run of ci.runs) {
      if ((run.startedAt !== undefined && !isNonEmptyString(run.startedAt))
        || (run.completedAt !== undefined && !isNonEmptyString(run.completedAt))
        || (run.status !== undefined && !isNonEmptyString(run.status))
        || (run.conclusion !== undefined && run.conclusion !== null && !isStringValue(run.conclusion))) {
        throw new Error('Source control response contained invalid CI run fields');
      }
      if (run.application !== undefined && (Object.prototype.toString.call(run.application) !== '[object Object]'
        || (run.application.name !== undefined && !isStringValue(run.application.name))
        || (run.application.slug !== undefined && !isStringValue(run.application.slug)))) {
        throw new Error('Source control response contained an invalid CI application');
      }
      if (run.job !== undefined && (Object.prototype.toString.call(run.job) !== '[object Object]'
        || (run.job.runId !== undefined && !isValidId(run.job.runId))
        || (run.job.jobId !== undefined && !isValidId(run.job.jobId))
        || (run.job.url !== undefined && !isHttpUrl(run.job.url))
        || (run.job.name !== undefined && !isStringValue(run.job.name))
        || (run.job.workflowName !== undefined && !isStringValue(run.job.workflowName))
        || (run.job.runnerName !== undefined && !isStringValue(run.job.runnerName))
        || (run.job.conclusion !== undefined && run.job.conclusion !== null && !isStringValue(run.job.conclusion)))) {
        throw new Error('Source control response contained an invalid CI job');
      }
      if (run.job?.steps !== undefined && (!Array.isArray(run.job.steps) || run.job.steps.some((step) => !step
        || !isNonEmptyString(step.name)
        || (step.status !== undefined && !isStringValue(step.status))
        || (step.conclusion !== undefined && step.conclusion !== null && !isStringValue(step.conclusion))
        || (step.number !== undefined && (!Number.isInteger(step.number) || step.number < 0))
        || (step.startedAt !== undefined && !isNonEmptyString(step.startedAt))
        || (step.completedAt !== undefined && !isNonEmptyString(step.completedAt))))) {
        throw new Error('Source control response contained invalid CI steps');
      }
      if (run.output !== undefined && (Object.prototype.toString.call(run.output) !== '[object Object]'
        || (run.output.title !== undefined && !isStringValue(run.output.title))
        || (run.output.summary !== undefined && !isStringValue(run.output.summary))
        || (run.output.text !== undefined && !isStringValue(run.output.text)))) {
        throw new Error('Source control response contained invalid CI output');
      }
      if (run.annotations !== undefined && (!Array.isArray(run.annotations) || run.annotations.some((annotation) => !annotation
        || !isNonEmptyString(annotation.message)
        || (annotation.path !== undefined && !isStringValue(annotation.path))
        || (annotation.startLine !== undefined && (!Number.isInteger(annotation.startLine) || annotation.startLine < 0))
        || (annotation.endLine !== undefined && (!Number.isInteger(annotation.endLine) || annotation.endLine < 0))
        || (annotation.level !== undefined && !isStringValue(annotation.level))
        || (annotation.title !== undefined && !isStringValue(annotation.title))
        || (annotation.rawDetails !== undefined && !isStringValue(annotation.rawDetails))))) {
        throw new Error('Source control response contained invalid CI annotations');
      }
    }
  }
  return {
    summary: {
      state: ci.summary.state,
      total: ci.summary.total,
      success: ci.summary.success,
      failure: ci.summary.failure,
      pending: ci.summary.pending,
      inProgress: ci.summary.inProgress,
      queued: ci.summary.queued,
      startedAt: ci.summary.startedAt,
    },
    runs: ci.runs?.map((run) => ({
      ...identity,
      id: String(run.id),
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      detailsUrl: run.detailsUrl,
      application: run.application,
      job: run.job,
      output: run.output,
      annotations: run.annotations,
    })),
  };
};

export const parseCiWorkflowRun = (run: CiWorkflowRun, identity: SourceControlIdentity): CiWorkflowRun => {
  if (!run
    || !isValidId(run.id)
    || !isPositiveSafeInteger(run.runNumber)
    || !isPositiveSafeInteger(run.runAttempt)
    || !isNonEmptyString(run.workflowName)
    || !isNonEmptyString(run.title)
    || !isNonEmptyString(run.status)
    || (run.conclusion !== null && !isNonEmptyString(run.conclusion))
    || !isNonEmptyString(run.event)
    || (run.headBranch !== null && !isNonEmptyString(run.headBranch))
    || !isNonEmptyString(run.headSha)
    || !isHttpUrl(run.url)
    || !hasMatchingIdentity(run, identity)
    || (run.commitMessage !== undefined && !isStringValue(run.commitMessage))
    || (run.createdAt !== undefined && !isNonEmptyString(run.createdAt))
    || (run.updatedAt !== undefined && !isNonEmptyString(run.updatedAt))
    || (run.startedAt !== undefined && !isNonEmptyString(run.startedAt))
    || (run.completedAt !== undefined && !isNonEmptyString(run.completedAt))
    || !Array.isArray(run.pullRequests)
    || run.pullRequests.some((pr) => !pr || !isPositiveSafeInteger(pr.number) || !isHttpUrl(pr.url))) {
    throw new Error('Source control response contained an invalid CI workflow run');
  }
  if (run.jobSummary !== undefined) validateCISummary(run.jobSummary);
  const result: CiWorkflowRun = {
    ...identity,
    id: String(run.id),
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
    project: parseSourceProject(run.project, identity),
    workflowName: run.workflowName,
    title: run.title,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    headBranch: run.headBranch,
    headSha: run.headSha,
    url: run.url,
    actor: run.actor ? parseSourceUser(run.actor, identity) : null,
    pullRequests: run.pullRequests.map((pr) => ({ number: pr.number, url: pr.url })),
  };
  if (run.commitMessage !== undefined) result.commitMessage = run.commitMessage;
  if (run.createdAt) result.createdAt = run.createdAt;
  if (run.updatedAt) result.updatedAt = run.updatedAt;
  if (run.startedAt) result.startedAt = run.startedAt;
  if (run.completedAt) result.completedAt = run.completedAt;
  if (run.jobSummary) {
    result.jobSummary = {
      state: run.jobSummary.state,
      total: run.jobSummary.total,
      success: run.jobSummary.success,
      failure: run.jobSummary.failure,
      pending: run.jobSummary.pending,
      inProgress: run.jobSummary.inProgress,
      queued: run.jobSummary.queued,
      startedAt: run.jobSummary.startedAt,
    };
  }
  return result;
};

export type BoundaryScalar = string | number | boolean | null | undefined;

export const isStringValue = (value: BoundaryScalar): value is string => Object.prototype.toString.call(value) === '[object String]';

export const isNumberValue = (value: BoundaryScalar): value is number => Object.prototype.toString.call(value) === '[object Number]';

export const isNonEmptyString = (value: BoundaryScalar): value is string => isStringValue(value) && value.trim().length > 0;

export const isPositiveSafeInteger = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isSafeInteger(value) && value >= 1;

export const isValidId = (value: string | number | undefined): boolean => isNonEmptyString(value) || Number.isFinite(value);

export const isHttpUrl = (value: BoundaryScalar): value is string => {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

export const hasMatchingIdentity = (
  value: { provider?: string; instance?: string } | null | undefined,
  identity: SourceControlIdentity,
): boolean => value?.provider === identity.provider && value.instance === identity.instance;

const hasCompatibleIdentity = (
  value: { provider?: string; instance?: string },
  identity: SourceControlIdentity,
): boolean => value.provider === undefined && value.instance === undefined
  ? true
  : hasMatchingIdentity(value, identity);

const validateCISummary = (summary: CISummary | CI['summary']): void => {
  if (!['success', 'failure', 'pending', 'unknown'].includes(summary.state)
    || !Number.isInteger(summary.total) || summary.total < 0
    || !Number.isInteger(summary.success) || summary.success < 0
    || !Number.isInteger(summary.failure) || summary.failure < 0
    || !Number.isInteger(summary.pending) || summary.pending < 0
    || (summary.inProgress !== undefined && (!Number.isInteger(summary.inProgress) || summary.inProgress < 0))
    || (summary.queued !== undefined && (!Number.isInteger(summary.queued) || summary.queued < 0))
    || (summary.startedAt !== undefined && !isNonEmptyString(summary.startedAt))) {
    throw new Error('Source control response contained an invalid CI summary');
  }
};
