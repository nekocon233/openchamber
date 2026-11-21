import assert from 'node:assert/strict';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { markGitHubAuthAccountInvalid } from '../github/auth.js';
import { getOctokitForAccountId } from '../github/octokit.js';
import { resolveGitHubRepoFromDirectory } from '../github/repo/index.js';
import { resolveRepoNetwork } from '../github/repo/fork-detection.js';
import { readGitHubPullPatch } from '../github/pull-diff.js';
import type { SourceControlIdentity } from '../github/octokit.js';
import type { GitHubPullPatchResult, GitHubPullRepo } from '../github/pull-diff.js';
import type { PullRequestSnapshot } from '../git/pull-request-snapshot.js';
import type { Json, ProviderReadContext } from '../source-control/provider-contract.js';
import type { WalkthroughSource } from './contracts.js';
import type { createBindingService } from '../source-control/binding-service.js';

export const supportsChangeRequestPatch = (provider: string) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.changeRequestPatch === true
);

export const supportsChangeRequestRevisions = (provider: string) => (
  sourceControlProviderDescriptors.get(provider)?.capabilities.revisions === true
);

export interface ChangeRequestReadInput {
  context: ProviderReadContext | undefined;
  number: number;
  sourceRepo: Extract<WalkthroughSource, { kind: 'pr' }>['sourceRepo'] | null;
  revision?: string;
  signal?: AbortSignal;
  includeRevision?: boolean;
}

export interface ChangeRequestFileInput extends ChangeRequestReadInput {
  path: string;
  previousPath: string | undefined;
  status: string;
  binary?: true | undefined;
  expectedHeadSha?: string;
}

export interface GitHubPullSnapshotReadInput {
  context: ProviderReadContext;
  repo: GitHubPullRepo;
  number: number;
  signal?: AbortSignal | undefined;
}

interface DirectGitHubDependencies {
  getOctokitForAccountId?: typeof getOctokitForAccountId | undefined;
  resolveGitHubRepoFromDirectory?: typeof resolveGitHubRepoFromDirectory | undefined;
  resolveRepoNetwork?: typeof resolveRepoNetwork | undefined;
  onAccountUnavailable?: ((identity: SourceControlIdentity) => void | Promise<void> | ReturnType<ReturnType<typeof createBindingService>['accountUnavailable']>) | undefined;
}

export interface PullRequestReadOptions extends DirectGitHubDependencies {
  allowEmpty?: boolean | undefined;
  sourceRepo?: ChangeRequestReadInput['sourceRepo'];
  revision?: string | undefined;
  signal?: AbortSignal | undefined;
  includeRevision?: boolean | undefined;
  readChangeRequestPatch?: ((input: ChangeRequestReadInput) => Promise<Json>) | undefined;
  readGitLabChangeRequestPatch?: ((input: ChangeRequestReadInput) => Promise<Json>) | undefined;
  readGitHubPullRequestSnapshot?: ((input: GitHubPullSnapshotReadInput) => Promise<GitHubPullPatchResult | PullRequestSnapshot>) | undefined;
}

export interface PullRequestFileReadOptions extends Omit<PullRequestReadOptions, 'allowEmpty' | 'readChangeRequestPatch' | 'readGitLabChangeRequestPatch' | 'readGitHubPullRequestSnapshot' | 'includeRevision'> {
  path: string;
  previousPath?: string | undefined;
  status: string;
  binary?: boolean | undefined;
  expectedHeadSha?: string | undefined;
  readChangeRequestFile?: ((input: ChangeRequestFileInput) => Promise<Json>) | undefined;
  readGitLabChangeRequestFile?: ((input: ChangeRequestFileInput) => Promise<Json>) | undefined;
}

interface PatchFields {
  patch?: Json;
  meta?: Json;
}

const hasPatchFields = (value: Json): value is Json & PatchFields => value !== null;
const isPatchText = (value: Json | undefined): value is string => typeof value === 'string';

const withOptionalFields = <T extends ChangeRequestReadInput>(
  input: T,
  extras: { revision?: string | undefined; signal?: AbortSignal | undefined; includeRevision?: boolean | undefined; expectedHeadSha?: string | undefined },
): T => {
  const next = { ...input };
  if (extras.revision) next.revision = extras.revision;
  if (extras.signal) next.signal = extras.signal;
  if (extras.includeRevision) next.includeRevision = extras.includeRevision;
  if (extras.expectedHeadSha && 'expectedHeadSha' in next) {
    next.expectedHeadSha = extras.expectedHeadSha;
  }
  return next;
};

const CHANGE_REQUEST_NOUN = { pullRequest: 'Pull request', mergeRequest: 'Merge request' };

const changeRequestLabel = (provider: string | undefined, number: number) => {
  const descriptor = sourceControlProviderDescriptors.get(provider ?? '');
  const noun = (descriptor && descriptor.terminology.changeRequest !== 'change'
    ? CHANGE_REQUEST_NOUN[descriptor.terminology.changeRequest]
    : undefined) ?? 'Change request';
  return `${noun} ${descriptor?.referencePrefix.changeRequest ?? '#'}${number}`;
};

const unavailable = (message = 'Change request reads are unavailable') => Object.assign(new Error(message), {
  statusCode: 501,
  code: 'SOURCE_CONTROL_BINDING_UNAVAILABLE',
});

const sameRepository = (left: GitHubPullRepo, right: GitHubPullRepo) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

async function resolvePullRequestRepo(
  directory: string,
  number: number,
  readContext: ProviderReadContext | undefined,
  { sourceRepo = null, ...dependencies }: { sourceRepo?: ChangeRequestReadInput['sourceRepo'] } & DirectGitHubDependencies = {},
) {
  if (!readContext || readContext.provider !== 'github') {
    throw Object.assign(new Error('A trusted GitHub read context is required'), {
      statusCode: 400,
      code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT',
    });
  }
  const getExactOctokit = dependencies.getOctokitForAccountId ?? getOctokitForAccountId;
  const account = await getExactOctokit(readContext.accountId, {
    onUnauthorized: async (identity, persisted) => {
      await dependencies.onAccountUnavailable?.(identity);
      if (persisted) await markGitHubAuthAccountInvalid(identity.accountId, 'unauthorized');
    },
  });
  if (!account) {
    throw Object.assign(new Error('GitHub account is unavailable'), {
      statusCode: 401,
      code: 'github-not-connected',
    });
  }

  const resolveRepository = dependencies.resolveGitHubRepoFromDirectory ?? resolveGitHubRepoFromDirectory;
  const { repo } = await resolveRepository(directory, readContext.primaryRemote);
  if (!repo?.owner || !repo?.repo) {
    throw Object.assign(new Error('This directory has no GitHub remote'), {
      statusCode: 400,
      code: 'no-github-remote',
    });
  }
  let target: GitHubPullRepo = repo;
  if (sourceRepo && !sameRepository(sourceRepo, repo)) {
    const resolveNetwork = dependencies.resolveRepoNetwork ?? resolveRepoNetwork;
    const network = await resolveNetwork(account.octokit, directory, readContext.primaryRemote, { strictErrors: true });
    const member = Array.isArray(network) ? network.find((entry) => sameRepository(entry, sourceRepo)) : null;
    if (!member) {
      throw Object.assign(new Error(`Pull request #${number} belongs to ${sourceRepo.owner}/${sourceRepo.repo}, which is outside this checkout's repository network`), {
        statusCode: 409,
        code: 'PULL_REQUEST_REPOSITORY_MISMATCH',
      });
    }
    target = { owner: member.owner, repo: member.repo };
  }
  return { octokit: account.octokit, repo: { owner: target.owner, repo: target.repo } };
}

async function readGitHubPullRequestDiff(
  directory: string,
  number: number,
  readContext: ProviderReadContext | undefined,
  options: PullRequestReadOptions,
): Promise<{ patch: string; meta: { [key: string]: Json } }> {
  const { octokit, repo: target } = await resolvePullRequestRepo(directory, number, readContext, options);
  const readGitHubSnapshot = options.readGitHubPullRequestSnapshot;
  const readSnapshot = readGitHubSnapshot && readContext
    ? () => readGitHubSnapshot({
      context: readContext,
      repo: target,
      number,
      signal: options.signal,
    })
    : undefined;
  const result = await readGitHubPullPatch({
    octokit,
    repo: target,
    number,
    signal: options.signal,
    includeRevision: options.includeRevision,
    readSnapshot,
  });
  const meta = { owner: target.owner, repo: target.repo, number };
  return { patch: result.patch, meta: result.headSha ? { ...meta, headSha: result.headSha } : meta };
}

const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;

function assertFileText(content: unknown): asserts content is string {
  assert.equal(typeof content, 'string', 'GitHub returned invalid file contents');
}

export async function getPullRequestDiff(
  directory: string,
  number: number,
  readContext: ProviderReadContext | undefined,
  options: PullRequestReadOptions = {},
): Promise<{ patch: Json | undefined; meta: Json | undefined }> {
  const {
    allowEmpty = false,
    sourceRepo = null,
    revision,
    signal,
    includeRevision,
    readChangeRequestPatch,
    readGitLabChangeRequestPatch,
  } = options;

  let result: Json;
  if (readChangeRequestPatch instanceof Function) {
    result = await readChangeRequestPatch(withOptionalFields({ context: readContext, number, sourceRepo }, { revision, signal, includeRevision }));
  } else if (readContext?.provider === 'gitlab') {
    if (!(readGitLabChangeRequestPatch instanceof Function)) {
      throw unavailable('GitLab merge request reads are unavailable');
    }
    result = await readGitLabChangeRequestPatch(withOptionalFields({ context: readContext, number, sourceRepo }, { revision, signal, includeRevision }));
  } else {
    result = await readGitHubPullRequestDiff(directory, number, readContext, options);
  }

  if (!hasPatchFields(result)) throw new TypeError("Cannot destructure property 'patch' of '(intermediate value)' as it is null.");
  const { patch, meta } = result;
  let empty = false;
  if (!allowEmpty) {
    if (!isPatchText(patch)) {
      if (patch === null || patch === undefined) throw new TypeError(`Cannot read properties of ${patch} (reading 'trim')`);
      throw new TypeError('patch.trim is not a function');
    }
    empty = !patch.trim();
  }
  if (!allowEmpty && empty) {
    throw Object.assign(new Error(`${changeRequestLabel(readContext?.provider, number)} has no diff`), {
      statusCode: 404,
      code: 'empty-diff',
    });
  }
  return { patch, meta };
}

export async function getPullRequestFileContents(
  directory: string,
  number: number,
  readContext: ProviderReadContext | undefined,
  options: PullRequestFileReadOptions,
): Promise<Json> {
  const {
    path,
    previousPath,
    status,
    sourceRepo = null,
    revision,
    binary = false,
    expectedHeadSha,
    readChangeRequestFile,
    readGitLabChangeRequestFile,
  } = options;

  if (readChangeRequestFile instanceof Function) {
    const input: ChangeRequestFileInput = {
      context: readContext,
      number,
      sourceRepo,
      path,
      previousPath,
      status,
      binary: binary || undefined,
    };
    if (revision) input.revision = revision;
    if (expectedHeadSha) input.expectedHeadSha = expectedHeadSha;
    return readChangeRequestFile(input);
  }

  if (readContext?.provider === 'gitlab') {
    if (!(readGitLabChangeRequestFile instanceof Function)) {
      throw unavailable('GitLab merge request reads are unavailable');
    }
    const input: ChangeRequestFileInput = {
      context: readContext,
      number,
      sourceRepo,
      path,
      previousPath,
      status,
    };
    if (binary) input.binary = true;
    if (revision) input.revision = revision;
    if (expectedHeadSha) input.expectedHeadSha = expectedHeadSha;
    return readGitLabChangeRequestFile(input);
  }

  const { octokit, repo } = await resolvePullRequestRepo(directory, number, readContext, options);
  const pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
  });
  const headSha = pull.data?.head?.sha;
  const baseSha = pull.data?.base?.sha;
  assert.match(String(headSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request head');
  assert.match(String(baseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid pull request base');
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    throw Object.assign(new Error('Pull request changed; refresh the diff'), { statusCode: 409, code: 'STALE_CONFIG' });
  }
  const compare = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${baseSha}...${headSha}`,
  });
  const mergeBaseSha = compare.data?.merge_base_commit?.sha;
  assert.match(String(mergeBaseSha), /^[0-9a-f]{40}$/, 'GitHub returned an invalid merge base');

  const readFile = async (filePath: string, ref: string): Promise<string> => {
    const response: { data: unknown } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.repo,
      path: filePath,
      ref,
      headers: { accept: 'application/vnd.github.raw+json' },
    });
    const content = response.data;
    assertFileText(content);
    if (Buffer.byteLength(content) > MAX_FULL_FILE_BYTES) {
      throw Object.assign(new Error('This file is too large to show in full'), { statusCode: 413, code: 'file-too-large' });
    }
    return content;
  };

  const [original, modified] = await Promise.all([
    status === 'A' ? '' : readFile(previousPath || path, mergeBaseSha),
    status === 'D' ? '' : readFile(path, headSha),
  ]);
  return { original, modified };
}
