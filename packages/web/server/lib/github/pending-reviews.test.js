import { describe, expect, it, vi } from 'vitest';
import { parsePendingReviewAction, preparePendingReviewAction, readGitHubPendingReview } from './pending-reviews.js';

const HEAD = 'a'.repeat(40);
const project = { owner: 'acme', name: 'app' };
const comment = (id = 'COMMENT1') => ({ id, body: 'Check this branch', path: 'src/a.ts',
  author: { databaseId: 7 }, pullRequestReview: { id: 'REVIEW1' } });
const thread = (comment, overrides = {}) => ({ id: `THREAD_${comment.id}`, path: comment.path,
  diffSide: 'RIGHT', line: 10, startLine: 8, originalLine: 10, originalStartLine: 8, isOutdated: false,
  comments: [ { id: comment.id } ], ...overrides });
function fixture({ pending = true, ownPull = false, author = 7, head = HEAD, reviewHead = HEAD, pageSize = 100 } = {}) {
  const comments = [comment()];
  const threads = [thread(comments[0])];
  const writes = [];
  const page = (items, after = null) => {
    const start = Number(after ?? 0);
    const nodes = items.slice(start, start + pageSize);
    const end = start + nodes.length;
    return { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length ? String(end) : null } };
  };
  const octokit = {
    graphql: vi.fn(async (_query, variables) => {
      if (variables.input) {
        const name = /\{\s+(\w+)\(input:/.exec(_query)[1];
        writes.push({ name, input: variables.input });
        return { [name]: { clientMutationId: variables.input.clientMutationId } };
      }
      if (_query.includes('query PendingReviewComments(')) return { node: {
        id: 'REVIEW1', state: 'PENDING', author: { databaseId: author }, pullRequest: { id: 'PR1' }, comments: page(comments, variables.after),
      } };
      if (_query.includes('query PendingReviewThreads(')) {
        const result = page(threads, variables.after);
        return { node: { id: 'PR1', reviewThreads: { ...result, nodes: result.nodes.map(t => ({ ...t, comments: page(t.comments) })) } } };
      }
      if (_query.includes('query PendingReviewThreadComments(')) {
        const selected = threads.find(t => t.id === variables.threadId);
        return { node: { id: selected.id, pullRequest: { id: 'PR1' }, comments: page(selected.comments, variables.after) } };
      }
      return { viewer: { databaseId: 7 }, repository: { pullRequest: {
        id: 'PR1', number: 1, state: 'OPEN', headRefOid: head, author: { databaseId: ownPull ? 7 : 8 },
        reviews: { nodes: pending ? [{ id: 'REVIEW1', databaseId: 9, body: '', state: 'PENDING', author: { databaseId: author }, commit: { oid: reviewHead } }] : [],
          pageInfo: { hasNextPage: false, endCursor: null } },
      } } };
    }),
  };
  const input = { octokit, project, number: 1, providerAccountId: 'github.com#7' };
  const read = () => readGitHubPendingReview(input);
  const prepare = action => preparePendingReviewAction({ ...input, action: parsePendingReviewAction(action), headSha: HEAD, idempotencyKey: 'request-1' });
  return { octokit, comments, threads, writes, input, read, prepare };
}

describe('GitHub pending reviews', () => {
  it('starts a pending review with the first multiline comment and an exact commit', async () => {
    const f = fixture({ pending: false });
    const perform = await f.prepare({ kind: 'comment', body: 'Handle the deletion', path: 'old.ts', side: 'LEFT', startLine: 3, line: 5 });
    expect(f.writes).toHaveLength(0);
    await perform();
    expect(f.writes).toEqual([{ name: 'addPullRequestReview', input: {
      pullRequestId: 'PR1', commitOID: HEAD, clientMutationId: 'request-1',
      threads: [{ body: 'Handle the deletion', path: 'old.ts', side: 'LEFT', startSide: 'LEFT', startLine: 3, line: 5 }],
    } }]);
    expect(f.writes[0].input.event).toBeUndefined();
  });

  it('adds another file comment to the same pending review', async () => {
    const f = fixture();
    await (await f.prepare({ kind: 'comment', reviewId: 'REVIEW1', body: 'Also check this', path: 'new.ts', side: 'RIGHT', line: 7 }))();
    expect(f.writes[0]).toEqual({ name: 'addPullRequestReviewThread', input: {
      pullRequestReviewId: 'REVIEW1', body: 'Also check this', path: 'new.ts', side: 'RIGHT', line: 7, clientMutationId: 'request-1',
    } });
  });

  it('submits every saved comment as one request-changes review', async () => {
    const f = fixture();
    f.comments.push({ ...comment('COMMENT2'), path: 'src/b.ts' });
    f.threads.push(thread(f.comments[1]));
    const { state } = await f.read();
    expect(state.review.comments).toHaveLength(2);
    await (await f.prepare({ kind: 'submit', reviewId: state.review.id, version: state.review.version, verdict: 'request-changes', body: 'Please fix both cases' }))();
    expect(f.writes).toEqual([{ name: 'submitPullRequestReview', input: {
      pullRequestReviewId: 'REVIEW1', event: 'REQUEST_CHANGES', body: 'Please fix both cases', clientMutationId: 'request-1',
    } }]);
  });

  it('never exposes another account’s pending comments', async () => {
    const f = fixture({ author: 99 });
    expect((await f.read()).state.review).toBeNull();
    expect(f.octokit.graphql).toHaveBeenCalledTimes(1);
    await expect(f.prepare({ kind: 'comment', reviewId: 'REVIEW1', path: 'a', side: 'RIGHT', line: 1, body: 'No' })).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a changed head or an older pending review without losing its comments', async () => {
    for (const f of [fixture({ head: 'b'.repeat(40) }), fixture({ reviewHead: 'b'.repeat(40) })]) {
      await expect(f.prepare({ kind: 'comment', path: 'a', side: 'RIGHT', line: 1, body: 'No' })).rejects.toMatchObject({ status: 409 });
      expect(f.writes).toHaveLength(0);
      expect(f.comments).toHaveLength(1);
    }
  });

  it('requires the displayed version and comment ownership for edits, deletions and submissions', async () => {
    const f = fixture();
    const { state } = await f.read();
    for (const action of [
      { kind: 'submit', reviewId: 'REVIEW1', version: 'stale', verdict: 'comment' },
      { kind: 'delete', reviewId: 'REVIEW1', version: state.review.version, commentId: 'FOREIGN' },
      { kind: 'edit', reviewId: 'FOREIGN', version: state.review.version, commentId: 'COMMENT1', body: 'No' },
      { kind: 'discard', reviewId: 'REVIEW1', version: 'stale' },
    ]) await expect(f.prepare(action)).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toHaveLength(0);
    await (await f.prepare({ kind: 'edit', reviewId: 'REVIEW1', version: state.review.version, commentId: 'COMMENT1', body: 'Updated' }))();
    await (await f.prepare({ kind: 'delete', reviewId: 'REVIEW1', version: state.review.version, commentId: 'COMMENT1' }))();
    await (await f.prepare({ kind: 'discard', reviewId: 'REVIEW1', version: state.review.version }))();
    expect(f.writes.map(write => write.name)).toEqual(['updatePullRequestReviewComment', 'deletePullRequestReviewComment', 'deletePullRequestReview']);
  });

  it('allows comment-only submission on one’s own PR while rejecting approval and changes requested', async () => {
    const f = fixture({ ownPull: true });
    const { state } = await f.read();
    for (const verdict of ['approve', 'request-changes']) await expect(f.prepare({ kind: 'submit', reviewId: 'REVIEW1', version: state.review.version, verdict, body: 'Summary' })).rejects.toMatchObject({ status: 422 });
    await (await f.prepare({ kind: 'submit', reviewId: 'REVIEW1', version: state.review.version, verdict: 'comment' }))();
    expect(f.writes[0].input.event).toBe('COMMENT');
  });

  it('reports read failures instead of claiming the review is empty', async () => {
    const f = fixture();
    f.octokit.graphql.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(f.read()).rejects.toThrow('Network unavailable');
  });

  it('changes the review version when a comment changes', async () => {
    const f = fixture();
    const first = (await f.read()).state.review.version;
    f.comments[0].body = 'Edited elsewhere';
    expect((await f.read()).state.review.version).not.toBe(first);
    await expect(f.prepare({ kind: 'submit', reviewId: 'REVIEW1', version: first, verdict: 'comment' })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects empty request-changes summaries and invalid line ranges', () => {
    expect(() => parsePendingReviewAction({ kind: 'submit', reviewId: 'R', version: 'v', verdict: 'request-changes' })).toThrow();
    expect(() => parsePendingReviewAction({ kind: 'comment', path: 'a', side: 'RIGHT', startLine: 3, line: 2, body: 'x' })).toThrow();
  });

  it('reads pending comment positions from their threads, including left-side and outdated ranges', async () => {
    const f = fixture();
    f.threads[0] = thread(f.comments[0], { diffSide: 'LEFT', line: 101, startLine: null, originalStartLine: null });
    f.comments.push({ ...comment('COMMENT2'), path: 'deleted.ts' });
    f.threads.push(thread(f.comments[1], { line: null, startLine: null, originalLine: 25, originalStartLine: 20, isOutdated: true }));
    const { state } = await f.read();
    expect(state.review.comments).toEqual([
      { id: 'COMMENT1', body: 'Check this branch', path: 'src/a.ts', side: 'LEFT', line: 101, startLine: null, outdated: false },
      { id: 'COMMENT2', body: 'Check this branch', path: 'deleted.ts', side: 'RIGHT', line: 25, startLine: 20, outdated: true },
    ]);
  });

  it('paginates review comments, threads and thread replies without including published comments', async () => {
    const f = fixture({ pageSize: 1 });
    f.comments.push({ ...comment('COMMENT2'), path: 'src/b.ts' });
    f.threads[0].comments.unshift({ id: 'PUBLISHED' });
    f.threads.unshift(thread(comment('UNRELATED')));
    f.threads.push(thread(f.comments[1]));
    f.threads.push(thread(comment('UNNEEDED')));
    const { state } = await f.read();
    expect(state.review.comments.map(c => c.id)).toEqual(['COMMENT1', 'COMMENT2']);
    expect(f.octokit.graphql.mock.calls.filter(([q]) => q.includes('query PendingReviewComments('))).toHaveLength(2);
    expect(f.octokit.graphql.mock.calls.filter(([q]) => q.includes('query PendingReviewThreads('))).toHaveLength(3);
    expect(f.octokit.graphql.mock.calls.filter(([q]) => q.includes('query PendingReviewThreadComments('))).toHaveLength(1);
  });

  it('skips thread reads for an empty review', async () => {
    const f = fixture();
    f.comments.length = 0;
    expect((await f.read()).state.review.comments).toEqual([]);
    expect(f.octokit.graphql).toHaveBeenCalledTimes(2);
  });

  it('rejects foreign comment authors and review ids before reading thread locations', async () => {
    for (const patch of [{ author: { databaseId: 99 } }, { pullRequestReview: { id: 'FOREIGN' } }]) {
      const f = fixture();
      Object.assign(f.comments[0], patch);
      await expect(f.read()).rejects.toThrow('outside the pending review');
      expect(f.octokit.graphql).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps missing or inconsistent locations as a failed read', async () => {
    for (const change of [f => { f.threads.length = 0; }, f => { f.threads[0].path = 'another.ts'; }]) {
      const f = fixture();
      change(f);
      await expect(f.read()).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    }
  });

  it('rejects incomplete pagination and provider errors after a partial page', async () => {
    for (const failure of ['missing-cursor', 'repeated-cursor', 'transport']) {
      const f = fixture({ pageSize: 1 });
      const graphql = f.octokit.graphql.getMockImplementation();
      f.octokit.graphql.mockImplementation(async (q, variables) => {
        const result = await graphql(q, variables);
        if (q.includes('query PendingReviewThreads(')) {
          if (variables.after && failure === 'transport') throw new Error('Network unavailable');
          result.node.reviewThreads = { nodes: [], pageInfo: { hasNextPage: true, endCursor: failure === 'missing-cursor' ? null : 'cursor' } };
        }
        return result;
      });
      await expect(f.read()).rejects.toThrow(failure === 'transport' ? 'Network unavailable' : 'pagination is incomplete');
    }
  });
});
