import { z } from 'zod';
import type { SourceControlExistingMutationTarget, SourceControlMutationContext } from './types';

const id = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const githubPendingReviewCommentSchema = z.object({
  id, body: z.string(), path: z.string(), side: z.enum(['LEFT', 'RIGHT']),
  line: z.number().int().positive().nullable(), startLine: z.number().int().positive().nullable(), outdated: z.boolean(),
});
export const githubPendingReviewStateSchema = z.object({
  headSha: sha, open: z.boolean(), ownPull: z.boolean(),
  review: z.object({ id, headSha: sha.nullable(), body: z.string(), version: id, comments: z.array(githubPendingReviewCommentSchema) }).nullable(),
});
export type GitHubPendingReviewComment = z.infer<typeof githubPendingReviewCommentSchema>;
export type GitHubPendingReviewState = z.infer<typeof githubPendingReviewStateSchema>;
export const githubPendingReviewActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), reviewId: id.optional(), body: z.string().max(65536), path: z.string(), side: z.enum(['LEFT', 'RIGHT']), line: z.number().int().positive(), startLine: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('edit'), reviewId: id, commentId: id, version: id, body: z.string().max(65536) }),
  z.object({ kind: z.literal('delete'), reviewId: id, commentId: id, version: id }),
  z.object({ kind: z.literal('discard'), reviewId: id, version: id }),
  z.object({ kind: z.literal('submit'), reviewId: id, version: id, verdict: z.enum(['comment', 'approve', 'request-changes']), body: z.string().max(65536).optional() }),
]);
export type GitHubPendingReviewAction = z.infer<typeof githubPendingReviewActionSchema>;
export const pendingReviewAttemptSchema = z.tuple([sha, githubPendingReviewActionSchema]);
export function pendingReviewActionSignature(headSha: string, action: GitHubPendingReviewAction): string {
  // A lost first-write response can reveal the new review id on refresh. The
  // same inline comment still retries its original request and idempotency key.
  if (action.kind === 'comment') {
    return JSON.stringify([headSha, action.kind, action.path, action.side, action.line, action.startLine ?? null, action.body]);
  }
  return JSON.stringify([headSha, action]);
}
export interface GitHubPendingReviewInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  action: GitHubPendingReviewAction;
}
