import type {
  GitTransportBindingIntent,
  GitTransportBindingResult,
  GitTransportBindingRemovalIntent,
  GitTransportBindingRemovalResult,
  GitAuxiliaryBindingIntent,
  GitAuxiliaryBindingResult,
  ChangeRequest,
  ChangeRequestCommit,
  ChangeRequestContext,
  ChangeRequestLocalRevision,
  ChangeRequestReviewComment,
  ChangeRequestRevision,
  ChangeRequestSubmitRequirement,
  ChangeRequestVerdict,
  ChangeRequestVote,
  ChangeRequestVoteLabel,
  PullRequestStack,
  ChangeRequestStatus,
  CiJobLogResult,
  CiRunStatusFilter,
  CiWorkflowRunDetail,
  CiWorkflowRunPage,
  Issue,
  IssueComment,
  CreateChangeRequestInput,
  MergeChangeRequestInput,
  PageResult,
  ProjectUpstream,
  ReadyChangeRequestInput,
  DraftChangeRequestInput,
  CommentInput,
  CommentUpdateInput,
  CommentDeleteInput,
  DiscussionCloseReason,
  DiscussionCommentInput,
  ReviewChangeRequestInput,
  ReviewCommentDeleteInput,
  ReviewCommentInput,
  ReviewCommentUpdateInput,
  ReviewDiscardInput,
  SetDiscussionAnswerInput,
  SetDiscussionStateInput,
  SetStateInput,
  SetLabelsInput,
  SetReviewersInput,
  ThreadReplyInput,
  ThreadResolveInput,
  SourceControlAPI,
  SourceControlAuthAccount,
  SourceControlAuthStatus,
  SourceControlCapabilities,
  SourceControlDeviceFlowComplete,
  SourceControlDeviceFlowStart,
  SourceControlIdentity,
  SourceControlEmptyMutationResult,
  SourceControlCreateMutationTarget,
  SourceControlExistingMutationTarget,
  SourceControlExpectedMutationTarget,
  SourceControlCreateMutationResult,
  SourceControlMergeMutationResult,
  SourceControlMutationContext,
  SourceControlMutationReceipt,
  SourceControlReadyMutationResult,
  SourceControlDraftMutationResult,
  SourceControlReviewMutationResult,
  SourceControlStateMutationResult,
  SourceControlResolvedMutationTarget,
  SourceControlBindingRead,
  SourceControlRepositoryBinding,
  SourceControlRepositoryBindingResetIntent,
  SourceControlRepositoryContext,
  SourceControlRepositoryRemote,
  SourceControlReadContext,
  UpdateChangeRequestInput,
  UpdateIssueInput,
  UpdateDiscussionInput,
  Label,
  RepositoryReferenceReviewer,
  RepositorySelector,
} from '@openchamber/ui/lib/api/types';
import { SourceControlInstanceAliasError, SourceControlInstanceOtherProviderError } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { isSafeRepositoryEndpoint, parseBindingResponse, resolveBindingReadiness } from '../../server/lib/source-control/binding-contract.js';
import { isProviderUserId } from '../../server/lib/source-control/provider-id.js';
import type { SourceControlProviderDescriptor } from '@openchamber/ui/lib/source-control/providers/descriptor';
import { fetchChangeRequestListStatuses, fetchChangeRequestReviewState, fetchRepositoryReferenceDetail, fetchRepositoryReferences, fetchRepositoryReferencesAcross } from './repository-references';
import { BUILT_IN_SOURCE_CONTROL_PROVIDERS, fetchSourceControlProviders, providerPath } from './source-control-providers';
import { githubPendingReviewStateSchema, type GitHubPendingReviewAction } from '@openchamber/ui/lib/source-control/pendingReview';
import { changeRequestFileStatsSchema } from '@openchamber/ui/lib/source-control/fileStats';
import type { SourceUserDTO, BoundaryScalar } from './source-control-response';
import {
  providerInstances,
  isProjectOwner,
  parseSourceUser,
  parseSourceProject,
  parseSourceCI,
  parseCiWorkflowRun,
  isStringValue,
  isNumberValue,
  isNonEmptyString,
  isPositiveSafeInteger,
  isValidId,
  isHttpUrl,
  hasMatchingIdentity,
} from './source-control-response';

interface ErrorResponse {
  error?: string;
  code?: string;

  provider?: string;
}

class SourceControlRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

interface SourceControlInstancesResponse extends ErrorResponse {
  instances: SourceControlIdentity[];
}

interface RepositoryContextDTO extends ErrorResponse {
  supported?: boolean;
  repositoryId: string;
  configRevision: string;
  bare: boolean;
  remotes: SourceControlRepositoryRemote[];
}

interface RepositoryBindingDTO extends ErrorResponse {
  repository: RepositoryContextDTO;
  revision: number;
  binding: SourceControlRepositoryBinding | null;
}

interface BranchesDTO {
  branches?: string[];
}

interface DeviceFlowStartDTO {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
}

type DeviceFlowCompleteDTO =
  | { connected: true; user: SourceUserDTO; scope?: string }
  | { connected: false; status?: string; error?: string };

type DisconnectedSourceControlAuthStatus = Extract<SourceControlAuthStatus, { status: 'disconnected' }>;
type ProviderAuthStatusDTO = SourceControlAuthStatus | {
  connected: false;
  status?: undefined;
  accounts?: SourceControlAuthAccount[];
  cli?: DisconnectedSourceControlAuthStatus['cli'];
};

type MutationBody<TTarget extends SourceControlExpectedMutationTarget = SourceControlExpectedMutationTarget> = SourceControlMutationContext<TTarget>;

interface CreateBody extends MutationBody<SourceControlCreateMutationTarget> {
  title: string;
  body?: string;
  draft?: boolean;
  remote?: string;
  headRemote?: string;
}

interface UpdateBody extends MutationBody<SourceControlExistingMutationTarget> {
  title: string;
  body?: string;
}

interface MutationReceiptDTO extends ErrorResponse {
  status: string;
  actor: { provider: string; instance: string; providerAccountId: string };
  target: {
    repositoryId: string;
    bindingRevision: number;
    primaryRemote: string;
    project: { id: string; owner: string; name: string };
    number?: number;
    head?: string;
    base?: string;
    headSha?: string;
  };
  replayed: boolean;
  result: MutationResultDTO;
}

interface MutationResultDTO {
  merged?: boolean;
  message?: string;
  outcome?: string;
  stacked?: boolean;
  ready?: boolean;
  draft?: boolean;
  commented?: boolean;
  state?: string;
}

type ReviewBody = MutationBody<SourceControlExistingMutationTarget> & { body?: string } & (
  | { verdict: NonNullable<ReviewChangeRequestInput['verdict']> }
  | { votes: Record<string, number>; publishDrafts?: boolean }
);

type SourceControlFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;
type PostBody =
  | { flowId: string }
  | { token: string; username?: string }
  | { sshUrl: string | null }
  | { accountId: string }
  | { disabled: boolean }
  | CreateBody
  | UpdateBody
  | (MutationBody<SourceControlExistingMutationTarget> & { method: MergeChangeRequestInput['method']; cancel?: boolean; force?: boolean })
  | (MutationBody<SourceControlExistingMutationTarget> & { body: string })
  | (MutationBody<SourceControlExistingMutationTarget> & { threadId: string; body: string })
  | (MutationBody<SourceControlExistingMutationTarget> & { threadId: string; resolved: boolean })
  | (MutationBody<SourceControlExistingMutationTarget> & { state: SetStateInput['state'] })
  | (MutationBody<SourceControlExistingMutationTarget> & { labels: string[] })
  | (MutationBody<SourceControlExistingMutationTarget> & { reviewers: string[] })
  | (MutationBody<SourceControlExistingMutationTarget> & { body: string; replyTo?: string })
  | (MutationBody<SourceControlExistingMutationTarget> & { state: SetDiscussionStateInput['state']; reason?: DiscussionCloseReason })
  | (MutationBody<SourceControlExistingMutationTarget> & { commentId: string; answer: boolean })
  | (MutationBody<SourceControlExistingMutationTarget> & { action: GitHubPendingReviewAction })
  | (MutationBody<SourceControlExistingMutationTarget> & { commentId: string; body: string })
  | (MutationBody<SourceControlExistingMutationTarget> & { commentId: string })
  | ReviewBody
  | MutationBody;

interface WebSourceControlAPIOptions {
  fetch?: SourceControlFetch;
}

const rememberProviderInstances = (descriptors: ReadonlyArray<Pick<SourceControlProviderDescriptor, 'id' | 'label' | 'instances' | 'repository'>>): void => {
  for (const descriptor of descriptors) {
    providerInstances.set(descriptor.id, {
      format: descriptor.instances.format, label: descriptor.label, pathStyle: descriptor.repository.pathStyle === 'path',
    });
  }
};

rememberProviderInstances(BUILT_IN_SOURCE_CONTROL_PROVIDERS);

const providerLabel = (identity: SourceControlIdentity): string => providerInstances.get(identity.provider)?.label ?? identity.provider;

const normalizeOriginInstance = (identity: SourceControlIdentity): SourceControlIdentity => {
  const raw = identity.instance.trim();
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Invalid source control instance: ${identity.instance}`);
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(`Invalid ${providerLabel(identity)} instance: ${identity.instance}`);
  }
  return { provider: identity.provider, instance: url.origin };
};

const normalizeHostInstance = (identity: SourceControlIdentity): SourceControlIdentity => {
  const value = identity.instance.trim().toLowerCase().replace(/\.$/, '');
  let host = value;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || (url.pathname && url.pathname !== '/')) {
        throw new Error(`Invalid ${providerLabel(identity)} instance: ${identity.instance}`);
      }
      host = url.hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      throw new Error(`Invalid ${providerLabel(identity)} instance: ${identity.instance}`);
    }
  }
  return { provider: identity.provider, instance: host };
};

const normalizeIdentity = (identity: SourceControlIdentity): SourceControlIdentity => {
  const normalized = (providerInstances.get(identity.provider)?.format ?? 'origin') === 'host'
    ? normalizeHostInstance(identity)
    : normalizeOriginInstance(identity);
  const result: SourceControlIdentity = identity.instanceSshUrl?.trim()
    ? { ...normalized, instanceSshUrl: identity.instanceSshUrl.trim() }
    : normalized;
  const aliases = Array.isArray(identity.instanceAliases) ? identity.instanceAliases.filter(isNonEmptyString) : [];
  return aliases.length ? { ...result, instanceAliases: aliases } : result;
};

const parseRepositoryContext = (payload: RepositoryContextDTO): SourceControlRepositoryContext => {
  if (!payload || !isStringValue(payload.repositoryId) || !payload.repositoryId
    || !isStringValue(payload.configRevision) || !payload.configRevision
    || Object.prototype.toString.call(payload.bare) !== '[object Boolean]' || !Array.isArray(payload.remotes)) {
    throw new Error('Source control response contained an invalid repository context');
  }
  const remotes = payload.remotes.map((remote) => {
    if (!remote || !isStringValue(remote.name) || !remote.name
      || !isSafeRepositoryEndpoint(remote.fetch) || !isSafeRepositoryEndpoint(remote.push)) {
      throw new Error('Source control response contained an invalid repository remote');
    }
    return {
      name: remote.name,
      fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
      push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
    };
  });
  return { repositoryId: payload.repositoryId, configRevision: payload.configRevision, bare: payload.bare, remotes };
};

const parseRepositoryBinding = (payload: RepositoryBindingDTO): SourceControlBindingRead => {
  const repository = parseRepositoryContext(payload.repository);
  if (!Number.isInteger(payload.revision) || payload.revision < 0) {
    throw new Error('Source control response contained an invalid binding revision');
  }
  if (payload.binding === null) return { status: 'missing', repository, revision: payload.revision, binding: null };
  const binding = parseBindingResponse(payload.binding);
  if (!binding || binding.repositoryId !== repository.repositoryId || binding.revision !== payload.revision
    || !isStringValue(binding.configRevision) || !Array.isArray(binding.providers) || !Array.isArray(binding.auxiliary)
    || (binding.state !== 'bound' && binding.state !== 'needs-attention')) {
    throw new Error('Source control response contained an invalid repository binding');
  }
  const parsedBinding = resolveBindingReadiness({ ...binding,
    providers: binding.providers.map((provider) => ({ ...provider, ...normalizeIdentity(provider) })),
  }, repository);
  return { status: parsedBinding.state, repository, revision: payload.revision, binding: parsedBinding };
};

const repositoryRequest = async <TResult extends ErrorResponse>(fetch: SourceControlFetch, path: string, directory: string): Promise<TResult> => {
  const response = await fetch(path, {
    query: new URLSearchParams({ directory }),
    headers: { Accept: 'application/json' },
  });
  const payload: TResult = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || response.statusText || 'Source control repository request failed', payload.code);
  return payload;
};

export const configureWebTransportBinding = async (
  intent: GitTransportBindingIntent,
  fetch: SourceControlFetch = runtimeFetch,
): Promise<GitTransportBindingResult> => {
  const response = await fetch('/api/source-control/binding/transport', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const payload: RepositoryBindingDTO = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || 'Git transport configuration failed', payload.code);
  return { status: 'configured', binding: parseRepositoryBinding(payload) };
};

export const removeWebTransportBinding = async (
  intent: GitTransportBindingRemovalIntent,
  fetch: SourceControlFetch = runtimeFetch,
): Promise<GitTransportBindingRemovalResult> => {
  const response = await fetch('/api/source-control/binding/transport/remove', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const payload: RepositoryBindingDTO = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || 'Git transport removal failed', payload.code);
  return { status: 'removed', binding: parseRepositoryBinding(payload) };
};

export const configureWebAuxiliaryBinding = async (
  intent: GitAuxiliaryBindingIntent,
  fetch: SourceControlFetch = runtimeFetch,
): Promise<GitAuxiliaryBindingResult> => {
  const response = await fetch('/api/source-control/binding/auxiliary', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const payload: RepositoryBindingDTO = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || 'Git auxiliary transport configuration failed', payload.code);
  return { status: 'configured', binding: parseRepositoryBinding(payload) };
};

const request = async <TResult extends ErrorResponse | null>(
  fetch: SourceControlFetch,
  identity: SourceControlIdentity,
  path: string,
  init: RequestInit = {},
  query?: URLSearchParams,
): Promise<TResult> => {
  const normalized = normalizeIdentity(identity);
  const response = await fetch(providerPath(normalized, path), {
    ...init,
    query: new URLSearchParams([
      ['instance', normalized.instance],
      ...(query ? Array.from(query.entries()) : []),
    ]),
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload: TResult = await response.json();
  if (!response.ok) {
    const message = payload?.error || response.statusText || 'Source control request failed';
    if (payload?.code === 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER' && isNonEmptyString(payload.provider)) {
      throw new SourceControlInstanceOtherProviderError(message, payload.provider);
    }
    throw new SourceControlRequestError(message, payload?.code);
  }
  return payload;
};

const boundReadQuery = (context: SourceControlReadContext): URLSearchParams => {
  const query = new URLSearchParams({
    directory: context.directory,
    repositoryId: context.repositoryId,
    accountId: context.accountId,
    bindingRevision: String(context.bindingRevision),
    primaryRemote: context.primaryRemote,
  });
  if (context.linked) query.set('linked', '1');
  return query;
};

const parseIncompleteProjectIds = (ids: PageResult<never>['incompleteProjectIds']): string[] | undefined => {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.some((id) => !isNonEmptyString(id))) {
    throw new Error('Source control response contained invalid incomplete projects');
  }
  return [...ids];
};

const post = <TResult extends ErrorResponse>(
  fetch: SourceControlFetch,
  identity: SourceControlIdentity,
  path: string,
  body: PostBody,
): Promise<TResult> => request<TResult>(fetch, identity, path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type ExactKeyValue = MutationReceiptDTO
  | MutationReceiptDTO['actor']
  | MutationReceiptDTO['target']
  | MutationReceiptDTO['target']['project']
  | MutationResultDTO;

const hasExactKeys = (value: ExactKeyValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

function mutationBody(
  payload: SourceControlMutationContext<SourceControlCreateMutationTarget>,
  identity: SourceControlIdentity,
  operation: 'create',
): MutationBody<SourceControlCreateMutationTarget>;
function mutationBody(
  payload: SourceControlMutationContext<SourceControlExistingMutationTarget>,
  identity: SourceControlIdentity,
  operation: 'existing',
): MutationBody<SourceControlExistingMutationTarget>;
function mutationBody(
  payload: SourceControlMutationContext,
  identity: SourceControlIdentity,
  operation: 'create' | 'existing',
): MutationBody {
  const target = payload.target;
  if (!isNonEmptyString(payload.directory) || !isNonEmptyString(payload.repositoryId)
    || !isNonEmptyString(payload.accountId) || !isNonNegativeSafeInteger(payload.bindingRevision)
    || !isNonEmptyString(payload.primaryRemote) || !isNonEmptyString(payload.idempotencyKey)
    || !target || !isProjectOwner(identity, target.project?.owner) || !isNonEmptyString(target.project?.name)
    || (operation === 'create' && ('number' in target || 'headSha' in target))
    || (operation === 'create' && (!isNonEmptyString(target.head) || !isNonEmptyString(target.base)))
    || (operation === 'existing' && !isPositiveSafeInteger(target.number))
    || (target.number !== undefined && !isPositiveSafeInteger(target.number))
    || (target.head !== undefined && !isNonEmptyString(target.head))
    || (target.base !== undefined && !isNonEmptyString(target.base))
    || (target.headSha !== undefined && !isNonEmptyString(target.headSha))) {
    throw new Error('Source control mutation context is invalid');
  }
  const context = {
    ...identity,
    directory: payload.directory,
    repositoryId: payload.repositoryId,
    accountId: payload.accountId,
    bindingRevision: payload.bindingRevision,
    primaryRemote: payload.primaryRemote,
    idempotencyKey: payload.idempotencyKey,
  };
  if (operation === 'create') {
    if (!isNonEmptyString(target.head) || !isNonEmptyString(target.base)) {
      throw new Error('Source control mutation context is invalid');
    }
    return {
      ...context,
      target: {
        project: { owner: target.project.owner, name: target.project.name },
        head: target.head,
        base: target.base,
      },
    };
  }
  if (!isPositiveSafeInteger(target.number)) {
    throw new Error('Source control mutation context is invalid');
  }
  const expectedTarget: SourceControlExistingMutationTarget = {
    project: { owner: target.project.owner, name: target.project.name },
    number: target.number,
  };
  if (target.head !== undefined) expectedTarget.head = target.head;
  if (target.base !== undefined) expectedTarget.base = target.base;
  if (target.headSha !== undefined) expectedTarget.headSha = target.headSha;
  return { ...context, target: expectedTarget };
}

const mutationTargetMatches = (
  target: MutationReceiptDTO['target'],
  context: SourceControlMutationContext,
): boolean => target.repositoryId === context.repositoryId
  && target.bindingRevision === context.bindingRevision
  && target.primaryRemote === context.primaryRemote
  && target.project.owner === context.target.project.owner
  && target.project.name === context.target.project.name
  && (context.target.number === undefined || target.number === context.target.number)
  && (context.target.head === undefined || target.head === context.target.head)
  && (context.target.base === undefined || target.base === context.target.base)
  && (context.target.headSha === undefined || target.headSha === context.target.headSha);

const parseMutationReceipt = <TResult>(
  payload: MutationReceiptDTO,
  context: SourceControlMutationContext,
  identity: SourceControlIdentity,
  parseResult: (result: MutationResultDTO) => TResult,
): SourceControlMutationReceipt<TResult> => {
  const actor = payload?.actor;
  const target = payload?.target;
  const project = target?.project;
  if (!payload || !hasExactKeys(payload, ['status', 'actor', 'target', 'replayed', 'result'])
    || payload.status !== 'succeeded' || !isBooleanValue(payload.replayed)
    || !actor || !hasExactKeys(actor, ['provider', 'instance', 'providerAccountId'])
    || actor.provider !== identity.provider || actor.instance !== identity.instance
    || !isNonEmptyString(actor.providerAccountId) || !isProviderUserId(identity.provider, identity.instance, actor.providerAccountId)
    || !target || !hasExactKeys(target, [
      'repositoryId', 'bindingRevision', 'primaryRemote', 'project',
      ...(['number', 'head', 'base', 'headSha'] as const).filter((key) => target[key] !== undefined),
    ])
    || !isNonEmptyString(target.repositoryId) || !isNonNegativeSafeInteger(target.bindingRevision)
    || !isNonEmptyString(target.primaryRemote) || !project || !hasExactKeys(project, ['id', 'owner', 'name'])
    || !isNonEmptyString(project.id) || !isProjectOwner(identity, project.owner) || !isNonEmptyString(project.name)
    || (target.number !== undefined && !isPositiveSafeInteger(target.number))
    || (target.head !== undefined && !isNonEmptyString(target.head))
    || (target.base !== undefined && !isNonEmptyString(target.base))
    || (target.headSha !== undefined && !isNonEmptyString(target.headSha))
    || !mutationTargetMatches(target, context)
    || !payload.result || Object.prototype.toString.call(payload.result) !== '[object Object]') {
    throw new Error('Source control response contained an invalid mutation receipt');
  }
  const resolvedTarget: SourceControlResolvedMutationTarget = {
    repositoryId: target.repositoryId,
    bindingRevision: target.bindingRevision,
    primaryRemote: target.primaryRemote,
    project: { id: project.id, owner: project.owner, name: project.name },
  };
  if (target.number !== undefined) resolvedTarget.number = target.number;
  if (target.head !== undefined) resolvedTarget.head = target.head;
  if (target.base !== undefined) resolvedTarget.base = target.base;
  if (target.headSha !== undefined) resolvedTarget.headSha = target.headSha;
  return {
    status: 'succeeded',
    actor: { ...identity, providerAccountId: actor.providerAccountId },
    target: resolvedTarget,
    replayed: payload.replayed,
    result: parseResult(payload.result),
  };
};

const parseEmptyMutationResult = (result: MutationResultDTO): SourceControlEmptyMutationResult => {
  if (!hasExactKeys(result, [])) throw new Error('Source control response contained an invalid mutation result');
  return {};
};

const MERGE_OUTCOMES = ['queued', 'merging', 'auto-merge', 'cancelled'] as const;
const mergeOutcomeOf = (value: string): SourceControlMergeMutationResult['outcome'] | null => (
  MERGE_OUTCOMES.find((outcome) => outcome === value) ?? null
);

const parseCreateMutationResult = (result: MutationResultDTO): SourceControlCreateMutationResult => {
  if (!hasExactKeys(result, result.stacked === undefined ? [] : ['stacked'])
    || (result.stacked !== undefined && !isBooleanValue(result.stacked))) {
    throw new Error('Source control response contained an invalid create result');
  }
  return result.stacked === undefined ? {} : { stacked: result.stacked };
};

const parseMergeMutationResult = (result: MutationResultDTO): SourceControlMergeMutationResult => {
  const keys = ['merged', ...(result.message === undefined ? [] : ['message']), ...(result.outcome === undefined ? [] : ['outcome'])];
  const outcome = result.outcome === undefined ? undefined : mergeOutcomeOf(result.outcome);
  if (!hasExactKeys(result, keys) || !isBooleanValue(result.merged)
    || (result.message !== undefined && !isStringValue(result.message)) || outcome === null) {
    throw new Error('Source control response contained an invalid merge result');
  }
  const parsed: SourceControlMergeMutationResult = { merged: result.merged };
  if (result.message !== undefined) parsed.message = result.message;
  if (outcome !== undefined) parsed.outcome = outcome;
  return parsed;
};

const parseReviewMutationResult = (result: MutationResultDTO): SourceControlReviewMutationResult => {
  if (!hasExactKeys(result, ['commented']) || !isBooleanValue(result.commented)) {
    throw new Error('Source control response contained an invalid review result');
  }
  return { commented: result.commented };
};

interface RepositoryChoicesDTO extends ErrorResponse {
  connected?: boolean;
  items?: Array<{ name?: string; color?: string; id?: string; login?: string; avatarUrl?: string }>;
}

const readRepositoryChoices = async (
  fetch: SourceControlFetch,
  context: SourceControlReadContext,
  project: RepositorySelector,
  path: string,
): Promise<NonNullable<RepositoryChoicesDTO['items']>> => {
  const identity = normalizeIdentity(context);
  const query = boundReadQuery(context);
  query.set('owner', project.owner);
  query.set('repo', project.repo);
  const payload = await request<RepositoryChoicesDTO>(fetch, identity, path, {}, query);
  if (payload.connected !== true) throw new Error(`${providerLabel(identity)} is not connected`);
  if (!Array.isArray(payload.items)) throw new Error('Source control response contained an invalid list');
  return payload.items;
};

const parseLabelChoices = (items: NonNullable<RepositoryChoicesDTO['items']>): Label[] => items.map((item) => {
  if (!isNonEmptyString(item.name) || (item.color !== undefined && !isStringValue(item.color))) {
    throw new Error('Source control response contained an invalid label');
  }
  return item.color ? { name: item.name, color: item.color } : { name: item.name };
});

const parseReviewerChoices = (items: NonNullable<RepositoryChoicesDTO['items']>): RepositoryReferenceReviewer[] => items.map((item) => {
  if (!isNonEmptyString(item.id) || !isNonEmptyString(item.login) || (item.avatarUrl !== undefined && !isHttpUrl(item.avatarUrl))) {
    throw new Error('Source control response contained an invalid user');
  }
  return item.avatarUrl ? { id: item.id, login: item.login, avatarUrl: item.avatarUrl } : { id: item.id, login: item.login };
});

const parseStateMutationResult = (result: MutationResultDTO): SourceControlStateMutationResult => {
  if (!hasExactKeys(result, ['state']) || (result.state !== 'open' && result.state !== 'closed')) {
    throw new Error('Source control response contained an invalid state result');
  }
  return { state: result.state };
};

const parseReadyMutationResult = (result: MutationResultDTO): SourceControlReadyMutationResult => {
  if (!hasExactKeys(result, ['ready']) || !isBooleanValue(result.ready)) {
    throw new Error('Source control response contained an invalid ready result');
  }
  return { ready: result.ready };
};

const parseDraftMutationResult = (result: MutationResultDTO): SourceControlDraftMutationResult => {
  if (!hasExactKeys(result, ['draft']) || !isBooleanValue(result.draft)) {
    throw new Error('Source control response contained an invalid draft result');
  }
  return { draft: result.draft };
};

const parseCiWorkflowRunPage = (payload: CiWorkflowRunPage, identity: SourceControlIdentity): CiWorkflowRunPage => {
  if (!payload || !Array.isArray(payload.items) || payload.project === undefined) {
    throw new Error('Source control response contained invalid CI workflow runs');
  }
  const page = parsePage(payload, payload.items.map((item) => parseCiWorkflowRun(item, identity)));
  return {
    ...page,
    project: payload.project === null ? null : parseSourceProject(payload.project, identity),
  };
};

const parseCiWorkflowRunDetail = (payload: CiWorkflowRunDetail, identity: SourceControlIdentity): CiWorkflowRunDetail => {
  if (!payload || !hasMatchingIdentity(payload.identity, identity)
    || payload.project === undefined || payload.run === undefined || payload.ci === undefined) {
    throw new Error('Source control response contained an invalid CI workflow run detail');
  }
  return {
    identity,
    project: payload.project === null ? null : parseSourceProject(payload.project, identity),
    run: payload.run === null ? null : parseCiWorkflowRun(payload.run, identity),
    ci: parseSourceCI(payload.ci, identity),
  };
};

const parseCiJobLogResult = (payload: CiJobLogResult, identity: SourceControlIdentity): CiJobLogResult => {
  if (!payload || !hasMatchingIdentity(payload.identity, identity)
    || !isNonEmptyString(payload.jobId)
    || !isBooleanValue(payload.available)
    || !isStringValue(payload.content)
    || !isBooleanValue(payload.truncated)) {
    throw new Error('Source control response contained an invalid CI job log');
  }
  return {
    identity,
    jobId: payload.jobId,
    available: payload.available,
    content: payload.content,
    truncated: payload.truncated,
  };
};

const parseSourceChangeRequest = (request: ChangeRequest, identity: SourceControlIdentity): ChangeRequest => {
  if (!request || !isValidId(request.id) || !Number.isInteger(request.number) || request.number < 1
    || !isNonEmptyString(request.title) || !isHttpUrl(request.url)
    || !['open', 'closed', 'merged'].includes(request.state)
    || !isBooleanValue(request.draft)
    || !isNonEmptyString(request.base) || !isNonEmptyString(request.head)
    || !hasMatchingIdentity(request, identity)
    || (request.body !== undefined && !isStringValue(request.body))
    || (request.headSha !== undefined && !isNonEmptyString(request.headSha))
    || (request.author !== undefined && request.author !== null && !hasMatchingIdentity(request.author, identity))
    || (request.createdAt !== undefined && !isNonEmptyString(request.createdAt))
    || (request.updatedAt !== undefined && !isNonEmptyString(request.updatedAt))
    || (request.headLabel !== undefined && !isNonEmptyString(request.headLabel))
    || (request.mergeable !== undefined && request.mergeable !== null && !isBooleanValue(request.mergeable))
    || (request.mergeableState !== undefined && request.mergeableState !== null && !isStringValue(request.mergeableState))
    || (request.labels !== undefined && (!Array.isArray(request.labels) || request.labels.some((label) => !label
      || !isNonEmptyString(label.name) || (label.color !== undefined && !isStringValue(label.color)))))
    || (request.workInProgress !== undefined && !isBooleanValue(request.workInProgress))
    || (request.private !== undefined && !isBooleanValue(request.private))
    || (request.topic !== undefined && !isStringValue(request.topic))
    || (request.hashtags !== undefined && (!Array.isArray(request.hashtags) || request.hashtags.some((tag) => !isNonEmptyString(tag))))
    || (request.revisionNumber !== undefined && !isPositiveSafeInteger(request.revisionNumber))) {
    throw new Error('Source control response contained an invalid change request');
  }
  const result: ChangeRequest = {
    ...identity,
    id: String(request.id),
    number: request.number,
    project: parseSourceProject(request.project, identity),
    title: request.title,
    url: request.url,
    state: request.state,
    draft: request.draft,
    base: request.base,
    head: request.head,
  };
  if (request.body !== undefined) result.body = request.body;
  if (request.headSha) result.headSha = request.headSha;
  if (request.author !== undefined && request.author !== null) result.author = parseSourceUser(request.author, identity);
  if (request.createdAt) result.createdAt = request.createdAt;
  if (request.updatedAt) result.updatedAt = request.updatedAt;
  if (request.headLabel) result.headLabel = request.headLabel;
  if (request.headProject !== undefined && request.headProject !== null) {
    result.headProject = parseSourceProject(request.headProject, identity);
  }
  if (request.mergeable !== undefined) result.mergeable = request.mergeable;
  if (request.mergeableState !== undefined) result.mergeableState = request.mergeableState;
  if (request.labels !== undefined) result.labels = request.labels.map((label) => ({ name: label.name, color: label.color }));
  if (request.workInProgress !== undefined) result.workInProgress = request.workInProgress;
  if (request.private !== undefined) result.private = request.private;
  if (request.topic) result.topic = request.topic;
  if (request.hashtags !== undefined) result.hashtags = [...request.hashtags];
  if (request.revisionNumber !== undefined) result.revisionNumber = request.revisionNumber;
  return result;
};

const parseSourceIssue = (issue: Issue, identity: SourceControlIdentity): Issue => {
  if (!issue || !isValidId(issue.id) || !Number.isInteger(issue.number) || issue.number < 1
    || !isNonEmptyString(issue.title) || !isHttpUrl(issue.url)
    || (issue.state !== 'open' && issue.state !== 'closed') || !hasMatchingIdentity(issue, identity)
    || (issue.body !== undefined && !isStringValue(issue.body))
    || (issue.author !== undefined && issue.author !== null && !hasMatchingIdentity(issue.author, identity))
    || (issue.createdAt !== undefined && !isNonEmptyString(issue.createdAt))
    || (issue.updatedAt !== undefined && !isNonEmptyString(issue.updatedAt))) {
    throw new Error('Source control response contained an invalid issue');
  }
  if (issue.assignees !== undefined && (!Array.isArray(issue.assignees)
    || issue.assignees.some((user) => !hasMatchingIdentity(user, identity)))) {
    throw new Error('Source control response contained invalid issue assignees');
  }
  if (issue.labels !== undefined && (!Array.isArray(issue.labels) || issue.labels.some((label) => !label
    || !isNonEmptyString(label.name) || (label.color !== undefined && !isStringValue(label.color))))) {
    throw new Error('Source control response contained invalid issue labels');
  }
  const result: Issue = {
    ...identity,
    id: String(issue.id),
    number: issue.number,
    project: parseSourceProject(issue.project, identity),
    title: issue.title,
    url: issue.url,
    state: issue.state,
  };
  if (issue.body !== undefined) result.body = issue.body;
  if (issue.author !== undefined) result.author = issue.author ? parseSourceUser(issue.author, identity) : null;
  if (issue.assignees !== undefined) result.assignees = issue.assignees.map((user) => parseSourceUser(user, identity));
  if (issue.labels !== undefined) result.labels = issue.labels.map((label) => ({ name: label.name, color: label.color }));
  if (issue.createdAt) result.createdAt = issue.createdAt;
  if (issue.updatedAt) result.updatedAt = issue.updatedAt;
  return result;
};

const parseSourceCommit = (commit: ChangeRequestCommit): ChangeRequestCommit => {
  if (!commit || !isNonEmptyString(commit.sha) || !isStringValue(commit.headline)
    || (commit.authorName !== null && !isStringValue(commit.authorName))
    || (commit.committedAt !== null && !isNonEmptyString(commit.committedAt))
    || (commit.url !== null && !isHttpUrl(commit.url))) {
    throw new Error('Source control response contained an invalid commit');
  }
  return { sha: commit.sha, headline: commit.headline, authorName: commit.authorName, committedAt: commit.committedAt, url: commit.url };
};

const STACK_LAYER_STATES = ['open', 'closed', 'merged'] as const;

const parseSourceStack = (stack: PullRequestStack): PullRequestStack => {
  if (!stack || !isNonEmptyString(stack.base) || !Array.isArray(stack.layers)
    || (stack.number !== null && !Number.isSafeInteger(stack.number))) {
    throw new Error('Source control response contained an invalid merge request chain');
  }
  return {
    number: stack.number,
    base: stack.base,
    layers: stack.layers.map((layer) => {
      const state = STACK_LAYER_STATES.find((candidate) => candidate === layer?.state);
      if (!layer || !Number.isSafeInteger(layer.number) || !isStringValue(layer.title) || !isHttpUrl(layer.url)
        || !state || !isBooleanValue(layer.draft) || !isNonEmptyString(layer.head)) {
        throw new Error('Source control response contained an invalid merge request chain');
      }
      return { number: layer.number, title: layer.title, url: layer.url, state, draft: layer.draft, head: layer.head };
    }),
  };
};

const parseOptionalStack = (stack: PullRequestStack): PullRequestStack | undefined => {
  try {
    return parseSourceStack(stack);
  } catch {
    return undefined;
  }
};

const parseSourceVerdict = (verdict: ChangeRequestVerdict, identity: SourceControlIdentity): ChangeRequestVerdict => {
  if (!verdict || (verdict.state !== 'approved' && verdict.state !== 'changes_requested') || !isNonEmptyString(verdict.url)
    || (verdict.createdAt !== null && !isNonEmptyString(verdict.createdAt))) {
    throw new Error('Source control response contained an invalid review verdict');
  }
  const result: ChangeRequestVerdict = { state: verdict.state, url: verdict.url, createdAt: verdict.createdAt };
  if (verdict.author) result.author = parseSourceUser(verdict.author, identity);
  return result;
};

const VOTE_STATUSES = ['approved', 'rejected', 'recommended', 'disliked', 'neutral'] as const;
const REQUIREMENT_STATUSES = ['satisfied', 'unsatisfied', 'overridden', 'not-applicable', 'error', 'forced'] as const;
const REVISION_KINDS = ['rework', 'trivial-rebase', 'merge-first-parent-update', 'no-code-change', 'no-change'] as const;
const isVoteValue = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isInteger(value) && value >= -10 && value <= 10;

const parseSourceVote = (vote: ChangeRequestVote, identity: SourceControlIdentity): ChangeRequestVote => {
  if (!vote || !isVoteValue(vote.value) || (vote.revision !== undefined && !isPositiveSafeInteger(vote.revision))) {
    throw new Error('Source control response contained an invalid vote');
  }
  const result: ChangeRequestVote = { user: parseSourceUser(vote.user, identity), value: vote.value };
  if (vote.revision !== undefined) result.revision = vote.revision;
  return result;
};

const parseSourceVoteLabel = (label: ChangeRequestVoteLabel, identity: SourceControlIdentity): ChangeRequestVoteLabel => {
  const status = VOTE_STATUSES.find((candidate) => candidate === label?.status);
  if (!label || !isNonEmptyString(label.name) || !status || !isVoteValue(label.defaultValue) || !isBooleanValue(label.blocking)
    || !Array.isArray(label.values) || label.values.some((entry) => !entry || !isVoteValue(entry.value) || !isStringValue(entry.description))
    || !Array.isArray(label.permitted) || label.permitted.some((value) => !isVoteValue(value))
    || !Array.isArray(label.votes)) {
    throw new Error('Source control response contained an invalid vote label');
  }
  return {
    name: label.name,
    values: label.values.map((entry) => ({ value: entry.value, description: entry.description })),
    defaultValue: label.defaultValue,
    permitted: [...label.permitted],
    blocking: label.blocking,
    status,
    votes: label.votes.map((vote) => parseSourceVote(vote, identity)),
  };
};

const parseSourceSubmitRequirement = (requirement: ChangeRequestSubmitRequirement): ChangeRequestSubmitRequirement => {
  const status = REQUIREMENT_STATUSES.find((candidate) => candidate === requirement?.status);
  if (!requirement || !isNonEmptyString(requirement.name) || !status
    || (requirement.description !== undefined && !isStringValue(requirement.description))) {
    throw new Error('Source control response contained an invalid submit requirement');
  }
  const result: ChangeRequestSubmitRequirement = { name: requirement.name, status };
  if (requirement.description) result.description = requirement.description;
  return result;
};

const parseSourceRevision = (revision: ChangeRequestRevision, identity: SourceControlIdentity): ChangeRequestRevision => {
  const kind = revision?.kind === undefined ? undefined : REVISION_KINDS.find((candidate) => candidate === revision.kind);
  if (!revision || !isPositiveSafeInteger(revision.number) || !isNonEmptyString(revision.sha) || !isNonEmptyString(revision.ref)
    || (revision.createdAt !== null && !isNonEmptyString(revision.createdAt)) || (revision.kind !== undefined && !kind)) {
    throw new Error('Source control response contained an invalid revision');
  }
  const result: ChangeRequestRevision = { number: revision.number, sha: revision.sha, createdAt: revision.createdAt, ref: revision.ref };
  if (revision.uploader) result.uploader = parseSourceUser(revision.uploader, identity);
  if (kind) result.kind = kind;
  return result;
};

const parseSourceLocalRevision = (local: ChangeRequestLocalRevision): ChangeRequestLocalRevision => {
  if (!local || !isNonEmptyString(local.sha)
    || (local.changeId !== null && !isNonEmptyString(local.changeId))
    || (local.uploadedAs !== null && !isPositiveSafeInteger(local.uploadedAs))) {
    throw new Error('Source control response contained an invalid local revision');
  }
  return { sha: local.sha, changeId: local.changeId, uploadedAs: local.uploadedAs };
};

const parseSourceReviewComment = (comment: ChangeRequestReviewComment, identity: SourceControlIdentity): ChangeRequestReviewComment => {
  if (comment?.revision !== undefined && !isPositiveSafeInteger(comment.revision)) {
    throw new Error('Source control response contained an invalid review comment');
  }
  const result: ChangeRequestReviewComment = { ...parseSourceComment(comment, identity), path: comment.path, line: comment.line, position: comment.position };
  if (comment.revision !== undefined) result.revision = comment.revision;
  return result;
};

const parseSourceComment = (comment: IssueComment, identity: SourceControlIdentity): IssueComment => {
  if (!comment || !isValidId(comment.id) || !isNonEmptyString(comment.url) || !isStringValue(comment.body)
    || !hasMatchingIdentity(comment, identity)
    || (comment.author !== undefined && comment.author !== null && !hasMatchingIdentity(comment.author, identity))
    || (comment.createdAt !== undefined && !isNonEmptyString(comment.createdAt))
    || (comment.updatedAt !== undefined && !isNonEmptyString(comment.updatedAt))
    || (comment.canUpdate !== undefined && !isBooleanValue(comment.canUpdate))
    || (comment.canDelete !== undefined && !isBooleanValue(comment.canDelete))) {
    throw new Error('Source control response contained an invalid comment');
  }
  const thread = comment.thread;
  if (thread !== undefined && (!thread || !isValidId(thread.id) || !isBooleanValue(thread.resolved)
    || !isBooleanValue(thread.resolvable) || !isBooleanValue(thread.first)
    || (thread.canResolve !== undefined && !isBooleanValue(thread.canResolve))
    || (thread.canReply !== undefined && !isBooleanValue(thread.canReply)))) {
    throw new Error('Source control response contained an invalid comment thread');
  }
  const result: IssueComment = { ...identity, id: String(comment.id), url: comment.url, body: comment.body };
  if (thread) {
    result.thread = { id: String(thread.id), resolved: thread.resolved, resolvable: thread.resolvable, first: thread.first };
    if (thread.canResolve !== undefined) result.thread.canResolve = thread.canResolve;
    if (thread.canReply !== undefined) result.thread.canReply = thread.canReply;
  }
  if (comment.author) result.author = parseSourceUser(comment.author, identity);
  if (comment.createdAt) result.createdAt = comment.createdAt;
  if (comment.updatedAt) result.updatedAt = comment.updatedAt;
  if (comment.canUpdate !== undefined) result.canUpdate = comment.canUpdate;
  if (comment.canDelete !== undefined) result.canDelete = comment.canDelete;
  return result;
};

const isBooleanValue = (value: BoundaryScalar): value is boolean => Object.prototype.toString.call(value) === '[object Boolean]';

const isNonNegativeSafeInteger = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isSafeInteger(value) && value >= 0;
const parsePageFields = (page: number | undefined, hasMore: boolean | undefined): Pick<PageResult<never>, 'page' | 'hasMore'> => {
  if (!isNumberValue(page) || !Number.isInteger(page) || page < 1 || !isBooleanValue(hasMore)) {
    throw new Error('Source control response contained invalid pagination');
  }
  return { page, hasMore };
};

const parsePage = <TItem>(payload: PageResult<TItem>, items: TItem[]): PageResult<TItem> => {
  const result: PageResult<TItem> = { items, ...parsePageFields(payload.page, payload.hasMore) };
  const incompleteProjectIds = parseIncompleteProjectIds(payload.incompleteProjectIds);
  if (incompleteProjectIds?.length) result.incompleteProjectIds = incompleteProjectIds;
  return result;
};
const parseBranches = (payload: BranchesDTO): string[] => {
  if (!payload || !Array.isArray(payload.branches) || payload.branches.some((branch) => !isNonEmptyString(branch))) {
    throw new Error('Source control response contained invalid branches');
  }
  return [...payload.branches];
};

const parseSourceChangeRequestStatus = (
  payload: ChangeRequestStatus,
  identity: SourceControlIdentity,
  requestedBranch: string,
): ChangeRequestStatus => {
  if (!payload || !hasMatchingIdentity(payload.identity, identity)
    || !isNonEmptyString(payload.branch) || payload.branch !== requestedBranch
    || payload.project === undefined || payload.changeRequest === undefined
    || (payload.fetchedAt !== undefined && (!Number.isFinite(payload.fetchedAt) || payload.fetchedAt < 0))
    || (payload.canMerge !== undefined && !isBooleanValue(payload.canMerge))
    || (payload.defaultBranch !== undefined && payload.defaultBranch !== null && !isNonEmptyString(payload.defaultBranch))
    || (payload.resolvedRemoteName !== undefined && payload.resolvedRemoteName !== null && !isNonEmptyString(payload.resolvedRemoteName))) {
    throw new Error('Source control response contained an invalid change request status');
  }
  const result: ChangeRequestStatus = {
    identity,
    project: payload.project === null ? null : parseSourceProject(payload.project, identity),
    branch: payload.branch,
    changeRequest: payload.changeRequest === null ? null : parseSourceChangeRequest(payload.changeRequest, identity),
  };
  if (payload.ci !== undefined) result.ci = parseSourceCI(payload.ci, identity);
  if (payload.canMerge !== undefined) result.canMerge = payload.canMerge;
  if (payload.defaultBranch !== undefined) result.defaultBranch = payload.defaultBranch;
  if (payload.resolvedRemoteName !== undefined) result.resolvedRemoteName = payload.resolvedRemoteName;
  if (payload.fetchedAt !== undefined) result.fetchedAt = payload.fetchedAt;
  if (payload.localRevision !== undefined) result.localRevision = parseSourceLocalRevision(payload.localRevision);
  if (payload.stack === null) result.stack = null;
  else if (payload.stack !== undefined) {
    const stack = parseOptionalStack(payload.stack);
    if (stack) result.stack = stack;
  }
  return result;
};

const parseAuthAccounts = (
  accounts: SourceControlAuthAccount[] | undefined,
  identity: SourceControlIdentity,
): SourceControlAuthAccount[] => (accounts ?? []).map((account) => {
  if (!isNonEmptyString(account.id) || account.id !== account.credentialId
    || !isPositiveSafeInteger(account.credentialRevision) || !isNonEmptyString(account.providerUserId)
    || !['available', 'unavailable'].includes(account.providerUserStatus)
    || !isBooleanValue(account.current) || !['oauth', 'pat', 'cli'].includes(account.source)
    || !['valid', 'invalid'].includes(account.status)
    || (account.usable !== undefined && !isBooleanValue(account.usable))) {
    throw new Error('Source control response contained an invalid auth credential');
  }
  const result: SourceControlAuthAccount = {
    id: account.id,
    credentialId: account.credentialId,
    credentialRevision: account.credentialRevision,
    providerUserId: account.providerUserId,
    providerUserStatus: account.providerUserStatus,
    user: parseSourceUser(account.user, identity),
    scope: account.scope,
    current: account.current,
    source: account.source,
    status: account.status,
  };

  if (account.usable !== undefined) result.usable = account.usable;
  return result;
});

const parseProviderAuthStatus = (payload: ProviderAuthStatusDTO, identity: SourceControlIdentity): SourceControlAuthStatus => {
  if (!payload.connected) {
    if (!payload.status) {
      const result: Extract<SourceControlAuthStatus, { status: 'disconnected' }> = {
        ...identity,
        status: 'disconnected',
        connected: false,
      };
      if (payload.cli) {
        result.cli = {
          available: payload.cli.available,
          disabled: payload.cli.disabled,
          active: payload.cli.active,
          user: payload.cli.user ? parseSourceUser(payload.cli.user, identity) : undefined,
        };
      }
      result.accounts = parseAuthAccounts(payload.accounts, identity);
      return result;
    }
    return { ...payload, ...identity, connected: false, accounts: parseAuthAccounts(payload.accounts, identity) };
  }
  return {
    ...identity,
    status: 'connected',
    connected: true,
    user: parseSourceUser(payload.user, identity),
    scope: payload.scope,
    accounts: parseAuthAccounts(payload.accounts, identity),
    cli: payload.cli ? {
      available: payload.cli.available,
      disabled: payload.cli.disabled,
      active: payload.cli.active,
      user: payload.cli.user ? parseSourceUser(payload.cli.user, identity) : undefined,
    } : undefined,
  };
};

export const createWebSourceControlAPI = (options: WebSourceControlAPIOptions = {}): SourceControlAPI => {
  const fetch = options.fetch ?? runtimeFetch;

  return {
    repositoryContext: async (directory) => parseRepositoryContext(await repositoryRequest<RepositoryContextDTO>(
      fetch, '/api/source-control/repository-context', directory,
    )),
    repositoryBinding: async (directory) => parseRepositoryBinding(await repositoryRequest<RepositoryBindingDTO>(
      fetch, '/api/source-control/binding', directory,
    )),
    resetRepositoryBinding: async (input: SourceControlRepositoryBindingResetIntent) => {
      const response = await fetch('/api/source-control/binding/reset', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const payload: RepositoryBindingDTO = await response.json();
      if (!response.ok) {
        throw new SourceControlRequestError(payload.error || response.statusText || 'Source control binding reset failed', payload.code);
      }
      return parseRepositoryBinding(payload);
    },
    repositoryProviderBindingMutate: async (input) => {
      const response = await fetch('/api/source-control/binding/provider', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const payload: RepositoryBindingDTO = await response.json();
      if (!response.ok) {
        throw new SourceControlRequestError(payload.error || response.statusText || 'Source control binding request failed', payload.code);
      }
      return parseRepositoryBinding(payload);
    },
    providers: async () => {
      const descriptors = await fetchSourceControlProviders(fetch);
      rememberProviderInstances(descriptors);
      return descriptors;
    },
    authInstances: async () => {
      const response = await fetch('/api/source-control/instances', { headers: { Accept: 'application/json' } });
      const payload: SourceControlInstancesResponse = await response.json();
      if (!response.ok) throw new Error(payload.error || response.statusText || 'Failed to list source control instances');
      return payload.instances.map(normalizeIdentity);
    },
    capabilities: async (identity): Promise<SourceControlCapabilities> => {
      const payload = await request<SourceControlCapabilities & ErrorResponse>(fetch, identity, '/capabilities');
      const normalized = normalizeIdentity(payload.identity);
      return {
        identity: normalized,
        authentication: payload.authentication,
        authenticationMethods: payload.authenticationMethods,
        multipleAccounts: payload.multipleAccounts,
        projects: payload.projects,
        issues: payload.issues,
        changeRequests: payload.changeRequests,
        draftChangeRequests: payload.draftChangeRequests,
        draftConversion: payload.draftConversion === true,
        mergeChangeRequests: payload.mergeChangeRequests,
        forceMergeChangeRequests: normalized.provider === 'github' && payload.forceMergeChangeRequests === true,
        mergeMethods: payload.mergeMethods ? [...payload.mergeMethods] : undefined,
        ci: payload.ci,
      };
    },
    authStatus: async (identity) => {
      const normalized = normalizeIdentity(identity);
      return parseProviderAuthStatus(await request<ProviderAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
    },
    authStart: async (identity): Promise<SourceControlDeviceFlowStart> => {
      const payload = await request<DeviceFlowStartDTO & ErrorResponse>(fetch, identity, '/auth/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const result: SourceControlDeviceFlowStart = {
        flowId: payload.flowId,
        userCode: payload.userCode,
        verificationUri: payload.verificationUri,
        expiresIn: payload.expiresIn,
        interval: payload.interval,
      };
      if (payload.verificationUriComplete) result.verificationUriComplete = payload.verificationUriComplete;
      if (payload.scope) result.scope = payload.scope;
      return result;
    },
    authComplete: async (identity, flowId): Promise<SourceControlDeviceFlowComplete> => {
      let payload: DeviceFlowCompleteDTO & ErrorResponse;
      try {
        payload = await post<DeviceFlowCompleteDTO & ErrorResponse>(fetch, identity, '/auth/complete', { flowId });
      } catch (error) {
        if (error instanceof SourceControlRequestError && error.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') {
          return { status: 'error', code: 'expired', message: error.message };
        }
        throw error;
      }
      if (payload.connected) {
        const result: SourceControlDeviceFlowComplete = { status: 'connected', user: parseSourceUser(payload.user, normalizeIdentity(identity)) };
        if (payload.scope) result.scope = payload.scope;
        return result;
      }
      if (payload.status === 'authorization_pending' || payload.status === 'slow_down') {
        const result: SourceControlDeviceFlowComplete = { status: 'pending' };
        if (payload.status === 'slow_down') result.slowDown = true;
        return result;
      }
      let code: 'access-denied' | 'expired' | 'provider-error' = 'provider-error';
      if (payload.status === 'access_denied') {
        code = 'access-denied';
      } else if (payload.status === 'expired_token') {
        code = 'expired';
      }
      return { status: 'error', code, message: payload.error || payload.status || `${providerLabel(identity)} authentication failed` };
    },
    authSetToken: async (identity, token, tokenOptions) => {
      const normalized = normalizeIdentity(identity);
      await post<ErrorResponse>(fetch, normalized, '/auth/token', tokenOptions?.username ? { token, username: tokenOptions.username } : { token });
      return parseProviderAuthStatus(await request<ProviderAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
    },
    authSetSshUrl: async (identity, sshUrl) => {
      const normalized = normalizeIdentity(identity);
      const payload = await post<{ sshUrl?: string | null; error?: string }>(fetch, normalized, '/auth/ssh-url', { sshUrl });
      if (payload.sshUrl !== null && !isNonEmptyString(payload.sshUrl)) {
        throw new Error('Source control response contained an invalid SSH URL');
      }
      return { sshUrl: payload.sshUrl ?? null };
    },
    setInstanceAliases: async (identity, aliases) => {
      const normalized = normalizeIdentity(identity);
      const response = await fetch('/api/source-control/instances/aliases', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: normalized.provider, instance: normalized.instance, aliases }),
      });
      const payload: { aliases?: BoundaryScalar[]; alias?: BoundaryScalar } & ErrorResponse = await response.json();
      if (!response.ok) {
        const message = payload.error || response.statusText || 'Failed to save instance aliases';
        if ((payload.code === 'INVALID_INSTANCE_ALIAS' || payload.code === 'INSTANCE_ALIAS_TAKEN') && isNonEmptyString(payload.alias)) {
          throw new SourceControlInstanceAliasError(message, payload.code === 'INSTANCE_ALIAS_TAKEN' ? 'taken' : 'invalid', payload.alias);
        }
        throw new SourceControlRequestError(message, payload.code);
      }
      if (!Array.isArray(payload.aliases) || !payload.aliases.every(isNonEmptyString)) {
        throw new Error('Source control response contained invalid instance aliases');
      }
      return { aliases: [...payload.aliases] };
    },
    authDisconnect: async (identity, accountId) => {
      if (!isNonEmptyString(accountId) || accountId.trim() !== accountId) {
        throw new Error('Source control credential accountId is required');
      }
      const query = new URLSearchParams({ accountId });
      const payload = await request<{ removed?: boolean; error?: string }>(fetch, identity, '/auth', { method: 'DELETE' }, query);
      if (!isBooleanValue(payload.removed)) {
        throw new Error('Source control response contained an invalid account removal result');
      }
      return { removed: payload.removed };
    },
    authActivate: async (identity, accountId) => {
      const normalized = normalizeIdentity(identity);
      return parseProviderAuthStatus(await post<ProviderAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/activate', { accountId }), normalized);
    },
    authSetCliDisabled: async (identity, disabled) => {
      const normalized = normalizeIdentity(identity);
      const payload = await post<{ disabled?: boolean; error?: string }>(fetch, normalized, '/auth/cli', { disabled });
      return { disabled: Boolean(payload.disabled) };
    },

    changeRequestStatus: async (context, branch, requestOptions): Promise<ChangeRequestStatus> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('branch', branch);
      if (requestOptions?.force) query.set('force', 'true');
      const payload = await request<ChangeRequestStatus & ErrorResponse>(fetch, normalized, '/pr/status', {}, query);
      return parseSourceChangeRequestStatus(payload, normalized, branch);
    },
    changeRequestCreate: async (payload: CreateChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const context = mutationBody(payload, identity, 'create');
      const body: CreateBody = {
        ...context,
        title: payload.title,
      };
      if (payload.body !== undefined) body.body = payload.body;
      if (payload.draft !== undefined) body.draft = payload.draft;
      if (payload.remote) body.remote = payload.remote;
      if (payload.headRemote) body.headRemote = payload.headRemote;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/create', body);
      return parseMutationReceipt(result, payload, identity, parseCreateMutationResult);
    },
    issueUpdate: async (payload: UpdateIssueInput) => {
      const identity = normalizeIdentity(payload);
      const body: UpdateBody = { ...mutationBody(payload, identity, 'existing'), title: payload.title };
      if (payload.body !== undefined) body.body = payload.body;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/update', body);
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestCommentUpdate: async (payload: CommentUpdateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/comment/update', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestCommentDelete: async (payload: CommentDeleteInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/comment/delete', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    issueCommentUpdate: async (payload: CommentUpdateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/comment/update', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    issueCommentDelete: async (payload: CommentDeleteInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/comment/delete', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    discussionCommentUpdate: async (payload: CommentUpdateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/comment/update', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    discussionCommentDelete: async (payload: CommentDeleteInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/comment/delete', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestUpdate: async (payload: UpdateChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const body: UpdateBody = { ...mutationBody(payload, identity, 'existing'), title: payload.title };
      if (payload.body !== undefined) body.body = payload.body;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/update', body);
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestMerge: async (payload: MergeChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      if (payload.force !== undefined && payload.force !== true && payload.force !== false) {
        throw new SourceControlRequestError('Force merge must be a boolean', 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT');
      }
      if (payload.force === true && identity.provider !== 'github') {
        throw new SourceControlRequestError('Force merge is not supported by this provider', 'SOURCE_CONTROL_FORCE_MERGE_UNSUPPORTED');
      }
      const body: MutationBody<SourceControlExistingMutationTarget> & { method: MergeChangeRequestInput['method']; cancel?: boolean; force?: boolean } = {
        ...mutationBody(payload, identity, 'existing'),
        method: payload.method,
        cancel: payload.cancel,
      };
      if (payload.force === true) body.force = true;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/merge', body);
      return parseMutationReceipt(result, payload, identity, parseMergeMutationResult);
    },
    changeRequestReady: async (payload: ReadyChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/ready', mutationBody(payload, identity, 'existing'));
      return parseMutationReceipt(result, payload, identity, parseReadyMutationResult);
    },
    changeRequestDraft: async (payload: DraftChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/draft', mutationBody(payload, identity, 'existing'));
      return parseMutationReceipt(result, payload, identity, parseDraftMutationResult);
    },
    changeRequestComment: async (payload: CommentInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/comment', {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestStartThread: async (payload: CommentInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/thread/start', {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReplyToThread: async (payload: ThreadReplyInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/thread/reply', {
        ...mutationBody(payload, identity, 'existing'), threadId: payload.threadId, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestResolveThread: async (payload: ThreadResolveInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/thread/resolve', {
        ...mutationBody(payload, identity, 'existing'), threadId: payload.threadId, resolved: payload.resolved,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReview: async (payload: ReviewChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const context = mutationBody(payload, identity, 'existing');

      let body: ReviewBody;
      if (payload.votes !== undefined) {
        const entries = Object.entries(payload.votes);
        if (payload.verdict !== undefined || (entries.length === 0 && payload.publishDrafts !== true)
          || entries.some(([label, value]) => !isNonEmptyString(label) || !isVoteValue(value))) {
          throw new Error('Source control review input is invalid');
        }
        body = { ...context, votes: Object.fromEntries(entries), publishDrafts: payload.publishDrafts };
      } else {
        body = { ...context, verdict: payload.verdict };
      }
      if (payload.body !== undefined) body.body = payload.body;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review', body);
      return parseMutationReceipt(result, payload, identity, parseReviewMutationResult);
    },
    changeRequestReviewState: (context, ref) => fetchChangeRequestReviewState(fetch, context, ref),
    changeRequestReviewComment: async (payload: ReviewCommentInput) => {
      const identity = normalizeIdentity(payload);
      const position = payload.line === undefined
        ? { path: payload.path }
        : { path: payload.path, side: payload.side, line: payload.line, startLine: payload.startLine };
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review/comment', {
        ...mutationBody(payload, identity, 'existing'), ...position, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReviewCommentUpdate: async (payload: ReviewCommentUpdateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review/comment/update', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReviewCommentDelete: async (payload: ReviewCommentDeleteInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review/comment/delete', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReviewDiscard: async (payload: ReviewDiscardInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review/discard', mutationBody(payload, identity, 'existing'));
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    githubPendingReview: async (context, pull) => {
      const identity = normalizeIdentity(context);
      if (identity.provider !== 'github') throw new Error('Pending reviews require GitHub');
      const query = boundReadQuery(context);
      query.set('owner', pull.owner); query.set('repo', pull.repo); query.set('number', String(pull.number));
      return githubPendingReviewStateSchema.parse(await request(fetch, identity, '/pr/review/pending', {}, query));
    },
    githubPendingReviewAction: async (payload) => {
      const identity = normalizeIdentity(payload);
      if (identity.provider !== 'github') throw new Error('Pending reviews require GitHub');
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review/pending', {
        ...mutationBody(payload, identity, 'existing'), action: payload.action,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestSetState: async (payload: SetStateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/state', {
        ...mutationBody(payload, identity, 'existing'), state: payload.state,
      });
      return parseMutationReceipt(result, payload, identity, parseStateMutationResult);
    },
    issueSetState: async (payload: SetStateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/state', {
        ...mutationBody(payload, identity, 'existing'), state: payload.state,
      });
      return parseMutationReceipt(result, payload, identity, parseStateMutationResult);
    },
    changeRequestSetLabels: async (payload: SetLabelsInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/labels', {
        ...mutationBody(payload, identity, 'existing'), labels: payload.labels,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    issueSetLabels: async (payload: SetLabelsInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/labels', {
        ...mutationBody(payload, identity, 'existing'), labels: payload.labels,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestSetReviewers: async (payload: SetReviewersInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/reviewers', {
        ...mutationBody(payload, identity, 'existing'), reviewers: payload.reviewers,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    refreshProviderReads: async (identity, scope) => {
      const query = scope && 'item' in scope
        ? new URLSearchParams({ scope: 'item', owner: scope.item.owner, repo: scope.item.repo, number: String(scope.item.number) })
        : new URLSearchParams({ scope: 'lists' });
      await request<ErrorResponse>(fetch, identity, '/read-cache/refresh', { method: 'POST' }, query);
    },
    referenceLabels: async (context, project) => parseLabelChoices(await readRepositoryChoices(fetch, context, project, '/references/labels')),
    referenceReviewers: async (context, project) => parseReviewerChoices(await readRepositoryChoices(fetch, context, project, '/references/reviewers')),
    issueComment: async (payload: CommentInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/comment', {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    discussionComment: async (payload: DiscussionCommentInput) => {
      const identity = normalizeIdentity(payload);

      const body: MutationBody<SourceControlExistingMutationTarget> & { body: string; replyTo?: string } = {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      };
      if (payload.replyTo) body.replyTo = payload.replyTo;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/comment', body);
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    discussionSetState: async (payload: SetDiscussionStateInput) => {
      const identity = normalizeIdentity(payload);
      const context = mutationBody(payload, identity, 'existing');

      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/state', payload.state === 'closed'
        ? { ...context, state: 'closed', reason: payload.reason }
        : { ...context, state: 'open' });
      return parseMutationReceipt(result, payload, identity, parseStateMutationResult);
    },
    discussionSetAnswer: async (payload: SetDiscussionAnswerInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/answer', {
        ...mutationBody(payload, identity, 'existing'), commentId: payload.commentId, answer: payload.answer,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    discussionUpdate: async (payload: UpdateDiscussionInput) => {
      const identity = normalizeIdentity(payload);
      const body: UpdateBody = { ...mutationBody(payload, identity, 'existing'), title: payload.title };
      if (payload.body !== undefined) body.body = payload.body;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/update', body);
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    discussionSetLabels: async (payload: SetLabelsInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/discussions/labels', {
        ...mutationBody(payload, identity, 'existing'), labels: payload.labels,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestsList: async (context, listOptions): Promise<PageResult<ChangeRequest>> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      if (listOptions?.query) query.set('query', listOptions.query);
      if (listOptions?.state) query.set('state', listOptions.state);
      if (listOptions?.people) query.set('people', listOptions.people);
      for (const label of listOptions?.labels ?? []) query.append('label', label);
      const payload = await request<PageResult<ChangeRequest> & ErrorResponse>(fetch, normalized, '/pulls/list', {}, query);
      if (!payload || !Array.isArray(payload.items)) throw new Error('Source control response contained invalid change requests');
      return parsePage(payload, payload.items.map((item) => parseSourceChangeRequest(item, normalized)));
    },
    changeRequestFileStats: async (context, number, options) => {
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (options?.project) {
        query.set('owner', options.project.owner);
        query.set('repo', options.project.name);
      }
      if (options?.expectedHeadSha) query.set('expectedHeadSha', options.expectedHeadSha);
      const payload = await request<ErrorResponse>(fetch, context, '/pulls/file-stats', { signal: options?.signal }, query);
      const result = changeRequestFileStatsSchema.parse(payload);
      if (options?.expectedHeadSha && result.headSha !== options.expectedHeadSha) throw new Error('Pull request changed; refresh and try again');
      return result;
    },
    changeRequestContext: async (context, number, contextOptions): Promise<ChangeRequestContext> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (contextOptions?.includeDiff) query.set('diff', '1');
      if (contextOptions?.includeCIDetails) query.set('checkDetails', '1');
      if (contextOptions?.includeTimeline) query.set('timeline', '1');
      if (contextOptions?.revision) query.set('revision', contextOptions.revision);
      if (contextOptions?.project) {
        query.set('owner', contextOptions.project.owner);
        query.set('repo', contextOptions.project.name);
      }
      const payload = await request<ChangeRequestContext & ErrorResponse>(fetch, normalized, '/pulls/context', {}, query);
      const result: ChangeRequestContext = {
        identity: normalized,
        project: payload.project ? parseSourceProject(payload.project, normalized) : null,
        changeRequest: payload.changeRequest ? parseSourceChangeRequest(payload.changeRequest, normalized) : null,
        issueComments: payload.issueComments.map((comment) => parseSourceComment(comment, normalized)),
        reviewComments: payload.reviewComments.map((comment) => parseSourceReviewComment(comment, normalized)),
        files: payload.files.map((file) => ({ ...file })),
        diff: payload.diff,
        ci: parseSourceCI(payload.ci, normalized),
        fetchedAt: payload.fetchedAt,
      };

      if (payload.commits) {
        result.commits = payload.commits.map(parseSourceCommit);
        result.commitsComplete = payload.commitsComplete !== false;
        result.verdicts = (payload.verdicts ?? []).map((verdict) => parseSourceVerdict(verdict, normalized));
        if (payload.reviewers) result.reviewers = payload.reviewers.map((user) => parseSourceUser(user, normalized));
      }
      if (payload.stack === null) result.stack = null;
      else if (payload.stack !== undefined) {
        const stack = parseOptionalStack(payload.stack);
        if (stack) result.stack = stack;
      }

      if (payload.voteLabels !== undefined) {
        if (!Array.isArray(payload.voteLabels)) throw new Error('Source control response contained invalid vote labels');
        result.voteLabels = payload.voteLabels.map((label) => parseSourceVoteLabel(label, normalized));
      }
      if (payload.submitRequirements !== undefined) {
        if (!Array.isArray(payload.submitRequirements)) throw new Error('Source control response contained invalid submit requirements');
        result.submitRequirements = payload.submitRequirements.map(parseSourceSubmitRequirement);
      }
      if (payload.revisions !== undefined) {
        if (!Array.isArray(payload.revisions)) throw new Error('Source control response contained invalid revisions');
        result.revisions = payload.revisions.map((revision) => parseSourceRevision(revision, normalized));
      }
      return result;
    },

    issuesList: async (context, listOptions): Promise<PageResult<Issue>> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      if (listOptions?.query) query.set('query', listOptions.query);
      if (listOptions?.state) query.set('state', listOptions.state);
      if (listOptions?.people) query.set('people', listOptions.people);
      for (const label of listOptions?.labels ?? []) query.append('label', label);
      const payload = await request<PageResult<Issue> & ErrorResponse>(fetch, normalized, '/issues/list', {}, query);
      if (!payload || !Array.isArray(payload.items)) throw new Error('Source control response contained invalid issues');
      return parsePage(payload, payload.items.map((item) => parseSourceIssue(item, normalized)));
    },
    issueGet: async (context, number, projectSelector) => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (projectSelector) {
        query.set('owner', projectSelector.owner);
        query.set('repo', projectSelector.name);
      }

      const payload = await request<(Issue & ErrorResponse) | null>(fetch, normalized, '/issues/get', {}, query);
      return payload === null ? null : parseSourceIssue(payload, normalized);
    },
    issueComments: async (context, number, projectSelector): Promise<IssueComment[]> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (projectSelector) {
        query.set('owner', projectSelector.owner);
        query.set('repo', projectSelector.name);
      }
      const payload = await request<IssueComment[] & ErrorResponse>(fetch, normalized, '/issues/comments', {}, query);
      if (!Array.isArray(payload)) throw new Error('Source control response contained invalid comments');
      return payload.map((comment) => parseSourceComment(comment, normalized));
    },
    projectUpstream: async (context): Promise<ProjectUpstream> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      const payload = await request<ProjectUpstream & ErrorResponse>(fetch, normalized, '/repo/upstream', {}, query);
      if (!payload || !hasMatchingIdentity(payload.identity, normalized) || !isBooleanValue(payload.isFork)
        || (payload.upstream !== null && payload.upstream === undefined)
        || payload.isFork !== Boolean(payload.upstream)) {
        throw new Error('Source control response contained an invalid upstream');
      }
      return { identity: normalized, isFork: payload.isFork, upstream: payload.upstream ? parseSourceProject(payload.upstream, normalized) : null };
    },
    projectBranches: async (context, owner, project) => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('owner', owner);
      query.set('repo', project);
      const payload = await request<BranchesDTO & ErrorResponse>(fetch, normalized, '/repo/branches', {}, query);
      return parseBranches(payload);
    },
    references: (context, referenceOptions) => fetchRepositoryReferences(fetch, context, referenceOptions),
    referencesAcross: (contexts, referenceOptions) => fetchRepositoryReferencesAcross(fetch, contexts, referenceOptions),
    referenceDetail: (context, item) => fetchRepositoryReferenceDetail(fetch, context, item),
    changeRequestListStatuses: (context, refs) => fetchChangeRequestListStatuses(fetch, context, refs),
    ciRunsList: async (context, listOptions): Promise<CiWorkflowRunPage> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      const status: CiRunStatusFilter = listOptions?.status ?? 'all';
      query.set('status', status);
      if (listOptions?.branch) query.set('branch', listOptions.branch);
      if (listOptions?.query) query.set('query', listOptions.query);
      const payload = await request<CiWorkflowRunPage & ErrorResponse>(fetch, normalized, '/ci/runs', {}, query);
      return parseCiWorkflowRunPage(payload, normalized);
    },
    ciRunDetail: async (context, runId): Promise<CiWorkflowRunDetail> => {
      const normalized = normalizeIdentity(context);
      if (!/^[1-9]\d*$/.test(String(runId).trim())) {
        throw new Error('Source control CI runId must be a positive integer');
      }
      const query = boundReadQuery(context);
      query.set('runId', String(runId).trim());
      const payload = await request<CiWorkflowRunDetail & ErrorResponse>(fetch, normalized, '/ci/run', {}, query);
      return parseCiWorkflowRunDetail(payload, normalized);
    },
    ciJobLog: async (context, jobId): Promise<CiJobLogResult> => {
      const normalized = normalizeIdentity(context);
      if (!/^[1-9]\d*$/.test(String(jobId).trim())) {
        throw new Error('Source control CI jobId must be a positive integer');
      }
      const query = boundReadQuery(context);
      query.set('jobId', String(jobId).trim());
      const payload = await request<CiJobLogResult & ErrorResponse>(fetch, normalized, '/ci/job-log', {}, query);
      return parseCiJobLogResult(payload, normalized);
    },
  };
};
