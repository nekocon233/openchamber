import { z } from 'zod';
import { digestMutationInput } from '../source-control/mutation-executor.js';

const id = z.string().min(1).max(512);
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const body = z.string().max(65536).refine(value => value.trim().length > 0);
const side = z.enum(['LEFT', 'RIGHT']);
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), reviewId: id.optional(), body, path: z.string().min(1).max(4096), side,
    line: z.number().int().positive(), startLine: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('edit'), reviewId: id, commentId: id, version: id, body }).strict(),
  z.object({ kind: z.literal('delete'), reviewId: id, commentId: id, version: id }).strict(),
  z.object({ kind: z.literal('discard'), reviewId: id, version: id }).strict(),
  z.object({ kind: z.literal('submit'), reviewId: id, version: id,
    verdict: z.enum(['comment', 'approve', 'request-changes']), body: body.optional() }).strict(),
]).superRefine((action, ctx) => {
  if (action.kind === 'comment' && action.startLine !== undefined && action.startLine >= action.line) {
    ctx.addIssue({ code: 'custom', message: 'startLine must precede line' });
  }
});
const fail = (message, code = 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', status = 409) => Object.assign(new Error(message), { code, status });

export function parsePendingReviewAction(input) {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) throw fail('Pending review action is invalid', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 400);
  return parsed.data;
}

const actor = z.object({ databaseId: z.number().int().positive().nullish() }).nullable();
const reviewSchema = z.object({ id, body: z.string(), state: z.literal('PENDING'),
  author: actor, commit: z.object({ oid: sha }).nullable() });
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const resultSchema = z.object({ viewer: z.object({ databaseId: z.number().int().positive() }), repository: z.object({
  pullRequest: z.object({ id, number: z.number().int().positive(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']), headRefOid: sha,
    author: actor, reviews: z.object({ nodes: z.array(reviewSchema), pageInfo }) }).nullable(),
}).nullable() });
const commentSchema = z.object({ id, body: z.string(), path: z.string(), author: actor,
  pullRequestReview: z.object({ id }).nullable() });
const commentsResultSchema = z.object({ node: z.object({ id, state: z.string(), author: actor,
  pullRequest: z.object({ id }), comments: z.object({ nodes: z.array(commentSchema), pageInfo }),
}).nullable() });
const commentIdsSchema = z.object({ nodes: z.array(z.object({ id })), pageInfo });
const line = z.number().int().positive().nullable();
const threadSchema = z.object({ id, path: z.string(), diffSide: side, line, startLine: line,
  originalLine: line, originalStartLine: line, isOutdated: z.boolean(), comments: commentIdsSchema });
const threadsResultSchema = z.object({ node: z.object({ id,
  reviewThreads: z.object({ nodes: z.array(threadSchema), pageInfo }),
}).nullable() });
const threadCommentsResultSchema = z.object({ node: z.object({ id, pullRequest: z.object({ id }), comments: commentIdsSchema }).nullable() });

const query = `query PendingReviews($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { databaseId }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    id number state headRefOid author { ... on User { databaseId } ... on Bot { databaseId } }
    reviews(first: 100, states: [PENDING], after: $after) {
      nodes { id body state commit { oid } author { ... on User { databaseId } ... on Bot { databaseId } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;

const commentsQuery = `query PendingReviewComments($reviewId: ID!, $after: String) {
  node(id: $reviewId) { ... on PullRequestReview {
    id state author { ... on User { databaseId } ... on Bot { databaseId } } pullRequest { id }
    comments(first: 100, after: $after) {
      nodes { id body path author { ... on User { databaseId } ... on Bot { databaseId } } pullRequestReview { id } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const threadsQuery = `query PendingReviewThreads($pullRequestId: ID!, $after: String) {
  node(id: $pullRequestId) { ... on PullRequest {
    id reviewThreads(first: 100, after: $after) {
      nodes { id path diffSide line startLine originalLine originalStartLine isOutdated
        comments(first: 100) { nodes { id } pageInfo { hasNextPage endCursor } }
      }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const threadCommentsQuery = `query PendingReviewThreadComments($threadId: ID!, $after: String) {
  node(id: $threadId) { ... on PullRequestReviewThread {
    id pullRequest { id }
    comments(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
  } }
}`;

function nextPage(page, cursors) {
  if (!page.hasNextPage) return null;
  if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('GitHub pending review pagination is incomplete');
  cursors.add(page.endCursor);
  return page.endCursor;
}

async function readReviewComments(octokit, reviewId, pullRequestId, viewerId) {
  const comments = new Map();
  const cursors = new Set();
  let after = null;
  do {
    const { node } = commentsResultSchema.parse(await octokit.graphql(commentsQuery, { reviewId, after }));
    if (!node || node.id !== reviewId || node.pullRequest.id !== pullRequestId || node.state !== 'PENDING'
      || node.author?.databaseId !== viewerId) throw fail('Pending review changed; refresh before continuing');
    for (const comment of node.comments.nodes) {
      if (comment.pullRequestReview?.id !== reviewId || comment.author?.databaseId !== viewerId || comments.has(comment.id)) {
        throw new Error('GitHub returned comments outside the pending review');
      }
      comments.set(comment.id, comment);
    }
    after = nextPage(node.comments.pageInfo, cursors);
  } while (after);
  return comments;
}

/** Review comments have no diff side; their thread owns the file coordinates. */
async function readCommentLocations(octokit, pullRequestId, comments) {
  const locations = new Map();
  if (comments.size === 0) return locations;
  const cursors = new Set();
  let after = null;
  do {
    const { node } = threadsResultSchema.parse(await octokit.graphql(threadsQuery, { pullRequestId, after }));
    if (!node || node.id !== pullRequestId) throw fail('Pull request is unavailable');
    for (const thread of node.reviewThreads.nodes) {
      let page = thread.comments;
      const commentCursors = new Set();
      while (true) {
        for (const { id: commentId } of page.nodes) {
          const comment = comments.get(commentId);
          if (!comment) continue;
          if (comment.path !== thread.path || locations.has(commentId)) throw new Error('GitHub returned inconsistent review threads');
          locations.set(commentId, {
            side: thread.diffSide, line: thread.line ?? thread.originalLine,
            startLine: thread.startLine ?? thread.originalStartLine, outdated: thread.isOutdated,
          });
        }
        if (locations.size === comments.size) return locations;
        const commentAfter = nextPage(page.pageInfo, commentCursors);
        if (!commentAfter) break;
        const result = threadCommentsResultSchema.parse(await octokit.graphql(threadCommentsQuery, { threadId: thread.id, after: commentAfter }));
        if (!result.node || result.node.id !== thread.id || result.node.pullRequest.id !== pullRequestId) throw fail('Review thread changed; refresh before continuing');
        page = result.node.comments;
      }
    }
    after = nextPage(node.reviewThreads.pageInfo, cursors);
  } while (after);
  throw new Error('GitHub returned incomplete pending review threads');
}

/** Only the authenticated account's pending review is ever returned. */
export async function readGitHubPendingReview({ octokit, project, number, providerAccountId }) {
  let after = null;
  const cursors = new Set();
  while (true) {
    const result = resultSchema.parse(await octokit.graphql(query, { owner: project.owner, repo: project.name, number, after }));
    if (`${octokit.openChamberHost || 'github.com'}#${result.viewer.databaseId}` !== providerAccountId) throw fail('GitHub account changed', 'SOURCE_CONTROL_ACCOUNT_UNAVAILABLE', 401);
    const pull = result.repository?.pullRequest;
    if (!pull || pull.number !== number) throw fail('Pull request is unavailable', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 404);
    const matches = pull.reviews.nodes.filter(review => review.author?.databaseId === result.viewer.databaseId);
    if (matches.length > 1) throw new Error('GitHub returned multiple pending reviews for this account');
    const pending = matches[0];
    const state = { headSha: pull.headRefOid, open: pull.state === 'OPEN', ownPull: pull.author?.databaseId === result.viewer.databaseId, review: null };
    if (pending) {
      const comments = await readReviewComments(octokit, pending.id, pull.id, result.viewer.databaseId);
      const locations = await readCommentLocations(octokit, pull.id, comments);
      const review = { id: pending.id, headSha: pending.commit?.oid ?? null, body: pending.body, comments: [...comments.values()].map(comment => ({
        id: comment.id, body: comment.body, path: comment.path, ...locations.get(comment.id),
      })) };
      return { pullRequestId: pull.id, state: { ...state, review: { ...review, version: digestMutationInput(review) } } };
    }
    after = nextPage(pull.reviews.pageInfo, cursors);
    if (!after) return { pullRequestId: pull.id, state };
  }
}

/** Preflight establishes ownership before the durable executor can dispatch a write. */
export async function preparePendingReviewMutation({ octokit, project, number, headSha, providerAccountId, action, idempotencyKey }) {
  const { pullRequestId, state } = await readGitHubPendingReview({ octokit, project, number, providerAccountId });
  if (state.headSha !== headSha) throw fail('Pull request changed; refresh the diff before commenting');
  const review = state.review;
  if ((action.kind === 'comment' || action.kind === 'submit') && !state.open) throw fail('This pull request is no longer open');
  if (action.kind !== 'comment') {
    if (!review || action.reviewId !== review.id || action.version !== review.version) throw fail('Pending review changed; refresh before continuing');
    if ((action.kind === 'edit' || action.kind === 'delete') && !review.comments.some(comment => comment.id === action.commentId)) {
      throw fail('The comment does not belong to your pending review', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    }
  } else if (review && (review.headSha !== headSha || (action.reviewId && action.reviewId !== review.id))) {
    throw fail('Finish or discard the existing review before commenting on a new revision');
  } else if (!review && action.reviewId) {
    throw fail('The pending review no longer exists');
  }
  if (action.kind === 'submit' && state.ownPull && action.verdict !== 'comment') {
    throw fail('You cannot approve or request changes on your own pull request', 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
  }
  if (action.kind === 'submit' && action.verdict !== 'comment' && review.headSha !== headSha) {
    throw fail('This review draft was started on an older commit. Send it as a comment, then give your verdict.');
  }

  const mutation = (name, input) => ({ name, input: { ...input, clientMutationId: idempotencyKey } });
  if (action.kind === 'comment') {
    const thread = { body: action.body, path: action.path, line: action.line, side: action.side };
    if (action.startLine !== undefined) { thread.startLine = action.startLine; thread.startSide = action.side; }
    return review
      ? mutation('addPullRequestReviewThread', { ...thread, pullRequestReviewId: review.id })
      : mutation('addPullRequestReview', { pullRequestId, commitOID: headSha, threads: [thread] });
  }
  if (action.kind === 'edit') return mutation('updatePullRequestReviewComment', { pullRequestReviewCommentId: action.commentId, body: action.body });
  if (action.kind === 'delete') return mutation('deletePullRequestReviewComment', { id: action.commentId });
  if (action.kind === 'discard') return mutation('deletePullRequestReview', { pullRequestReviewId: review.id });
  const event = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' }[action.verdict];
  const input = { pullRequestReviewId: review.id, event };
  if (action.body !== undefined) input.body = action.body;
  return mutation('submitPullRequestReview', input);
}

/** Dispatch only after the durable executor has claimed the preflighted action. */
export async function performPendingReviewMutation(octokit, { name, input }) {
  const type = `${name[0].toUpperCase()}${name.slice(1)}Input`;
  const payload = await octokit.graphql(`mutation($input: ${type}!) { ${name}(input: $input) { clientMutationId } }`, { input });
  z.object({ [name]: z.object({ clientMutationId: z.literal(input.clientMutationId) }) }).parse(payload);
  return {};
}

/** The pre-shell route keeps its callable preflight contract. */
export async function preparePendingReviewAction(input) {
  const mutation = await preparePendingReviewMutation(input);
  return () => performPendingReviewMutation(input.octokit, mutation);
}
