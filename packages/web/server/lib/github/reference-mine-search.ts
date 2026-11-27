import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invalidReferencesCursor, repoKey, updatedAtOf } from './contracts.js';
import type { GitHubEnvelope, Reference, SearchInput } from './contracts.js';
import { MINE_REFERENCE_SEARCH_QUERY, referenceSearchPageSchema } from './reference-contracts.js';

const REFERENCE_PAGE_SIZE = 30;

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

const mineReferenceSearchResultSchema = z.object({
  reviewRequested: referenceSearchPageSchema.extend({ issueCount: z.number().int() }).optional(),
  created: referenceSearchPageSchema.extend({ issueCount: z.number().int() }).optional(),
});

const nodeUpdatedAtSchema = z.object({ updatedAt: z.string() });

const nodeUpdatedAtOf = (node: Parameters<typeof nodeUpdatedAtSchema.safeParse>[0]) => {
  const parsed = nodeUpdatedAtSchema.safeParse(node);
  return parsed.success ? Date.parse(parsed.data.updatedAt) || 0 : 0;
};

const referenceDedupeKeyOf = (item: Reference) => `${repoKey(item.sourceRepo.owner, item.sourceRepo.repo)}#${item.number}`;

function readMineCursor(cursor: string, scope: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 100_000) throw invalidReferencesCursor();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw invalidReferencesCursor();
    const parsed = mineCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    if (parsed.scope !== scope || (parsed.review.done && parsed.created.done)) {
      throw invalidReferencesCursor();
    }
    return parsed;
  } catch {
    throw invalidReferencesCursor();
  }
}

const MAX_MINE_EMPTY_HOPS = 3;

export async function searchMineReferences(
  { octokit, repos, kind, state, text, cursor, scope, labels = [] }: Omit<SearchInput, 'people'>,
  buildQuery: (input: Omit<SearchInput, 'octokit' | 'cursor'>) => string,
  toItem: (node: GitHubEnvelope['data'], verifyViewerReview: boolean) => Reference | null,
) {
  const issues = kind === 'issue';
  const scopeKey = { repos: repos.map(repo => repoKey(repo.owner, repo.repo)), state, text: text.trim(), scope };
  const scopeHash = createHash('sha256').update(JSON.stringify(issues ? { ...scopeKey, kind, labels } : scopeKey)).digest('hex');
  const initial = cursor
    ? readMineCursor(cursor, scopeHash)
    : {
      review: { cursor: null, offset: 0, done: false, total: 0 },
      created: { cursor: null, offset: 0, done: false, total: 0 },
      seen: [],
    };
  const verifyReview = !issues && scope === 'repository';
  const queryText = issues ? text.replace(/"(?:[^"\\]|\\.)*"|(^|\s)sort:\S+/gi, term => term.startsWith('"') ? term : ' ') : text;
  const reviewQuery = buildQuery({ repos, kind, state, people: issues ? 'assigned' : 'reviewRequested', text: queryText, labels: issues ? labels : [] });
  const createdQuery = buildQuery({ repos, kind, state, people: 'created', text: queryText, labels: issues ? labels : [] });

  type Position = z.infer<typeof mineStreamPositionSchema>;
  type SearchPage = z.infer<typeof mineReferenceSearchResultSchema>['created'];
  const projectStream = (rawPage: SearchPage, position: Position, verifyViewerReview: boolean) => {
    if (position.done) return null;
    if (!rawPage) throw new Error('GitHub omitted a requested search connection');
    if (rawPage.pageInfo.hasNextPage && !rawPage.pageInfo.endCursor) {
      throw new Error('GitHub returned an invalid search cursor');
    }
    const items = rawPage.nodes
      .map(node => toItem(node, verifyViewerReview))
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
      const raw = mineReferenceSearchResultSchema.parse(await octokit.graphql(MINE_REFERENCE_SEARCH_QUERY, {
        reviewQuery,
        createdQuery,
        first: REFERENCE_PAGE_SIZE,
        reviewAfter: reviewPos.cursor,
        createdAfter: createdPos.cursor,
        includeReview: needReview,
        includeCreated: needCreated,
        withReviewRequests: verifyReview,
        withIssueMembership: issues,
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
      const key = referenceDedupeKeyOf(picked);
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
