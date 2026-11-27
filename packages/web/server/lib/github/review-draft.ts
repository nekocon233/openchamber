import { z } from 'zod';
import { hasProperty } from './contracts.js';
import type { PullRequestQuery } from './contracts.js';
import { errorStatus } from './resource-context.js';


const THREAD_PAGE = 100;
const THREAD_PAGE_LIMIT = 10;
const THREAD_COMMENT_LIMIT = 50;
const PENDING_COMMENT_LIMIT = 100;
const COMMENT_OWNERSHIP_PAGE_LIMIT = 10;

const author = z.object({ login: z.string(), avatarUrl: z.string().nullish() }).nullish();
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });
const commentOwnership = z.object({ state: z.string(), viewerDidAuthor: z.boolean().optional() });
const threadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().nullish(),
  startLine: z.number().int().nullish(),
  diffSide: z.enum(['LEFT', 'RIGHT']),
  subjectType: z.enum(['LINE', 'FILE']),
  isOutdated: z.boolean(),
  isResolved: z.boolean(),
  viewerCanReply: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  comments: z.object({
    nodes: z.array(commentOwnership.extend({
      id: z.string(),
      body: z.string(),
      createdAt: z.string(),
      url: z.string(),
      author,
    }).nullable()),
    pageInfo: pageInfo.optional(),
  }),
});
const pendingSchema = z.object({
  id: z.string(),
  viewerDidAuthor: z.boolean(),
  body: z.string(),
  comments: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      body: z.string(),
      path: z.string(),
      line: z.number().int().nullish(),
      startLine: z.number().int().nullish(),
      subjectType: z.enum(['LINE', 'FILE']).nullish(),
      author,
    }).nullable()),
  }),
});
const pullSchema = z.object({
  viewerDidAuthor: z.boolean(),
  headRefOid: z.string(),
  reviews: z.object({ nodes: z.array(pendingSchema.nullable()) }),
  reviewThreads: z.object({
    pageInfo,
    nodes: z.array(threadSchema.nullable()),
  }),
});
const commentOwnershipPage = z.object({
  node: z.object({ id: z.string(), comments: z.object({ nodes: z.array(commentOwnership.nullable()), pageInfo }) }).nullable(),
});

const PENDING_REVIEWS = `reviews(states: [PENDING], first: 5) {
  nodes {
    id viewerDidAuthor body
    comments(first: ${PENDING_COMMENT_LIMIT}) {
      nodes { id body path line startLine subjectType author { login avatarUrl } }
    }
  }
}`;

const REVIEW_STATE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      viewerDidAuthor
      headRefOid
      ${PENDING_REVIEWS}
      reviewThreads(first: ${THREAD_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line startLine diffSide subjectType
          isOutdated isResolved viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: ${THREAD_COMMENT_LIMIT}) {
            nodes { id state body createdAt url viewerDidAuthor author { login avatarUrl } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

const REVIEW_COMMENT_OWNERSHIP_QUERY = `query ReviewCommentOwnership($threadId: ID!, $after: String!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      comments(first: 100, after: $after) {
        nodes { state viewerDidAuthor }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const PENDING_REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { reviews(states: [PENDING], first: 5) { nodes { id viewerDidAuthor commit { oid } } } }
  }
}`;

const toAuthor = (value: z.infer<typeof author>) => (value ? { login: value.login, avatarUrl: value.avatarUrl ?? undefined } : null);
const toSide = (diffSide: z.infer<typeof threadSchema>['diffSide']): 'old' | 'new' => (diffSide === 'LEFT' ? 'old' : 'new');

const toThread = (thread: z.infer<typeof threadSchema>) => {
  const comments = thread.comments.nodes
    .filter((comment): comment is NonNullable<typeof comment> => comment !== null && comment.state !== 'PENDING')
    .map(({ id, body, createdAt, url, author: writer }) => ({ id, body, createdAt, url, author: toAuthor(writer) }));
  return {
    id: thread.id,
    path: thread.path,
    side: toSide(thread.diffSide),
    line: thread.subjectType === 'FILE' ? null : thread.line ?? null,
    startLine: thread.startLine ?? null,
    resolved: thread.isResolved,
    canReply: thread.viewerCanReply,
    canResolve: thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve,
    comments,
  };
};

const toDraft = (pending: z.infer<typeof pendingSchema> | null, sides: ReadonlyMap<string, 'old' | 'new'>) => (pending ? {
  id: pending.id,
  body: pending.body,
  comments: pending.comments.nodes.filter((comment) => comment !== null).map((comment) => ({
    id: comment.id,
    path: comment.path,
    side: sides.get(comment.id) ?? 'new',
    line: comment.subjectType === 'FILE' ? null : comment.line ?? null,
    startLine: comment.startLine ?? null,
    body: comment.body,
    author: toAuthor(comment.author),
  })),
} : null);

const viewerPublishedComment = (comment: z.infer<typeof commentOwnership> | null): boolean =>
  comment?.viewerDidAuthor === true && comment.state !== 'PENDING';

async function readViewerCommentedPaths(octokit: PullRequestQuery['octokit'], threads: z.infer<typeof threadSchema>[]) {
  const paths = new Set(threads.filter((thread) => thread.comments.nodes.some(viewerPublishedComment)).map((thread) => thread.path));
  let remaining = COMMENT_OWNERSHIP_PAGE_LIMIT;
  let truncated = false;
  for (const thread of threads) {
    let page = thread.comments.pageInfo;
    if (paths.has(thread.path) || !page?.hasNextPage) continue;
    const cursors = new Set<string>();
    while (page.hasNextPage) {
      const after = page.endCursor;
      if (!remaining || !after || cursors.has(after)) {
        truncated = true;
        break;
      }
      remaining -= 1;
      cursors.add(after);
      try {
        const { node } = commentOwnershipPage.parse(await octokit.graphql(REVIEW_COMMENT_OWNERSHIP_QUERY, { threadId: thread.id, after }));
        if (!node || node.id !== thread.id) {
          truncated = true;
          break;
        }
        if (node.comments.nodes.some(viewerPublishedComment)) {
          paths.add(thread.path);
          break;
        }
        page = node.comments.pageInfo;
      } catch (error) {
        if (errorStatus(error) === 401) throw error;
        truncated = true;
        break;
      }
    }
  }
  return { paths: [...paths], truncated };
}

export async function fetchReviewState({ octokit, owner, repo, number }: PullRequestQuery) {
  const threads: z.infer<typeof threadSchema>[] = [];
  let first: z.infer<typeof pullSchema> | null = null;
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; page < THREAD_PAGE_LIMIT; page += 1) {
    const data = await octokit.graphql<unknown>(REVIEW_STATE_QUERY, { owner, repo, number, after });
    const repository = hasProperty(data, 'repository') ? data.repository : undefined;
    const value = hasProperty(repository, 'pullRequest') ? repository.pullRequest : undefined;
    if (!value) throw Object.assign(new Error('GitHub pull request was not found'), { status: 404 });
    const pull = pullSchema.parse(value);
    first ??= pull;
    threads.push(...pull.reviewThreads.nodes.filter((thread) => thread !== null));
    if (!pull.reviewThreads.pageInfo.hasNextPage) break;
    after = pull.reviewThreads.pageInfo.endCursor ?? null;
    truncated = page === THREAD_PAGE_LIMIT - 1;
  }
  if (first === null) throw new TypeError("Cannot read properties of null (reading 'reviews')");
  const pending = first.reviews.nodes.find((review) => review?.viewerDidAuthor) ?? null;
  const sides = new Map(threads.flatMap((thread) => (
    thread.comments.nodes.filter((comment) => comment !== null).map((comment): [string, 'old' | 'new'] => [comment.id, toSide(thread.diffSide)])
  )));
  const ownership = await readViewerCommentedPaths(octokit, threads);
  return {
    connected: true,
    viewerIsAuthor: first.viewerDidAuthor,
    headSha: first.headRefOid,
    draft: toDraft(pending, sides),
    threads: threads.filter((thread) => !thread.isOutdated).map(toThread).filter((thread) => thread.comments.length > 0),
    viewerCommentedPaths: ownership.paths,
    truncated: truncated || ownership.truncated,
  };
}

export async function readPendingReview({ octokit, owner, repo, number }: PullRequestQuery) {
  const data = await octokit.graphql<unknown>(PENDING_REVIEW_QUERY, { owner, repo, number });
  const repository = hasProperty(data, 'repository') ? data.repository : undefined;
  const pull = hasProperty(repository, 'pullRequest') ? repository.pullRequest : undefined;
  const connection = hasProperty(pull, 'reviews') ? pull.reviews : undefined;
  const reviews = hasProperty(connection, 'nodes') ? connection.nodes : undefined;
  if (!Array.isArray(reviews)) return null;
  const isViewerReview = (entry: unknown): entry is { viewerDidAuthor: true } =>
    hasProperty(entry, 'viewerDidAuthor') && entry.viewerDidAuthor === true;
  const review: unknown = reviews.find(isViewerReview);
  const commit = hasProperty(review, 'commit') ? review.commit : undefined;
  return review ? {
    id: hasProperty(review, 'id') ? review.id : undefined,
    commit: (hasProperty(commit, 'oid') ? commit.oid : undefined) ?? null,
  } : null;
}
