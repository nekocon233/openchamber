import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { SourceControlJson } from '@openchamber/sdk';
import { isGraphqlRateLimitError, parseSummaryRefs, summarizeCheckContexts, toDiscussionState } from './pr-summaries.js';
import { graphqlAliasesSchema, hasProperty, retainedEntry, referenceDirectory, livePage, referenceNodeAt } from './contracts.js';
import type { Octokit, PullRequestQuery, GitHubEnvelope, SummaryRef, AcrossContext, ReferenceRepo, Reference, DetailLineComment, DetailEntry, StatusDictionary, SearchInput, AcrossGroup, AcrossPosition, CommentPermissions, EditableText, ReferenceDetail, LookupVariables, AcrossPage, AcrossSearchInput } from './contracts.js';
import {
  DISCUSSION_FRAGMENT,
  REFERENCE_FRAGMENTS,
  DETAIL_QUERY,
  DISCUSSION_DETAIL_QUERY,
  SEARCH_QUERY,
  MINE_PULL_SEARCH_QUERY,
  DISCUSSION_SEARCH_QUERY,
  REPOSITORY_PULLS_QUERY,
  userSchema,
  issueNodeSchema,
  pullNodeSchema,
  discussionNodeSchema,
  detailCommentSchema,
  discussionDetailSchema,
  detailSchema,
} from './reference-contracts.js';

const REFERENCE_PAGE_SIZE = 30;
const ACROSS_REPO_CHUNK_SIZE = 40;
const ACROSS_CONCURRENCY = 4;

export const acrossContextSchema = z.strictObject({
  directory: z.string().trim().min(1),
  repositoryId: z.string().min(1),
  provider: z.literal('github'),
  instance: z.string().min(1),
  accountId: z.string().min(1),
  bindingRevision: z.number().int().nonnegative(),
  primaryRemote: z.string().min(1),
});
export const acrossRequestSchema = z.strictObject({
  contexts: z.array(acrossContextSchema),
  kind: z.enum(['issue', 'pull', 'discussion']),
  state: z.enum(['open', 'closed', 'merged', 'all', 'unanswered']).optional(),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested', 'mine']).optional(),
  labels: z.array(z.string()).optional(),
  query: z.string().optional(),
  cursor: z.string().max(100_000).nullable().optional(),
});

const invalidAcrossCursor = () => Object.assign(new Error('Invalid references cursor'), { status: 400, code: 'INVALID_REFERENCES_CURSOR' });

export function readReferencesAcrossRequest(body: SourceControlJson) {
  const parsed = acrossRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const folders = new Map<string, AcrossContext>();
  for (const context of parsed.data.contexts) {
    if (!folders.has(context.directory)) folders.set(context.directory, context);
  }
  const labels = [...new Set((parsed.data.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0 && label.length <= 256))].slice(0, 20);
  return folders.size > 100 ? null : { ...parsed.data, labels, contexts: [...folders.values()], directories: parsed.data.contexts.map((context) => context.directory) };
}

export async function mapReferencesAcross<Entry extends object, Result>(entries: Entry[], operation: (entry: Entry, index: number) => Promise<Result>) {
  const results = new Array<Result>(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ACROSS_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await operation(retainedEntry(entries, index), index);
    }
  }));
  return results;
}
const BODY_PREVIEW_MAX = 20_000;
const SEARCH_STATES = {
  open: 'is:open',
  closed: 'is:closed',
  merged: 'is:merged',
  all: '',
  unanswered: 'is:open is:unanswered',
};
const SEARCH_PEOPLE = {
  any: '',
  assigned: 'assignee:@me',
  created: 'author:@me',
  reviewRequested: 'review-requested:@me',
  mine: 'author:@me',
};

const EXCERPT_LINE_LIMIT = 200;

export const reviewCommentExcerpt = (comment: Pick<DetailLineComment, 'line' | 'originalLine' | 'startLine' | 'originalStartLine' | 'diffHunk'>) => {
  const current = comment.line !== null && comment.line !== undefined;
  const end = current ? comment.line : comment.originalLine;
  const start = (current ? comment.startLine : comment.originalStartLine) ?? end;
  if (!comment.diffHunk || end == null || start == null || !Number.isSafeInteger(end) || !Number.isSafeInteger(start) || start < 1 || start > end) return undefined;
  const count = end - start + 1;
  if (count > EXCERPT_LINE_LIMIT) return undefined;
  const [header, ...body] = comment.diffHunk.replace(/\r\n/g, '\n').split('\n');
  if (!header?.startsWith('@@')) return undefined;
  const newSide = body.filter((line) => line.startsWith(' ') || line.startsWith('+')).map((line) => line.slice(1));
  if (newSide.length < count) return undefined;
  return { startLine: start, lines: newSide.slice(-count) };
};

const STACK_LAYER_LIMIT = 50;

const STACK_QUERY = `
query PullStack($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        stack {
          number
          baseRefName
          entries(first: ${STACK_LAYER_LIMIT}) {
            nodes { position pullRequest { number title url state isDraft headRefName } }
          }
        }
      }
    }
  }
}
`;

const stackSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.object({
      __typename: z.string(),
      stack: z.object({
        number: z.number().int(),
        baseRefName: z.string(),
        entries: z.object({
          nodes: z.array(z.object({
            position: z.number().int(),
            pullRequest: z.object({
              number: z.number().int(),
              title: z.string(),
              url: z.string(),
              state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
              isDraft: z.boolean(),
              headRefName: z.string(),
            }).nullable(),
          })),
        }),
      }).nullable().optional(),
    }).nullable(),
  }).nullable(),
});

export async function fetchPullStack({ octokit, owner, repo, number }: PullRequestQuery) {
  const parsed = stackSchema.parse(await octokit.graphql(STACK_QUERY, { owner, repo, number }));
  const stack = parsed.repository?.issueOrPullRequest?.stack;
  if (!stack) return null;
  const layers = stack.entries.nodes
    .filter((entry): entry is typeof entry & { pullRequest: NonNullable<typeof entry.pullRequest> } => entry.pullRequest !== null)
    .sort((left, right) => left.position - right.position)
    .map(({ pullRequest }) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      state: PULL_STATES[pullRequest.state],
      draft: pullRequest.isDraft,
      head: pullRequest.headRefName,
    }));
  return { number: stack.number, base: stack.baseRefName, layers };
}

const referenceNodeSchema = z.discriminatedUnion('__typename', [issueNodeSchema, pullNodeSchema, discussionNodeSchema]);

const REVIEW_DECISIONS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' };
const PULL_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const repoKey = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

const categoryEmoji = (html: string | null | undefined) => {
  const text = String(html ?? '').replace(/<[^>]*>/g, '').trim();
  return text && text.length <= 16 && !/[<>&]/.test(text) ? text : null;
};

const previewBody = (body: string | null) => {
  const text = body ?? '';
  return text.length > BODY_PREVIEW_MAX
    ? { body: text.slice(0, BODY_PREVIEW_MAX), bodyTruncated: true }
    : { body: text, bodyTruncated: false };
};

export function toReference(value: GitHubEnvelope['data'], repos: ReferenceRepo[]) {
  const parsed = referenceNodeSchema.safeParse(value);
  if (!parsed.success) return null;
  const node = parsed.data;
  const sourceRepo = repos.find((entry) => repoKey(entry.owner, entry.repo) === repoKey(node.repository.owner.login, node.repository.name));
  if (!sourceRepo) return null;
  const common = {
    number: node.number,
    title: node.title,
    url: node.url,
    ...previewBody(node.body),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    author: node.author ? { login: node.author.login, avatarUrl: node.author.avatarUrl ?? undefined } : null,
    labels: (node.labels?.nodes ?? [])
      .filter((label) => label !== null)
      .map((label) => ({ name: label.name, color: label.color ?? undefined })),
    commentCount: node.comments.totalCount,
    sourceRepo: { owner: sourceRepo.owner, repo: sourceRepo.repo, source: sourceRepo.source },
  };
  if (node.__typename === 'Issue') {
    const state = node.state === 'OPEN'
      ? 'open'
      : node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE' ? 'not_planned' : 'completed';
    return { kind: 'issue', ...common, state };
  }
  if (node.__typename === 'Discussion') {
    return {
      kind: 'discussion',
      ...common,
      state: toDiscussionState(node),
      answered: node.category.isAnswerable ? node.isAnswered === true : null,
      upvotes: node.upvoteCount,
      locked: node.locked,
      category: { name: node.category.name, emoji: categoryEmoji(node.category.emojiHTML), answerable: node.category.isAnswerable },
    };
  }
  const state = PULL_STATES[node.state];
  return {
    kind: 'pull',
    ...common,
    state,
    draft: node.isDraft,
    head: node.headRefName,
    base: node.baseRefName,
    headSha: node.headRefOid,
    headRepo: node.headRepository
      ? {
          owner: node.headRepository.owner.login,
          repo: node.headRepository.name,
          url: node.headRepository.url,
          cloneUrl: `${node.headRepository.url}.git`,
          sshUrl: node.headRepository.sshUrl ?? undefined,
        }
      : null,
  };
}

const REVIEW_STATES: StatusDictionary = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'dismissed' };

const toAuthor = (author: z.infer<typeof userSchema> | undefined) => (author ? { login: author.login, avatarUrl: author.avatarUrl ?? undefined } : null);

const commentPermissions = (comment: Pick<z.infer<typeof detailCommentSchema>, 'viewerCanUpdate' | 'viewerCanDelete'>) => {
  const permissions: CommentPermissions = {};
  if (comment.viewerCanUpdate !== undefined) permissions.canUpdate = comment.viewerCanUpdate;
  if (comment.viewerCanDelete !== undefined) permissions.canDelete = comment.viewerCanDelete;
  return permissions;
};

const byCreatedAt = (left: Pick<DetailEntry, 'createdAt'>, right: Pick<DetailEntry, 'createdAt'>) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0);

const editableText = (item: { body?: string | undefined; viewerCanUpdate?: boolean | undefined }) => {
  const text: EditableText = {};
  if (item.body !== undefined) text.body = item.body;
  if (item.viewerCanUpdate !== undefined) text.viewerCanUpdate = item.viewerCanUpdate;
  return text;
};

export async function fetchReferenceDetail({ octokit, owner, repo, number }: PullRequestQuery) {
  const [response, stack] = await Promise.all([
    octokit.graphql(DETAIL_QUERY, { owner, repo, number }),
    fetchPullStack({ octokit, owner, repo, number }).catch(() => undefined),
  ]);
  const parsed = detailSchema.parse(response);
  const item = parsed.repository?.issueOrPullRequest;
  if (!item) return null;
  const comments: DetailEntry[] = item.comments.nodes.map((comment) => {
    const entry: DetailEntry = {
      author: toAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      path: null,
      line: null,
      review: null,
      ...commentPermissions(comment),
    };
    if (Number.isSafeInteger(comment.databaseId)) entry.id = String(comment.databaseId);
    return entry;
  });
  if (item.__typename === 'Issue') {
    return { number: item.number, ...editableText(item), comments, commentTotal: item.comments.totalCount, pull: null };
  }
  for (const review of item.reviews.nodes) {
    const state = REVIEW_STATES[review.state] ?? null;
    if (review.body.trim() || state === 'approved' || state === 'changes_requested') {
      comments.push({ author: toAuthor(review.author), body: review.body, createdAt: review.createdAt, url: review.url, path: null, line: null, review: state });
    }
  }
  const lineComment = (comment: DetailLineComment) => {
    const result: DetailEntry = {
      author: toAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      path: comment.path,
      line: comment.line ?? comment.originalLine,
      review: 'commented',
    };
    const excerpt = reviewCommentExcerpt(comment);
    if (excerpt) result.excerpt = excerpt;
    return result;
  };
  for (const thread of item.reviewThreads.nodes) {
    const [first, ...replies] = thread.comments.nodes;
    if (!first) continue;
    comments.push({
      ...lineComment(first),
      thread: {
        id: thread.id,
        resolved: thread.isResolved,
        canResolve: thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve,
        canReply: thread.viewerCanReply,
        replies: replies.map(lineComment),
      },
    });
  }
  comments.sort(byCreatedAt);
  const detail: ReferenceDetail = {
    number: item.number,
    ...editableText(item),
    comments,
    commentTotal: item.comments.totalCount,
    pull: {
      reviewDecision: item.reviewDecision ? REVIEW_DECISIONS[item.reviewDecision] : null,
      reviewers: item.reviewRequests.nodes.flatMap(({ requestedReviewer: reviewer }) => (
        reviewer?.__typename === 'User' && reviewer.login
          ? [{ id: reviewer.login, ...toAuthor({ login: reviewer.login, avatarUrl: reviewer.avatarUrl }) }]
          : []
      )),
      checks: item.state === 'OPEN'
        ? summarizeCheckContexts(item.headCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [])
        : null,
      additions: item.additions,
      deletions: item.deletions,
      changedFiles: item.changedFiles,
      commits: item.commits.nodes.map(({ commit }) => ({
        sha: commit.oid,
        headline: commit.messageHeadline,
        author: toAuthor(commit.author?.user ?? null),
        authorName: commit.author?.name ?? null,
        committedAt: commit.committedDate,
        url: commit.url,
      })),
      commitTotal: item.commits.totalCount,
    },
  };
  if (stack !== undefined) detail.pull.stack = stack;
  return detail;
}

export async function fetchDiscussionDetail({ octokit, owner, repo, number }: PullRequestQuery) {
  const parsed = discussionDetailSchema.parse(await octokit.graphql(DISCUSSION_DETAIL_QUERY, { owner, repo, number }));
  const discussion = parsed.repository?.discussion;
  if (!discussion) return null;
  const answerable = discussion.category.isAnswerable;
  const canReply = !discussion.locked || discussion.viewerCanUpdate;
  const plain = (comment: z.infer<typeof detailCommentSchema> & { id: string }) => {
    const entry: DetailEntry = {
      author: toAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      path: null,
      line: null,
      review: null,
      ...commentPermissions(comment),
    };
    if (comment.id !== undefined) entry.id = comment.id;
    return entry;
  };
  const commentOf = (comment: NonNullable<NonNullable<z.infer<typeof discussionDetailSchema>['repository']>['discussion']>['comments']['nodes'][number]) => {
    const entry: DetailEntry = {
      ...plain(comment),
      thread: { id: comment.id, resolved: false, canResolve: false, canReply, replies: comment.replies.nodes.map(plain) },
    };
    if (answerable) {
      entry.answer = { chosen: comment.isAnswer, canChange: comment.isAnswer ? comment.viewerCanUnmarkAsAnswer : comment.viewerCanMarkAsAnswer };
    }
    return entry;
  };
  return {
    number: discussion.number,
    ...editableText(discussion),
    comments: discussion.comments.nodes.map(commentOf),
    commentTotal: discussion.comments.totalCount,
    pull: null,
    discussion: { canComment: canReply, canClose: discussion.viewerCanClose, canReopen: discussion.viewerCanReopen },
  };
}

const PULL_STATUS_LIMIT = REFERENCE_PAGE_SIZE;

export function readPullStatusRefs(value: string | null | undefined) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > PULL_STATUS_LIMIT) return null;
  const refs = [];
  for (const entry of entries) {
    const match = entry.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)(?:@([^#@\s]+))?$/);
    if (!match) return null;
    const ref: SummaryRef = { owner: match[1] ?? '', repo: match[2] ?? '', number: Number(match[3]) };
    const host = match[4]?.trim().toLowerCase();
    if (host && host !== 'github.com') {
      ref.host = host;
    }
    refs.push(ref);
  }
  return parseSummaryRefs(refs);
}

export const stateSchema = z.enum(['open', 'closed', 'merged', 'all', 'unanswered']).catch('open');
export const peopleSchema = z.enum(['any', 'assigned', 'created', 'reviewRequested', 'mine']).catch('any');
const scopeSchema = z.enum(['repository', 'network']).nullable().catch(null);

export function readReferenceScope(value: Parameters<typeof scopeSchema.parse>[0]) {
  return scopeSchema.parse(value === undefined ? 'network' : value);
}

export function readReferenceState(value: string | undefined) {
  return stateSchema.parse(value);
}
export function readReferencePeople(value: string | undefined) {
  return peopleSchema.parse(value);
}

const searchPageSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.unknown()),
});
const searchResultSchema = z.object({ search: searchPageSchema.extend({ issueCount: z.number().int() }) });
const discussionSearchResultSchema = z.object({ search: searchPageSchema.extend({ discussionCount: z.number().int() }) });

const viewerReviewRequestsSchema = z.object({
  reviewRequests: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(z.object({
      requestedReviewer: z.discriminatedUnion('__typename', [
        z.object({ __typename: z.literal('User'), isViewer: z.boolean() }),
        z.object({ __typename: z.literal('Team'), id: z.string().min(1) }),
        z.object({ __typename: z.literal('Mannequin') }),
      ]).nullable(),
    })),
  }),
  repository: z.object({
    owner: z.discriminatedUnion('__typename', [
      z.object({ __typename: z.literal('User') }),
      z.object({ __typename: z.literal('Organization'), teams: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(z.object({ id: z.string().min(1) })),
      }) }),
    ]),
  }),
});

const hasViewerReviewRequest = (value: Parameters<typeof viewerReviewRequestsSchema.parse>[0]) => {
  const { reviewRequests, repository: { owner } } = viewerReviewRequestsSchema.parse(value);
  const teams = owner.__typename === 'Organization' ? owner.teams : null;
  const teamIds = new Set(teams?.nodes.map(team => team.id));
  return reviewRequests.pageInfo.hasNextPage || reviewRequests.nodes.some(({ requestedReviewer }) =>
    requestedReviewer?.__typename === 'User' ? requestedReviewer.isViewer
      : requestedReviewer?.__typename === 'Team' && (teamIds.has(requestedReviewer.id) || teams?.pageInfo.hasNextPage));
};

const repositoryPullsSchema = z.object({
  repository: z.object({
    pullRequests: z.object({
      totalCount: z.number().int().nonnegative(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(pullNodeSchema),
    }),
  }),
});

export async function listRepositoryPullRequests({ octokit, repo, state, cursor }: {
  octokit: Octokit; repo: Pick<ReferenceRepo, 'repo' | 'owner'>;
  state: Exclude<SearchInput['state'], 'unanswered'>; cursor: string | null;
}) {
  const states = { open: ['OPEN'], closed: ['CLOSED', 'MERGED'], merged: ['MERGED'], all: null };
  const data = repositoryPullsSchema.parse(await octokit.graphql(REPOSITORY_PULLS_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    states: states[state],
    first: REFERENCE_PAGE_SIZE,
    after: cursor || null,
    withReviewRequests: false,
  }));
  const page = data.repository.pullRequests;
  const items = page.nodes.map((node) => {
    const item = toReference(node, [{ ...repo, source: 'origin' }]);
    if (!item) throw new Error('GitHub returned a pull request outside the bound repository');
    return item;
  });
  return { items, cursor: page.pageInfo.endCursor, hasMore: page.pageInfo.hasNextPage, total: page.totalCount };
}

export function parseReferenceLookup(text: string, repos: ReferenceRepo[], kind = 'issue') {
  const trimmed = text.trim();
  const family = kind === 'discussion' ? 'discussion' : 'item';
  const hash = trimmed.match(/^#?(\d+)$/);
  if (hash) {
    return { number: Number(hash[1]), repos, family };
  }
  const url = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull|discussions)\/(\d+)(?:[/?#]\S*)?$/i);
  if (url && (url[3]?.toLowerCase() === 'discussions') === (family === 'discussion')) {
    const target = repos.filter((entry) => repoKey(entry.owner, entry.repo) === repoKey(url[1] ?? '', url[2] ?? ''));
    return { number: Number(url[4]), repos: target, family };
  }
  return null;
}

export function parseReferenceLink(text: string, host: string) {
  const url = text.trim().match(/^https?:\/\/(?:www\.)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull|discussions)\/(\d+)(?:[/?#]\S*)?$/i);
  if (!url || url[1]?.toLowerCase() !== String(host).toLowerCase()) return null;
  return { owner: url[2], repo: url[3], number: Number(url[4]) };
}

const USER_LABEL_QUALIFIERS = /(?:^|\s)labels?:("(?:[^"\\]|\\.)*"|\S+)/gi;
const USER_PEOPLE_QUALIFIERS = /(?:^|\s)(?:assignee|author|mentions|review-requested|reviewed-by):\S+/i;

export function labelSearchQualifiers(labels: string[] = [], text = '') {
  const named = new Set([...String(text).matchAll(USER_LABEL_QUALIFIERS)]
    .map((match) => (match[1] ?? '').replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').toLowerCase()));
  const names: string[] = [];
  for (const label of labels) {
    const name = String(label).trim();
    if (name && !named.has(name.toLowerCase()) && !names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.map((name) => `label:"${name.replace(/["\\]/g, '\\$&')}"`);
}

export function buildReferenceSearchQuery({ repos, kind, state, people, text, labels = [] }: Omit<SearchInput, 'octokit' | 'cursor'>) {
  const userText = text.trim();
  const parts = repos.map((entry) => `repo:${entry.owner}/${entry.repo}`);
  if (kind !== 'discussion') parts.push(kind === 'pull' ? 'is:pr' : 'is:issue');
  if (!/(^|\s)(is:(open|closed|merged|unmerged|answered|unanswered)|state:\S+)/i.test(userText)) {
    const shown = kind !== 'pull' && state === 'merged' ? 'closed' : kind !== 'discussion' && state === 'unanswered' ? 'open' : state;
    const stateQualifier = SEARCH_STATES[shown];
    if (stateQualifier) parts.push(stateQualifier);
  }
  if (!/(^|\s)sort:\S+/i.test(userText)) {
    parts.push('sort:updated-desc');
  }
  if (!USER_PEOPLE_QUALIFIERS.test(userText)) {
    const peopleQualifier = (kind !== 'pull' && people === 'reviewRequested') || (kind === 'discussion' && people === 'assigned')
      ? ''
      : SEARCH_PEOPLE[people];
    if (peopleQualifier) parts.push(peopleQualifier);
  }
  if (kind !== 'discussion') parts.push(...labelSearchQualifiers(labels, userText));
  if (userText) parts.push(userText);
  return parts.join(' ');
}

function buildLookupQuery(number: number, repos: ReferenceRepo[], family: string, withReviewRequests = false, withViewer = false) {
  const variables: LookupVariables = { number };
  const declarations = ['$number: Int!'];
  if (family !== 'discussion') {
    declarations.push('$withReviewRequests: Boolean!');
    variables.withReviewRequests = withReviewRequests;
  }
  const field = family === 'discussion'
    ? 'discussion(number: $number) { __typename ...DiscussionReference }'
    : 'issueOrPullRequest(number: $number) { __typename ...IssueReference ...PullReference }';
  const selections = repos.map((entry, index) => {
    variables[`o${index}`] = entry.owner;
    variables[`n${index}`] = entry.repo;
    declarations.push(`$o${index}: String!, $n${index}: String!`);
    return `a${index}: repository(owner: $o${index}, name: $n${index}) {\n      ${field}\n    }`;
  });
  if (withViewer) selections.unshift('viewer { login }');
  const fragments = family === 'discussion' ? DISCUSSION_FRAGMENT : REFERENCE_FRAGMENTS;
  return {
    query: `query ReferenceLookup(${declarations.join(', ')}) {\n${selections.join('\n')}\n}\n${fragments}`,
    variables,
  };
}

async function runPartialQuery(octokit: Octokit, query: string, variables: LookupVariables, notFoundOnly = false) {
  try {
    return graphqlAliasesSchema.parse(await octokit.graphql<unknown>(query, variables));
  } catch (error) {
    if (isGraphqlRateLimitError(error) || !hasProperty(error, 'data') || !error.data) throw error;
    if (notFoundOnly && !z.object({ errors: z.array(z.object({ type: z.literal('NOT_FOUND') })).min(1) }).safeParse(error).success) throw error;
    return graphqlAliasesSchema.parse(error.data);
  }
}

const mineStreamPositionSchema = z.strictObject({
  cursor: z.string().min(1).max(10_000).nullable(),
  offset: z.number().int().min(0).max(REFERENCE_PAGE_SIZE),
  done: z.boolean(),
  total: z.number().int().nonnegative(),
});

const mineCursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  review: mineStreamPositionSchema,
  created: mineStreamPositionSchema,
  seen: z.array(z.string().min(1).max(300)).max(5_000),
});

const minePullSearchResultSchema = z.object({
  reviewRequested: searchPageSchema.extend({ issueCount: z.number().int() }).optional(),
  created: searchPageSchema.extend({ issueCount: z.number().int() }).optional(),
});

const nodeUpdatedAtSchema = z.object({ updatedAt: z.string() });

const nodeUpdatedAtOf = (node: Parameters<typeof nodeUpdatedAtSchema.safeParse>[0]) => {
  const parsed = nodeUpdatedAtSchema.safeParse(node);
  return parsed.success ? Date.parse(parsed.data.updatedAt) || 0 : 0;
};

const pullDedupeKeyOf = (item: Reference) => `${repoKey(item.sourceRepo.owner, item.sourceRepo.repo)}#${item.number}`;

function readMineCursor(cursor: string, scope: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 100_000) throw invalidAcrossCursor();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw invalidAcrossCursor();
    const parsed = mineCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    if (parsed.scope !== scope || (parsed.review.done && parsed.created.done)) {
      throw invalidAcrossCursor();
    }
    return parsed;
  } catch {
    throw invalidAcrossCursor();
  }
}

const MAX_MINE_EMPTY_HOPS = 3;

async function searchMinePullReferences({ octokit, repos, state, text, cursor, scope }: Pick<SearchInput, 'octokit' | 'repos' | 'state' | 'text' | 'cursor' | 'scope'>) {
  const scopeHash = createHash('sha256').update(JSON.stringify({
    repos: repos.map((repo) => repoKey(repo.owner, repo.repo)),
    state,
    text: text.trim(),
    scope,
  })).digest('hex');
  const initial = cursor
    ? readMineCursor(cursor, scopeHash)
    : {
      review: { cursor: null, offset: 0, done: false, total: 0 },
      created: { cursor: null, offset: 0, done: false, total: 0 },
      seen: [],
    };
  const verifyReview = scope === 'repository';
  const reviewQuery = buildReferenceSearchQuery({ repos, kind: 'pull', state, people: 'reviewRequested', text });
  const createdQuery = buildReferenceSearchQuery({ repos, kind: 'pull', state, people: 'created', text });

  type Position = z.infer<typeof mineStreamPositionSchema>;
  type SearchPage = z.infer<typeof minePullSearchResultSchema>['created'];
  const projectStream = (rawPage: SearchPage, position: Position, verifyViewerReview: boolean) => {
    if (position.done) return null;
    if (!rawPage) throw new Error('GitHub omitted a requested search connection');
    if (rawPage.pageInfo.hasNextPage && !rawPage.pageInfo.endCursor) {
      throw new Error('GitHub returned an invalid search cursor');
    }
    const items = rawPage.nodes
      .map((node) => {
        const item = toReference(node, repos);
        return item?.kind === 'pull' && (!verifyViewerReview || hasViewerReviewRequest(node)) ? item : null;
      })
      .filter((item) => item !== null)
      .slice(position.offset);
    const oldestRaw = rawPage.nodes.length > 0 ? nodeUpdatedAtOf(rawPage.nodes[rawPage.nodes.length - 1]) : -Infinity;
    const last = items.at(-1);
    const oldestRemaining = last ? updatedAtOf(last) : oldestRaw;
    return {
      items,
      hasMore: rawPage.pageInfo.hasNextPage,
      endCursor: rawPage.pageInfo.endCursor,
      total: rawPage.issueCount,
      oldestBound: Math.min(oldestRaw === -Infinity ? oldestRemaining : oldestRaw, oldestRemaining),
    };
  };

  type Stream = ReturnType<typeof projectStream>;
  const advance = (stream: Stream, position: Position, shownCount: number): Position => {
    if (!stream) return position;
    if (shownCount < stream.items.length) {
      return {
        cursor: position.cursor,
        offset: position.offset + shownCount,
        done: false,
        total: stream.total,
      };
    }
    return stream.hasMore
      ? { cursor: stream.endCursor, offset: 0, done: false, total: stream.total }
      : { cursor: null, offset: 0, done: true, total: stream.total };
  };

  let reviewPos = initial.review;
  let createdPos = initial.created;
  const seenSet = new Set(initial.seen);
  let cachedReview: Stream = null;
  let cachedCreated: Stream = null;
  const items: Reference[] = [];

  for (let hop = 0; hop <= MAX_MINE_EMPTY_HOPS; hop += 1) {
    const needReview = !reviewPos.done && !cachedReview;
    const needCreated = !createdPos.done && !cachedCreated;
    if (needReview || needCreated) {
      const raw = minePullSearchResultSchema.parse(await octokit.graphql(MINE_PULL_SEARCH_QUERY, {
        reviewQuery,
        createdQuery,
        first: REFERENCE_PAGE_SIZE,
        reviewAfter: reviewPos.cursor,
        createdAfter: createdPos.cursor,
        includeReview: needReview,
        includeCreated: needCreated,
        withReviewRequests: verifyReview,
      }));
      if (needReview) cachedReview = projectStream(raw.reviewRequested, reviewPos, verifyReview);
      if (needCreated) cachedCreated = projectStream(raw.created, createdPos, false);
    }

    const streams: [Stream, Stream] = [
      reviewPos.done ? null : cachedReview,
      createdPos.done ? null : cachedCreated,
    ];
    const bound = Math.max(
      -Infinity,
      ...streams.flatMap((stream) => stream?.hasMore ? [stream.oldestBound] : []),
    );
    const eligibleCount = (stream: Stream) => {
      if (!stream) return 0;
      const count = stream.items.findIndex((item) => updatedAtOf(item) < bound);
      return count === -1 ? stream.items.length : count;
    };
    let eligible: [number, number] = [eligibleCount(streams[0]), eligibleCount(streams[1])];
    const canAdvanceEmptyFilteredStream = hop < MAX_MINE_EMPTY_HOPS
      && streams.some((stream) => stream !== null && stream.items.length === 0 && stream.hasMore);
    if (eligible.every((count) => count === 0) && !canAdvanceEmptyFilteredStream) {
      eligible = [streams[0]?.items.length ?? 0, streams[1]?.items.length ?? 0];
    }

    const consumed: [number, number] = [0, 0];
    while (items.length < REFERENCE_PAGE_SIZE) {
      const left = consumed[0] < eligible[0] ? streams[0]?.items[consumed[0]] ?? null : null;
      const right = consumed[1] < eligible[1] ? streams[1]?.items[consumed[1]] ?? null : null;
      const pickIndex = left && (!right || updatedAtOf(left) >= updatedAtOf(right)) ? 0 : 1;
      const picked = pickIndex === 0 ? left : right;
      if (!picked) break;
      consumed[pickIndex] += 1;
      const key = pullDedupeKeyOf(picked);
      if (seenSet.has(key)) continue;
      seenSet.add(key);
      items.push(picked);
    }

    const nextReview = advance(streams[0], reviewPos, consumed[0]);
    const nextCreated = advance(streams[1], createdPos, consumed[1]);
    cachedReview = streams[0] && consumed[0] < streams[0].items.length
      ? { ...streams[0], items: streams[0].items.slice(consumed[0]) }
      : null;
    cachedCreated = streams[1] && consumed[1] < streams[1].items.length
      ? { ...streams[1], items: streams[1].items.slice(consumed[1]) }
      : null;
    reviewPos = nextReview;
    createdPos = nextCreated;

    const hasMore = !reviewPos.done || !createdPos.done;
    if (items.length > 0 || !hasMore) {
      const seen = [...seenSet].slice(-5_000);
      return {
        items,
        cursor: hasMore
          ? Buffer.from(JSON.stringify({ version: 1, scope: scopeHash, review: reviewPos, created: createdPos, seen })).toString('base64url')
          : null,
        hasMore,
        total: !hasMore && !cursor ? items.length : Math.max(reviewPos.total, createdPos.total),
      };
    }
  }

  const hasMore = !reviewPos.done || !createdPos.done;
  const seen = [...seenSet].slice(-5_000);
  return {
    items,
    cursor: hasMore
      ? Buffer.from(JSON.stringify({ version: 1, scope: scopeHash, review: reviewPos, created: createdPos, seen })).toString('base64url')
      : null,
    hasMore,
    total: !hasMore && !cursor ? items.length : Math.max(reviewPos.total, createdPos.total),
  };
}

export async function searchGitHubReferences({ octokit, repos, kind, state, people, text, labels = [], cursor, scope = 'network' }: SearchInput) {
  const isMinePulls = kind === 'pull' && people === 'mine';
  const isRepositoryMinePulls = scope === 'repository' && isMinePulls;
  const withReviewRequests = scope === 'repository' && kind === 'pull' && (people === 'reviewRequested' || people === 'mine');
  const lookup = parseReferenceLookup(text, repos, kind);
  if (lookup) {
    if (isMinePulls && cursor) throw invalidAcrossCursor();
    if (lookup.repos.length === 0) {
      return { items: [], cursor: null, hasMore: false, total: 0 };
    }
    const { query, variables } = buildLookupQuery(lookup.number, lookup.repos, lookup.family, withReviewRequests, isRepositoryMinePulls);
    const data = await runPartialQuery(octokit, query, variables, withReviewRequests);
    const viewerLogin = isRepositoryMinePulls
      ? z.object({ login: z.string().min(1) }).parse(data?.viewer).login.toLowerCase()
      : null;
    const toLookupItem = (value: GitHubEnvelope['data']) => {
      const item = toReference(value, repos);
      if (item?.kind !== 'pull' || !withReviewRequests) return item;
      if (isRepositoryMinePulls && item.author?.login?.toLowerCase() === viewerLogin) return item;
      return hasViewerReviewRequest(value) ? item : null;
    };
    const field = lookup.family === 'discussion' ? 'discussion' : 'issueOrPullRequest';
    const items = lookup.repos
      .map((_entry, index) => toLookupItem(referenceNodeAt(data, index, field)))
      .filter((item) => item !== null)
      .filter((item) => scope !== 'repository' || item.kind === kind);
    return { items, cursor: null, hasMore: false, total: items.length };
  }

  if (isMinePulls) {
    return searchMinePullReferences({ octokit, repos, state, text, cursor, scope });
  }

  const toItem = (value: GitHubEnvelope['data']) => {
    const item = toReference(value, repos);
    return item?.kind === 'pull' && withReviewRequests && !hasViewerReviewRequest(value) ? null : item;
  };
  const variables = {
    q: buildReferenceSearchQuery({ repos, kind, state, people, text, labels }),
    first: REFERENCE_PAGE_SIZE,
    after: cursor || null,
  };
  const search = kind === 'discussion'
    ? discussionSearchResultSchema.parse(await octokit.graphql(DISCUSSION_SEARCH_QUERY, variables)).search
    : searchResultSchema.parse(await octokit.graphql(SEARCH_QUERY, { ...variables, withReviewRequests })).search;
  const items = search.nodes
    .map(toItem)
    .filter((item): item is Reference => item !== null && item.kind === kind);
  return {
    items,
    cursor: search.pageInfo.endCursor,
    hasMore: search.pageInfo.hasNextPage,
    total: 'discussionCount' in search ? search.discussionCount : search.issueCount,
  };
}

const acrossCursorSchema = z.strictObject({
  version: z.literal(2),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  searches: z.array(z.strictObject({
    cursor: z.string().min(1).max(100_000).nullable(),
    offset: z.number().int().min(0).max(REFERENCE_PAGE_SIZE),
    done: z.boolean(),
    total: z.number().int().nonnegative(),
  })).max(300),
});

const updatedAtOf = (item: Pick<Reference, 'updatedAt'>) => Date.parse(item.updatedAt ?? '') || 0;

function readAcrossCursor(cursor: string, scope: string, searchCount: number) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 100_000) throw invalidAcrossCursor();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw invalidAcrossCursor();
    const parsed = acrossCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    if (parsed.scope !== scope || parsed.searches.length !== searchCount || parsed.searches.every((position) => position.done)) {
      throw invalidAcrossCursor();
    }
    return parsed.searches;
  } catch {
    throw invalidAcrossCursor();
  }
}

export async function searchGitHubReferencesAcross<Group extends AcrossGroup>({ groups, kind, state, people, text, labels = [], cursor, onGroupError }: AcrossSearchInput<Group>) {
  const searches = groups.flatMap((group, groupIndex) => {
    const chunks = [];
    for (let offset = 0; offset < group.repos.length; offset += ACROSS_REPO_CHUNK_SIZE) {
      chunks.push({ group, groupIndex, repos: group.repos.slice(offset, offset + ACROSS_REPO_CHUNK_SIZE) });
    }
    return chunks;
  });
  const lookup = parseReferenceLookup(text, [], kind);
  if (lookup && cursor) throw invalidAcrossCursor();
  const scope = createHash('sha256').update(JSON.stringify({
    kind, state, people, labels, text,
    searches: searches.map(({ group, repos }) => ({ accountId: group.accountId, authority: group.authority,
      repos: repos.map((repo) => ({ key: repoKey(repo.owner, repo.repo), directory: repo.directory })) })),
  })).digest('hex');
  const positions: AcrossPosition[] = cursor
    ? readAcrossCursor(cursor, scope, searches.length)
    : searches.map(() => ({ cursor: null, offset: 0, done: false, total: 0 }));
  const pages = await mapReferencesAcross(searches, async ({ group, repos }, index): Promise<AcrossPage> => {
    const position = retainedEntry(positions, index);
    if (position.done) return { done: true, items: [], total: position.total };
    try {
      const page = await searchGitHubReferences({ octokit: group.octokit, repos, kind, state, people, text, labels, cursor: position.cursor });
      if (page.hasMore && !page.cursor) throw new Error('GitHub returned an invalid search cursor');
      const items = page.items.slice(position.offset).map((item) => ({ ...item,
        directory: referenceDirectory(repos, item, repoKey),
      }));
      return { done: false, items, hasMore: page.hasMore, endCursor: page.cursor, total: page.total };
    } catch (error) {
      return { error };
    }
  });
  const failedGroups = new Set();
  for (let index = 0; index < pages.length; index++) {
    const page = retainedEntry(pages, index), search = retainedEntry(searches, index);
    if (!page.error || failedGroups.has(search.groupIndex)) continue;
    failedGroups.add(search.groupIndex);
    await onGroupError(search.group, page.error);
  }
  const live = pages.map((page, index) => (failedGroups.has(retainedEntry(searches, index).groupIndex) || page.done ? null : livePage(page)));
  const bound = Math.max(-Infinity, ...live
    .filter((page): page is Extract<AcrossPage, { done: false }> => Boolean(page?.hasMore && page.items.length > 0))
    .map((page) => updatedAtOf(retainedEntry(page.items, page.items.length - 1))));
  let shown = live.map((page) => {
    if (!page) return 0;
    const count = page.items.findIndex((item) => updatedAtOf(item) < bound);
    return count === -1 ? page.items.length : count;
  });
  if (shown.every((count) => count === 0)) shown = live.map((page) => page?.items.length ?? 0);
  const items = live.flatMap((page, index) => page?.items.slice(0, shown[index]) ?? []);
  if (searches.length > 1 || lookup) items.sort((left, right) => updatedAtOf(right) - updatedAtOf(left));
  const nextPositions = pages.map((page, index) => {
    if (failedGroups.has(retainedEntry(searches, index).groupIndex)) return { cursor: null, offset: 0, done: true, total: 0 };
    if (page.done) return retainedEntry(positions, index);
    const current = livePage(page);
    const position = retainedEntry(positions, index), count = retainedEntry(shown, index);
    if (count < current.items.length) {
      return { cursor: position.cursor, offset: position.offset + count, done: false, total: current.total };
    }
    return current.hasMore
      ? { cursor: current.endCursor, offset: 0, done: false, total: current.total }
      : { cursor: null, offset: 0, done: true, total: current.total };
  });
  const hasMore = !lookup && nextPositions.some((position) => !position.done);
  return {
    items,
    total: nextPositions.reduce((total, position) => total + position.total, 0),
    hasMore,
    cursor: hasMore ? Buffer.from(JSON.stringify({ version: 2, scope, searches: nextPositions })).toString('base64url') : null,
  };
}

export { detailCommentSchema } from './reference-contracts.js';
