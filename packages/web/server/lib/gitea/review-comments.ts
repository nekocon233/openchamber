import { isPlainObject, isString } from '../shared/guards.js';
import { mapLimited } from '../shared/map-limited.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { GiteaRequestError } from './client.js';

const HISTORICAL_REVIEW_CONCURRENCY = 4;

export async function readGiteaReviewComments(
  reviews: JsonValue[],
  pending: JsonObject | null,
  viewer: string,
  commentsOf: (review: JsonValue | undefined) => Promise<JsonValue[]>,
) {
  const published = reviews.filter((review): review is JsonObject =>
    isPlainObject(review) && review.state !== 'PENDING' && Number(review.comments_count) > 0);
  const [draftComments, publishedComments, historicalReads] = await Promise.all([
    pending ? commentsOf(pending) : Promise.resolve([]),
    Promise.all(published.filter((review) => review.stale !== true).map(commentsOf)),
    mapLimited(published.filter((review) => review.stale === true), HISTORICAL_REVIEW_CONCURRENCY, async (review) => {
      try {
        return { comments: await commentsOf(review), incomplete: false };
      } catch (error) {
        if (error instanceof GiteaRequestError && error.status === 401) throw error;
        return { comments: [], incomplete: true };
      }
    }),
  ]);
  const comments = publishedComments.flat();
  const viewerCommentedPaths = new Set<string>();
  for (const comment of [...comments, ...historicalReads.flatMap((result) => result.comments)]) {
    if (isPlainObject(comment) && isPlainObject(comment.user) && comment.user.login === viewer && isString(comment.path)) {
      viewerCommentedPaths.add(comment.path);
    }
  }
  return {
    draftComments,
    comments,
    viewerCommentedPaths: [...viewerCommentedPaths],
    truncated: historicalReads.some((result) => result.incomplete),
  };
}
