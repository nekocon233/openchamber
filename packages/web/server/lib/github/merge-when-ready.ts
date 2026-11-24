import { z } from 'zod';
import { invalidProviderPayload } from './mappers.js';
import { hasProperty } from './contracts.js';
import type { Octokit } from '@octokit/rest';

interface MergeProject {
  owner: string;
  name: string;
}

interface MergeTarget {
  number?: number;
  base?: string;
  headSha?: string;
}

const autoMergeRequestSchema = z.object({ enabledAt: z.string().min(1), mergeMethod: z.string().min(1) });
const enableResponseSchema = z.object({
  enablePullRequestAutoMerge: z.object({ pullRequest: z.object({ autoMergeRequest: autoMergeRequestSchema }) }),
});

const pullSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  headRefOid: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  isInMergeQueue: z.boolean(),
  autoMergeRequest: autoMergeRequestSchema.nullable(),
});

export const hasRequestedAutoMerge = (pull: z.infer<typeof pullSchema>, target: MergeTarget, method: string | undefined): boolean => (
  pull.state === 'OPEN' && pull.headRefOid === target.headSha
    && Boolean(method && pull.autoMergeRequest?.mergeMethod === method.toUpperCase())
);

export async function readWaitingMerge(octokit: Octokit, project: MergeProject, target: MergeTarget) {
  const data = await octokit.graphql(`query($owner: String!, $repo: String!, $number: Int!, $base: String!) {
    repository(owner: $owner, name: $repo) {
      mergeQueue(branch: $base) { id }
      pullRequest(number: $number) {
        id state headRefOid mergeable mergeStateStatus isInMergeQueue
        autoMergeRequest { enabledAt mergeMethod }
      }
    }
  }`, { owner: project.owner, repo: project.name, number: target.number, base: target.base });
  const parsed = z.object({ repository: z.object({ mergeQueue: z.object({ id: z.string() }).nullable(), pullRequest: pullSchema }) }).safeParse(data);
  if (!parsed.success) throw invalidProviderPayload('GitHub returned an invalid waiting merge state');
  return { pull: parsed.data.repository.pullRequest, hasQueue: parsed.data.repository.mergeQueue !== null };
}

export async function enableMergeWhenReady(octokit: Octokit, project: MergeProject, target: MergeTarget, method: string) {
  let waiting;
  try { waiting = await readWaitingMerge(octokit, project, target); }
  catch { return null; }
  const { pull, hasQueue } = waiting;
  if (hasQueue || pull.isInMergeQueue || pull.state !== 'OPEN' || pull.headRefOid !== target.headSha
    || pull.mergeable === 'CONFLICTING' || !['BLOCKED', 'UNSTABLE'].includes(pull.mergeStateStatus)) return null;
  const mergeMethod = method.toUpperCase();
  if (!hasRequestedAutoMerge(pull, target, method)) {
    const data = await octokit.graphql<unknown>(`mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod, expectedHeadOid: $sha }) {
        pullRequest { autoMergeRequest { enabledAt mergeMethod } }
      }
    }`, { id: pull.id, mergeMethod, sha: target.headSha });
    const parsed = enableResponseSchema.safeParse(data);
    if (!parsed.success) throw invalidProviderPayload('GitHub did not confirm auto-merge');
    if (parsed.data.enablePullRequestAutoMerge.pullRequest.autoMergeRequest.mergeMethod !== mergeMethod) {
      throw Object.assign(new Error('GitHub kept a different auto-merge method. Cancel auto-merge and try again.'), {
        status: 409, code: 'SOURCE_CONTROL_MUTATION_REJECTED',
      });
    }
  }
  return { merged: false, outcome: 'auto-merge' as const };
}

export async function cancelWaitingMerge(octokit: Octokit, project: MergeProject, target: MergeTarget) {
  const readConfirmedPull = async () => {
    const { pull } = await readWaitingMerge(octokit, project, target);
    if (pull.headRefOid !== target.headSha) {
      throw Object.assign(new Error('The pull request head changed before cancellation.'), {
        status: 409, code: 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED',
      });
    }
    return pull;
  };
  let pull = await readConfirmedPull();
  if (pull.state === 'MERGED') return { merged: true };
  if (pull.isInMergeQueue) {
    const data = await octokit.graphql<unknown>(`mutation($id: ID!) {
      dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } }
    }`, { id: pull.id });
    if (!Object.hasOwn(data ?? {}, 'dequeuePullRequest')) throw invalidProviderPayload('GitHub did not confirm dequeue');
    pull = await readConfirmedPull();
    if (pull.state === 'MERGED') return { merged: true };
    if (pull.isInMergeQueue) throw invalidProviderPayload('GitHub did not confirm leaving the merge queue');
  }
  if (pull.autoMergeRequest) {
    const data = await octokit.graphql<unknown>(`mutation($id: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { enabledAt } } }
    }`, { id: pull.id });
    const disabled = hasProperty(data, 'disablePullRequestAutoMerge') ? data.disablePullRequestAutoMerge : undefined;
    const result = hasProperty(disabled, 'pullRequest') ? disabled.pullRequest : undefined;
    if ((hasProperty(result, 'autoMergeRequest') ? result.autoMergeRequest : undefined) !== null) {
      throw invalidProviderPayload('GitHub did not confirm disabling auto-merge');
    }
  }
  return { merged: false, outcome: 'cancelled' as const };
}
