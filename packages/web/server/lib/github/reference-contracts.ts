import { z } from 'zod';
import { checkContextSchema } from './pr-summaries.js';

const COMMON_FIELDS = `
  number
  title
  url
  createdAt
  updatedAt
  body
  author { login avatarUrl }
  labels(first: 6) { nodes { name color } }
  comments { totalCount }
  repository { name owner { login } }
`;

const PULL_REFERENCE_FRAGMENT = `
fragment PullReference on PullRequest {
  ${COMMON_FIELDS}
  state
  isDraft
  headRefName
  baseRefName
  headRefOid
  headRepository { name url sshUrl owner { login } }
  reviewRequests(first: 100) @include(if: $withReviewRequests) {
    pageInfo { hasNextPage }
    nodes {
      requestedReviewer {
        __typename
        ... on User { isViewer }
        ... on Team { id }
      }
    }
  }
  repository @include(if: $withReviewRequests) {
    owner {
      __typename
      ... on Organization {
        teams(first: 100, role: MEMBER) {
          pageInfo { hasNextPage }
          nodes { id }
        }
      }
    }
  }
}
`;

export const DISCUSSION_FRAGMENT = `
fragment DiscussionReference on Discussion {
  ${COMMON_FIELDS}
  closed
  stateReason
  isAnswered
  locked
  upvoteCount
  category { name emojiHTML isAnswerable }
}
`;

export const REFERENCE_FRAGMENTS = `
fragment IssueReference on Issue {
  ${COMMON_FIELDS}
  state
  stateReason
}
${PULL_REFERENCE_FRAGMENT}
`;

const DETAIL_COMMENT_LIMIT = 50;

const DETAIL_COMMIT_LIMIT = 50;

const DETAIL_THREAD_LIMIT = 50;

const DETAIL_THREAD_COMMENT_LIMIT = 50;

export const DETAIL_QUERY = `
query ReferenceDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number
        body
        viewerCanUpdate
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
      }
      ... on PullRequest {
        number
        body
        viewerCanUpdate
        state
        reviewDecision
        headCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { databaseId name status conclusion startedAt checkSuite { app { databaseId } } }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
        reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } } } }
        additions
        deletions
        changedFiles
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
        commits(last: ${DETAIL_COMMIT_LIMIT}) {
          totalCount
          nodes { commit { oid messageHeadline committedDate url author { name user { login avatarUrl } } } }
        }
        reviews(last: 30) {
          nodes { author { login avatarUrl } body state createdAt url }
        }
        reviewThreads(last: ${DETAIL_THREAD_LIMIT}) {
          nodes {
            id
            isResolved
            viewerCanResolve
            viewerCanUnresolve
            viewerCanReply
            comments(first: ${DETAIL_THREAD_COMMENT_LIMIT}) {
              nodes { author { login avatarUrl } body createdAt url path line originalLine startLine originalStartLine diffHunk }
            }
          }
        }
      }
    }
  }
}
fragment DetailComment on IssueComment { databaseId author { login avatarUrl } body createdAt url viewerCanUpdate viewerCanDelete }
`;

export const DISCUSSION_DETAIL_QUERY = `
query DiscussionDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      number
      body
      locked
      viewerCanUpdate
      viewerCanClose
      viewerCanReopen
      category { isAnswerable }
      comments(last: ${DETAIL_COMMENT_LIMIT}) {
        totalCount
        nodes {
          id
          author { login avatarUrl }
          body
          createdAt
          url
          isAnswer
          viewerCanMarkAsAnswer
          viewerCanUnmarkAsAnswer
          viewerCanUpdate
          viewerCanDelete
          replies(first: ${DETAIL_THREAD_COMMENT_LIMIT}) {
            nodes { id author { login avatarUrl } body createdAt url viewerCanUpdate viewerCanDelete }
          }
        }
      }
    }
  }
}
`;

export const SEARCH_QUERY = `
query ReferenceSearch($q: String!, $first: Int!, $after: String, $withReviewRequests: Boolean!) {
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ...IssueReference
      ...PullReference
    }
  }
}
${REFERENCE_FRAGMENTS}
`;

export const MINE_PULL_SEARCH_QUERY = `
query MinePullSearch(
  $reviewQuery: String!,
  $createdQuery: String!,
  $first: Int!,
  $reviewAfter: String,
  $createdAfter: String,
  $includeReview: Boolean!,
  $includeCreated: Boolean!,
  $withReviewRequests: Boolean!
) {
  reviewRequested: search(type: ISSUE, query: $reviewQuery, first: $first, after: $reviewAfter) @include(if: $includeReview) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ...IssueReference
      ...PullReference
    }
  }
  created: search(type: ISSUE, query: $createdQuery, first: $first, after: $createdAfter) @include(if: $includeCreated) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ...IssueReference
      ...PullReference
    }
  }
}
${REFERENCE_FRAGMENTS}
`;

export const DISCUSSION_SEARCH_QUERY = `
query DiscussionSearch($q: String!, $first: Int!, $after: String) {
  search(type: DISCUSSION, query: $q, first: $first, after: $after) {
    discussionCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ...DiscussionReference
    }
  }
}
${DISCUSSION_FRAGMENT}
`;

export const REPOSITORY_PULLS_QUERY = `
query RepositoryPulls($owner: String!, $repo: String!, $states: [PullRequestState!], $first: Int!, $after: String, $withReviewRequests: Boolean!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: $states, orderBy: {field: UPDATED_AT, direction: DESC}, first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { __typename ...PullReference }
    }
  }
}
${PULL_REFERENCE_FRAGMENT}
`;

export const userSchema = z.object({ login: z.string(), avatarUrl: z.string().nullable().optional() }).nullable();

const repositorySchema = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });

const commonSchema = {
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  body: z.string().nullable(),
  author: userSchema,
  labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string().nullable() }).nullable()) }).nullable(),
  comments: z.object({ totalCount: z.number().int() }),
  repository: repositorySchema,
};

export const issueNodeSchema = z.object({
  __typename: z.literal('Issue'),
  ...commonSchema,
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable(),
});

export const pullNodeSchema = z.object({
  __typename: z.literal('PullRequest'),
  ...commonSchema,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  headRepository: z.object({
    name: z.string(),
    url: z.string(),
    sshUrl: z.string().nullable().optional(),
    owner: z.object({ login: z.string() }),
  }).nullable(),
});

export const discussionNodeSchema = z.object({
  __typename: z.literal('Discussion'),
  ...commonSchema,
  closed: z.boolean(),
  stateReason: z.string().nullable(),
  isAnswered: z.boolean().nullable(),
  locked: z.boolean(),
  upvoteCount: z.number().int(),
  category: z.object({ name: z.string(), emojiHTML: z.string().nullable().optional(), isAnswerable: z.boolean() }),
});

export const detailCommentSchema = z.object({
  databaseId: z.number().int().nullable().optional(),
  author: userSchema,
  body: z.string(),
  createdAt: z.string().nullable(),
  url: z.string(),
  viewerCanUpdate: z.boolean().optional(),
  viewerCanDelete: z.boolean().optional(),
});

export const discussionDetailSchema = z.object({
  repository: z.object({
    discussion: z.object({
      number: z.number().int(),
      body: z.string().optional(),
      locked: z.boolean(),
      viewerCanUpdate: z.boolean(),
      viewerCanClose: z.boolean(),
      viewerCanReopen: z.boolean(),
      category: z.object({ isAnswerable: z.boolean() }),
      comments: z.object({
        totalCount: z.number().int(),
        nodes: z.array(detailCommentSchema.extend({
          id: z.string().min(1),
          isAnswer: z.boolean(),
          viewerCanMarkAsAnswer: z.boolean(),
          viewerCanUnmarkAsAnswer: z.boolean(),
          replies: z.object({ nodes: z.array(detailCommentSchema.extend({ id: z.string().min(1) })) }),
        })),
      }),
    }).nullable(),
  }).nullable(),
});

export const detailSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.discriminatedUnion('__typename', [
      z.object({
        __typename: z.literal('Issue'),
        number: z.number().int(),
        body: z.string().optional(),
        viewerCanUpdate: z.boolean().optional(),
        comments: z.object({ totalCount: z.number().int(), nodes: z.array(detailCommentSchema) }),
      }),
      z.object({
        __typename: z.literal('PullRequest'),
        number: z.number().int(),
        body: z.string().optional(),
        viewerCanUpdate: z.boolean().optional(),
        state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
        reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
        headCommit: z.object({
          nodes: z.array(z.object({
            commit: z.object({
              statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(checkContextSchema) }) }).nullable(),
            }),
          })),
        }),
        reviewRequests: z.object({
          nodes: z.array(z.object({
            requestedReviewer: z.object({
              __typename: z.string(),
              login: z.string().optional(),
              avatarUrl: z.string().nullable().optional(),
            }).nullable(),
          })),
        }),
        additions: z.number().int(),
        deletions: z.number().int(),
        changedFiles: z.number().int(),
        comments: z.object({ totalCount: z.number().int(), nodes: z.array(detailCommentSchema) }),
        commits: z.object({
          totalCount: z.number().int(),
          nodes: z.array(z.object({
            commit: z.object({
              oid: z.string(),
              messageHeadline: z.string(),
              committedDate: z.string().nullable(),
              url: z.string().nullable(),
              author: z.object({ name: z.string().nullable(), user: userSchema }).nullable(),
            }),
          })),
        }),
        reviews: z.object({
          nodes: z.array(z.object({
            author: userSchema,
            body: z.string(),
            state: z.string(),
            createdAt: z.string().nullable(),
            url: z.string(),
          })),
        }),
        reviewThreads: z.object({
          nodes: z.array(z.object({
            id: z.string().min(1),
            isResolved: z.boolean(),
            viewerCanResolve: z.boolean(),
            viewerCanUnresolve: z.boolean(),
            viewerCanReply: z.boolean(),
            comments: z.object({
              nodes: z.array(detailCommentSchema.extend({
                path: z.string().nullable(),
                line: z.number().int().nullable(),
                originalLine: z.number().int().nullable(),
                startLine: z.number().int().nullable().optional(),
                originalStartLine: z.number().int().nullable().optional(),
                diffHunk: z.string().nullable().optional(),
              })),
            }),
          })),
        }),
      }),
    ]).nullable(),
  }).nullable(),
});
