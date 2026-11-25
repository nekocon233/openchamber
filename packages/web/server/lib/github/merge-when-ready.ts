import { z } from 'zod';
import { invalidProviderPayload } from './mappers.js';
import { mutationError, type AutoMergeRequest } from './mutation-input.js';
import type { MutationResult } from '../source-control/mutation-storage.js';
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
  baseRefName: z.string().optional(),
  isDraft: z.boolean().optional(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  isInMergeQueue: z.boolean(),
  autoMergeRequest: autoMergeRequestSchema.nullable(),
});

const sameAutoMerge = (left: AutoMergeRequest | null, right: AutoMergeRequest | undefined): boolean =>
  Boolean(left && right && left.enabledAt === right.enabledAt && left.mergeMethod === right.mergeMethod);

export const hasRequestedAutoMerge = (pull: z.infer<typeof pullSchema>, target: MergeTarget, method: string | undefined, previous?: AutoMergeRequest): boolean => (
  pull.state === 'OPEN' && pull.headRefOid === target.headSha
    && Boolean(method && pull.autoMergeRequest?.mergeMethod === method.toUpperCase())
    && !sameAutoMerge(pull.autoMergeRequest, previous)
);

export async function readWaitingMerge(octokit: Octokit, project: MergeProject, target: MergeTarget) {
  const data = await octokit.graphql(`query($owner: String!, $repo: String!, $number: Int!, $base: String!) {
    repository(owner: $owner, name: $repo) {
      squashMergeAllowed viewerPermission
      mergeQueue(branch: $base) { id }
      pullRequest(number: $number) {
        id state headRefOid baseRefName isDraft mergeable mergeStateStatus isInMergeQueue
        autoMergeRequest { enabledAt mergeMethod }
      }
    }
  }`, { owner: project.owner, repo: project.name, number: target.number, base: target.base });
  const parsed = z.object({ repository: z.object({
    mergeQueue: z.object({ id: z.string() }).nullable(), pullRequest: pullSchema,
    squashMergeAllowed: z.boolean().optional(), viewerPermission: z.string().nullish(),
  }) }).safeParse(data);
  if (!parsed.success) throw invalidProviderPayload('GitHub returned an invalid waiting merge state');
  const { pullRequest: pull, mergeQueue, squashMergeAllowed, viewerPermission } = parsed.data.repository;
  return { pull, hasQueue: mergeQueue !== null, squashMergeAllowed, viewerPermission };
}

export async function enableMergeWhenReady(octokit: Octokit, project: MergeProject, target: MergeTarget, method: string, previous?: AutoMergeRequest) {
  let waiting;
  try { waiting = await readWaitingMerge(octokit, project, target); }
  catch { return null; }
  const { pull, hasQueue } = waiting;
  if (hasQueue || pull.isInMergeQueue || pull.state !== 'OPEN' || pull.headRefOid !== target.headSha
    || pull.mergeable === 'CONFLICTING' || !['BLOCKED', 'UNSTABLE'].includes(pull.mergeStateStatus)) return null;
  const mergeMethod = method.toUpperCase();
  if (!hasRequestedAutoMerge(pull, target, method, previous)) {
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
  if (pull.autoMergeRequest) await disableAutoMerge(octokit, pull.id);
  return { merged: false, outcome: 'cancelled' as const };
}

const disabledPullSchema = pullSchema.pick({
  id: true, state: true, headRefOid: true, baseRefName: true, isDraft: true, isInMergeQueue: true,
}).partial().extend({ autoMergeRequest: z.null() });
const disableResponseSchema = z.object({
  disablePullRequestAutoMerge: z.object({ pullRequest: disabledPullSchema }),
});

async function disableAutoMerge(octokit: Octokit, id: string) {
  const response = await octokit.graphql<unknown>(`mutation($id: ID!) {
    disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
      pullRequest { id state headRefOid baseRefName isDraft isInMergeQueue autoMergeRequest { enabledAt } }
    }
  }`, { id });
  const parsed = disableResponseSchema.safeParse(response);
  if (!parsed.success) throw invalidProviderPayload('GitHub did not confirm disabling auto-merge');
  return parsed.data.disablePullRequestAutoMerge.pullRequest;
}

const matchesMergeTarget = (pull: { headRefOid?: string | undefined; baseRefName?: string | undefined }, target: MergeTarget): boolean =>
  Boolean(target.headSha && target.base && pull.headRefOid === target.headSha && pull.baseRefName === target.base);

type RethrowGraphql = (cause: unknown) => never;

async function cancelSelectedAutoMerge(
  octokit: Octokit, project: MergeProject, target: MergeTarget, expected: AutoMergeRequest, rethrowGraphql: RethrowGraphql,
) {
  const { pull, hasQueue, squashMergeAllowed, viewerPermission } = await readWaitingMerge(octokit, project, target).catch(rethrowGraphql);
  if (!matchesMergeTarget(pull, target)) {
    throw mutationError('The pull request changed. Refresh before merging.', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
  }
  if (pull.state === 'MERGED') return 'merged';
  if (pull.state !== 'OPEN' || pull.isDraft !== false || pull.mergeable === 'CONFLICTING') {
    throw mutationError('Squash merge requires an open pull request ready for review without merge conflicts.', 'SOURCE_CONTROL_MUTATION_REJECTED', 409);
  }
  if (hasQueue || pull.isInMergeQueue) {
    throw mutationError('GitHub manages merging for this branch through its merge queue.', 'SOURCE_CONTROL_MUTATION_REJECTED', 409);
  }
  if (!pull.autoMergeRequest) return 'none';
  if (!sameAutoMerge(pull.autoMergeRequest, expected)) {
    throw mutationError('Auto-merge changed. Refresh the pull request before merging.', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
  }
  if (squashMergeAllowed !== true || !['ADMIN', 'MAINTAIN', 'WRITE'].includes(viewerPermission ?? '')) {
    throw mutationError('Squash merging must be enabled for this repository and allowed for the current account.', 'SOURCE_CONTROL_MUTATION_REJECTED', 403);
  }
  const current = await disableAutoMerge(octokit, pull.id).catch(rethrowGraphql);
  if (current.id !== pull.id) throw invalidProviderPayload('GitHub returned a different pull request after disabling auto-merge');
  if (!matchesMergeTarget(current, target)) return 'changed';
  if (current.state === 'MERGED') return 'merged';
  return current.state === 'OPEN' && current.isDraft === false && current.isInMergeQueue === false ? 'cancelled' : 'changed';
}

const providerRefusalSchema = z.object({ status: z.number().int().min(400).max(499) });

export async function mergeWithWaitingState(
  octokit: Octokit,
  project: MergeProject,
  target: MergeTarget,
  input: { cancel?: boolean; cancelAutoMerge?: AutoMergeRequest },
  { merge, rethrowGraphql }: { merge: () => Promise<MutationResult>; rethrowGraphql: RethrowGraphql },
): Promise<MutationResult> {
  if (input.cancel) {
    try { return await cancelWaitingMerge(octokit, project, target); }
    catch (error) { return rethrowGraphql(error); }
  }
  if (!input.cancelAutoMerge) return merge();
  const state = await cancelSelectedAutoMerge(octokit, project, target, input.cancelAutoMerge, rethrowGraphql);
  if (state === 'none') return merge();
  if (state === 'merged') return { merged: true };
  const partial = { merged: false, outcome: 'cancelled' } as const;
  if (state === 'changed') return partial;
  try {
    const result = await merge();
    return result.merged || result.outcome ? result : partial;
  } catch (error) {
    const refusal = providerRefusalSchema.safeParse(error);
    if (refusal.success && refusal.data.status !== 401) return partial;
    throw error;
  }
}
