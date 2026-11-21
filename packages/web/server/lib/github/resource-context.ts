import { isProviderString, mapChangeRequest, mapComment, mapFile, mapProject, mapReviewComment } from './mappers.js';
import { fetchPullStack } from './reference-search.js';
import type { Octokit } from '@octokit/rest';
import type { ProviderSession } from '../source-control/provider-contract.js';
import type { ContributorProvenanceRead } from '../git/contributor-provenance-storage.js';
import type { AcrossContext, AcrossGroup, DiscoveryRepository, GitHubEnvelope } from './contracts.js';
import type { CI } from './mappers.js';

export type Identity = Pick<ReturnType<typeof mapProject>, 'provider' | 'instance'>;

export interface GitHubResourceModules {
  octokit: typeof import('./octokit.js');
  summaries: typeof import('./pr-summaries.js');
  rateLimit: typeof import('./rate-limit.js');
  patch: typeof import('./change-request-patch.js');
  prStatus: typeof import('./pr-status.js');
  checks: typeof import('./checks-summary.js');
  repo: typeof import('./repo/index.js');
  forks: typeof import('./repo/fork-detection.js');
  git: typeof import('../git/index.js');
}

export interface GitHubResourceOptions {
  readPullRequestSnapshot?: ReturnType<typeof import('../git/network-operations.js').createNetworkOperations>['readPullRequestSnapshot'] | undefined;
  load: () => Promise<GitHubResourceModules>;
  accountOf: (session: ProviderSession) => { octokit: Octokit; user: { login?: string } | null };
  resolveRepo: typeof import('./repo/index.js').resolveGitHubRepoFromDirectory;
  resolveNetwork: typeof import('./repo/fork-detection.js').resolveRepoNetwork;
  resolvePrStatus: typeof import('./pr-status.js').resolveGitHubPrStatus;
  readContributorProvenance?: ((directory: string) => Promise<ContributorProvenanceRead>) | undefined;
  invalidateAccount: (identity: GitHubEnvelope['data'], persisted: boolean) => Promise<boolean>;
}

export interface ContextScope {
  accountId: string;
  credentialRevision: number | null;
  repositoryId: string | undefined;
  bindingRevision: number | undefined;
  primaryRemote: string;
  number: number | undefined;
}

export interface PullContext {
  identity: Identity;
  fetchedAt: number;
  project: ReturnType<typeof mapProject>;
  changeRequest: ReturnType<typeof mapChangeRequest>;
  issueComments: ReturnType<typeof mapComment>[];
  reviewComments: ReturnType<typeof mapReviewComment>[];
  files: ReturnType<typeof mapFile>[];
  ci: CI | null;
  diff?: string;
  stack?: Awaited<ReturnType<typeof fetchPullStack>>;
}

export interface PageResult<Item> {
  items: Item[];
  page: number;
  hasMore: boolean;
  incompleteProjectIds?: string[];
}

export interface RepositoryFailure { repoRef: DiscoveryRepository; error: unknown }

export type FolderStatus = 'invalid-context' | 'no-repo' | 'disconnected' | 'error';

interface IncludedFolder {
  directory: string;
  status: 'included' | FolderStatus;
  repo: DiscoveryRepository;
  repos: import('./repo/fork-detection.js').NetworkRepository[];
  octokit: Octokit;
  trusted: AcrossContext;
}

export type SearchFolder = IncludedFolder | { directory: string; status: FolderStatus };

export interface AccountGroup extends Omit<AcrossGroup, 'repos'> {
  folders: IncludedFolder[];
  repositories: Map<string, AcrossGroup['repos'][number]>;
}

const hasErrorField = <Key extends string>(value: unknown, key: Key): value is Record<Key, unknown> =>
  value != null && key in Object(value);

export const errorField = (value: GitHubEnvelope['data'], key: string) =>
  hasErrorField(value, key) ? value[key] : undefined;

export const errorStatus = (error: GitHubEnvelope['data']) => errorField(error, 'status') ?? errorField(errorField(error, 'response'), 'status');

const isErrorCodeMethod = (value: unknown): value is (prefix: string) => GitHubEnvelope['code'] => typeof value === 'function';

export const errorCodeStartsWith = (code: GitHubEnvelope['code'], prefix: string) => {
  if (code == null) return undefined;
  const method = errorField(code, 'startsWith');
  if (!isErrorCodeMethod(method)) throw new TypeError('code.startsWith is not a function');
  return Boolean(method.call(code, prefix));
};

const PR_CONTEXT_CACHE_TTL_MS = 30_000;

const PR_CONTEXT_CACHE_MAX_ENTRIES = 50;

export const GITHUB_COM = 'github.com';

const PULL_LIST_STATES = new Set(['open', 'closed', 'merged', 'all']);

const PULL_LIST_PEOPLE = new Set(['any', 'assigned', 'created', 'reviewRequested']);

export const isPullListState = (value: string): value is 'open' | 'closed' | 'merged' | 'all' => PULL_LIST_STATES.has(value);

export const isPullListPeople = (value: string): value is 'any' | 'assigned' | 'created' | 'reviewRequested' => PULL_LIST_PEOPLE.has(value);

export const CAN_MERGE_REFUSAL_TTL_MS = 5 * 60_000;

export const CAN_MERGE_REFUSAL_MAX_ENTRIES = 1000;

export const responseError = <Body extends { error: unknown }>(status: number, body: Body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

export const sourceControlError = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

export const notInProject = () => responseError(400, { error: 'Repository is not part of this project' });

export const rateLimited = () => Object.assign(new Error('GitHub rate limited'), { status: 503 });

export const sameRepository = (left: Pick<DiscoveryRepository, 'owner' | 'repo'>, right: Pick<DiscoveryRepository, 'owner' | 'repo'>) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

export const gitHubRefusalMessage = (error: GitHubEnvelope['data']) => {
  const message = errorField(errorField(errorField(error, 'response'), 'data'), 'message');
  return isProviderString(message) && message.trim() ? message : errorField(error, 'message');
};

export function createContextCache() {
  const entries = new Map<string, { data: PullContext; includeCheckDetails: boolean; fetchedAt: number; scope: ContextScope }>();
  let epoch = 0;
  return Object.freeze({
    begin: () => epoch,
    read: (key: string, includeCheckDetails: boolean) => {
      const entry = entries.get(key);
      return entry && Date.now() - entry.fetchedAt < PR_CONTEXT_CACHE_TTL_MS && (entry.includeCheckDetails || !includeCheckDetails)
        ? entry.data
        : null;
    },
    store: (key: string, scope: ContextScope, data: PullContext, includeCheckDetails: boolean, started: number) => {
      if (started !== epoch) return;
      entries.delete(key);
      entries.set(key, { data, includeCheckDetails, fetchedAt: data.fetchedAt, scope });
      if (entries.size > PR_CONTEXT_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    invalidate: (scope: Partial<ContextScope>) => {
      epoch += 1;
      for (const [key, entry] of entries) {
        if (Object.entries(scope).every(([field, value]) => errorField(entry.scope, field) === value)) entries.delete(key);
      }
    },
  });
}
