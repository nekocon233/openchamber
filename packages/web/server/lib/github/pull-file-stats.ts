import { z } from 'zod';
import { readGitHubPullFiles, type ReadGitHubPullFilesInput } from './pull-diff.js';
import type { PullRequestSnapshotRequest } from '../git/network-execution-contracts.js';
import type { PullRequestSnapshot } from '../git/pull-request-snapshot.js';

type PullFileStatsInput = Pick<ReadGitHubPullFilesInput, 'octokit' | 'repo' | 'signal'>
  & Pick<PullRequestSnapshotRequest, 'context' | 'number'> & {
    expectedHeadSha?: string | undefined;
    readSnapshot?: ((input: PullRequestSnapshotRequest & { signal?: AbortSignal | undefined }) => Promise<Pick<PullRequestSnapshot, 'files'>>) | undefined;
  };

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const revisionSchema = z.object({
  number: z.number().int().positive(), head: z.object({ sha }), base: z.object({ sha }),
  changed_files: z.number().int().nonnegative(),
});
const stale = () => Object.assign(new Error('Pull request changed; refresh and try again'), { status: 409, code: 'STALE_CONFIG' });

export async function readGitHubPullFileStats({ octokit, repo, number, context, expectedHeadSha, readSnapshot, signal }: PullFileStatsInput) {
  const revision = async () => revisionSchema.parse((await octokit.rest.pulls.get({
    owner: repo.owner, repo: repo.repo, pull_number: number, request: { signal },
  })).data);
  const before = await revision();
  if (before.number !== number || (expectedHeadSha && before.head.sha !== expectedHeadSha)) throw stale();
  const files = await readGitHubPullFiles({
    octokit, repo, number, expectedCount: before.changed_files, signal,
    readSnapshot: readSnapshot ? () => readSnapshot({
      context, repo, number, expectedHeadSha: before.head.sha, expectedBaseSha: before.base.sha, signal,
    }) : undefined,
  });
  if (files.length !== before.changed_files || new Set(files.map(file => file.filename)).size !== files.length) {
    throw new Error('GitHub returned incomplete pull request file statistics');
  }
  const after = await revision();
  if (after.number !== number || before.head.sha !== after.head.sha || before.base.sha !== after.base.sha
    || before.changed_files !== after.changed_files) throw stale();
  return {
    headSha: before.head.sha, baseSha: before.base.sha,
    files: files.map(({ filename: path, additions, deletions }) => ({ path, additions, deletions })),
  };
}
