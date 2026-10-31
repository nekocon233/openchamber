import { z } from 'zod';
import { MAX_PULL_REQUEST_PATCH_BYTES } from '../git/pull-request-snapshot.js';

const tooLargeSchema = z.object({
  status: z.union([z.literal(406), z.literal(422)]),
  response: z.object({ data: z.object({ errors: z.array(z.object({
    resource: z.string(), field: z.string(), code: z.string(),
  })) }) }),
});
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const pullSchema = z.object({ number: z.number().int().positive(), head: z.object({ sha }), base: z.object({ sha }) });
const compareSchema = z.object({ merge_base_commit: z.object({ sha }) });
const patchSchema = z.string().refine((patch) => /^(?:diff --git |\s*$)/.test(patch));
const filesSchema = z.array(z.object({
  filename: z.string().min(1), status: z.string().min(1),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), changes: z.number().int().nonnegative(),
  patch: z.string().nullish(),
}));

/** Small PRs use GitHub's patch; only its explicit size refusal permits a Git transfer. */
export async function readGitHubPullPatch({ octokit, repo, number, readSnapshot, signal, includeRevision = false }) {
  const readRevision = async () => pullSchema.parse((await octokit.rest.pulls.get({
    owner: repo.owner, repo: repo.repo, pull_number: number, request: { signal },
  })).data);
  const before = includeRevision ? await readRevision() : null;
  let response;
  try {
    const request = {
      owner: repo.owner, repo: repo.repo, pull_number: number,
      headers: { accept: 'application/vnd.github.v3.diff' },
    };
    if (signal) request.request = { signal };
    response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', request);
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
  const result = { patch: parsed.data };
  if (before) {
    const after = await readRevision();
    if (before.head.sha !== after.head.sha || before.base.sha !== after.base.sha || before.number !== number || after.number !== number) {
      throw Object.assign(new Error('Pull request changed; refresh the diff'), { status: 409, code: 'STALE_CONFIG' });
    }
    result.headSha = before.head.sha;
  }
  return result;
}

/** Complete file metadata, including API pagination and GitHub's 3,000-file ceiling. */
export async function readGitHubPullFiles({ octokit, repo, number, expectedCount, readSnapshot, signal }) {
  const localFiles = async () => {
    if (!(readSnapshot instanceof Function)) throw new Error('GitHub pull request file list is incomplete');
    return (await readSnapshot()).files;
  };
  if (expectedCount > 3000) return localFiles();
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await octokit.rest.pulls.listFiles({
      owner: repo.owner, repo: repo.repo, pull_number: number, per_page: 100, page, request: { signal },
    });
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

/** The repository was authorized by the caller; all transfer coordinates come from this read. */
export async function resolveGitHubPullSnapshot({ octokit, repo, number, context, expectedHeadSha, expectedBaseSha }) {
  const pull = pullSchema.parse((await octokit.rest.pulls.get({
    owner: repo.owner, repo: repo.repo, pull_number: number,
  })).data);
  if (pull.number !== number || (expectedHeadSha && pull.head.sha !== expectedHeadSha)
    || (expectedBaseSha && pull.base.sha !== expectedBaseSha)) {
    throw Object.assign(new Error('Pull request changed; refresh and try again'), { status: 409, code: 'STALE_CONFIG' });
  }
  const comparison = compareSchema.parse((await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner, repo: repo.repo, basehead: `${pull.base.sha}...${pull.head.sha}`,
  })).data);
  return {
    context, repo: { owner: repo.owner, repo: repo.repo }, number,
    headSha: pull.head.sha, baseSha: pull.base.sha, mergeBaseSha: comparison.merge_base_commit.sha,
    endpoint: `https://github.com/${repo.owner}/${repo.repo}.git`,
  };
}
