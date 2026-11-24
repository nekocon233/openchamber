import { z } from 'zod';
import { MAX_PULL_REQUEST_PATCH_BYTES } from '../git/pull-request-snapshot.js';
import type { PullRequestSnapshot, PullRequestSnapshotFile } from '../git/pull-request-snapshot.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { Octokit } from './contracts.js';

export interface GitHubPullRepo {
  owner: string;
  repo: string;
}

export interface GitHubPullPatchResult {
  patch: string;
  files?: PullRequestSnapshot['files'];
  headSha?: string;
}

export type GitHubPullFileEntry = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null | undefined;
  previous_filename?: string | undefined;
};

export interface ReadGitHubPullPatchInput {
  octokit: Octokit;
  repo: GitHubPullRepo;
  number: number;
  readSnapshot?: (() => Promise<GitHubPullPatchResult | PullRequestSnapshot>) | undefined;
  signal?: AbortSignal | undefined;
  includeRevision?: boolean | undefined;
}

export interface ReadGitHubPullFilesInput {
  octokit: Octokit;
  repo: GitHubPullRepo;
  number: number;
  expectedCount?: number | undefined;
  readSnapshot?: (() => Promise<Pick<PullRequestSnapshot, 'files'>>) | undefined;
  signal?: AbortSignal | undefined;
}

export interface ResolveGitHubPullSnapshotInput {
  octokit: Octokit;
  repo: GitHubPullRepo;
  number: number;
  context: ProviderReadContext;
  expectedHeadSha?: string | undefined;
  expectedBaseSha?: string | undefined;
}

const tooLargeSchema = z.object({
  status: z.union([z.literal(406), z.literal(422)]),
  response: z.object({
    data: z.object({
      errors: z.array(z.object({
        resource: z.string(),
        field: z.string(),
        code: z.string(),
      })),
    }),
  }),
});
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const pullSchema = z.object({ number: z.number().int().positive(), head: z.object({ sha }), base: z.object({ sha }) });
const compareSchema = z.object({ merge_base_commit: z.object({ sha }) });
const patchSchema = z.string().refine((patch) => /^(?:diff --git |\s*$)/.test(patch));
const filesSchema = z.array(z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().nullish(),
  previous_filename: z.string().min(1).optional(),
}));

export async function readGitHubPullPatch({
  octokit,
  repo,
  number,
  readSnapshot,
  signal,
  includeRevision = false,
}: ReadGitHubPullPatchInput): Promise<GitHubPullPatchResult> {
  const pullParameters = () => {
    const params: Parameters<Octokit['rest']['pulls']['get']>[0] = {
      owner: repo.owner, repo: repo.repo, pull_number: number,
    };
    if (signal) params.request = { signal };
    return params;
  };
  const readRevision = async () => pullSchema.parse((await octokit.rest.pulls.get(pullParameters())).data);
  const before = includeRevision ? await readRevision() : null;
  let response: { data: unknown };
  try {
    response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...pullParameters(),
      headers: { accept: 'application/vnd.github.v3.diff' },
    });
  } catch (error) {
    const refusal = tooLargeSchema.safeParse(error);
    const tooLarge = refusal.success && refusal.data.response.data.errors.some((entry) => (
      entry.resource === 'PullRequest' && entry.field === 'diff' && entry.code === 'too_large'
    ));
    if (!tooLarge || !(readSnapshot instanceof Function)) throw error;
    return readSnapshot();
  }
  const parsed = patchSchema.safeParse(response.data);
  if (!parsed.success) throw new Error('GitHub returned an invalid pull request diff');
  if (Buffer.byteLength(parsed.data) > MAX_PULL_REQUEST_PATCH_BYTES) {
    throw Object.assign(new Error('Pull request diff exceeds the 20 MiB limit'), { status: 413, code: 'PR_DIFF_TOO_LARGE' });
  }
  const result: GitHubPullPatchResult = { patch: parsed.data };
  if (before) {
    const after = await readRevision();
    if (before.head.sha !== after.head.sha || before.base.sha !== after.base.sha || before.number !== number || after.number !== number) {
      throw Object.assign(new Error('Pull request changed; refresh the diff'), { status: 409, code: 'STALE_CONFIG' });
    }
    result.headSha = before.head.sha;
  }
  return result;
}

export async function readGitHubPullFiles({
  octokit,
  repo,
  number,
  expectedCount,
  readSnapshot,
  signal,
}: ReadGitHubPullFilesInput): Promise<Array<GitHubPullFileEntry | PullRequestSnapshotFile>> {
  const localFiles = async () => {
    if (!(readSnapshot instanceof Function)) throw new Error('GitHub pull request file list is incomplete');
    return (await readSnapshot()).files;
  };
  if (expectedCount !== undefined && expectedCount > 3000) return localFiles();
  const files: GitHubPullFileEntry[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const params: Parameters<Octokit['rest']['pulls']['listFiles']>[0] = {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      per_page: 100,
      page,
    };
    if (signal) params.request = { signal };
    const response = await octokit.rest.pulls.listFiles(params);
    const parsed = filesSchema.safeParse(response.data);
    if (!parsed.success) throw new Error('GitHub returned an invalid pull request file list');
    files.push(...parsed.data);
    if (parsed.data.length < 100 || files.length === expectedCount) {
      if (Number.isSafeInteger(expectedCount) && files.length !== expectedCount) {
        throw Object.assign(new Error('Pull request files changed; refresh and try again'), { code: 'STALE_CONFIG', status: 409 });
      }
      return files;
    }
  }
  return localFiles();
}

export async function resolveGitHubPullSnapshot({
  octokit,
  repo,
  number,
  context,
  expectedHeadSha,
  expectedBaseSha,
}: ResolveGitHubPullSnapshotInput) {
  const pull = pullSchema.parse((await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
  })).data);
  if (
    pull.number !== number
    || (expectedHeadSha && pull.head.sha !== expectedHeadSha)
    || (expectedBaseSha && pull.base.sha !== expectedBaseSha)
  ) {
    throw Object.assign(new Error('Pull request changed; refresh and try again'), { status: 409, code: 'STALE_CONFIG' });
  }
  const comparison = compareSchema.parse((await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${pull.base.sha}...${pull.head.sha}`,
  })).data);
  return {
    context,
    repo: { owner: repo.owner, repo: repo.repo },
    number,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    mergeBaseSha: comparison.merge_base_commit.sha,
    endpoint: `https://${context?.instance ?? 'github.com'}/${repo.owner}/${repo.repo}.git`,
  };
}
