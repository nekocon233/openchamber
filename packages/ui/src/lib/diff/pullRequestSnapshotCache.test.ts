import { expect, test } from 'bun:test';
import { PullRequestSnapshotCache } from './pullRequestSnapshotCache';
import type { PullRequestSource } from './pullRequestDiff';

const source: PullRequestSource = { kind: 'pr', number: 42 };
const snapshot = { headSha: 'a'.repeat(40), files: [{ path: 'a.ts', previousPath: undefined, status: 'M', insertions: 1, deletions: 1, patch: 'published' }] };

test('returning to a PR reuses its snapshot, while explicit refresh fetches again', async () => {
  const cache = new PullRequestSnapshotCache();
  let calls = 0;
  const fetch = async () => { calls += 1; return snapshot; };
  const first = cache.load('runtime/repo', source, fetch);
  expect(cache.load('runtime/repo', source, fetch)).toBe(first);
  expect(cache.load('runtime/repo', source, fetch, true)).toBe(first);
  await first;
  await cache.load('runtime/repo', { kind: 'pr', number: 43 }, fetch);
  expect(await cache.load('runtime/repo', source, fetch)).toBe(snapshot);
  expect(calls).toBe(2);
  await cache.load('runtime/repo', source, fetch, true);
  expect(calls).toBe(3);
  await cache.load('other-runtime/repo', source, fetch);
  expect(calls).toBe(4);
});

test('push invalidates only its scope and an older response cannot repopulate it', async () => {
  const cache = new PullRequestSnapshotCache();
  let resolveOld: (value: typeof snapshot) => void = () => {};
  const old = cache.load('runtime/repo', source, () => new Promise((resolve) => { resolveOld = resolve; }));
  const other = cache.load('runtime/other', source, async () => snapshot);
  await other;
  cache.invalidate('runtime/repo');
  const newer = { headSha: 'b'.repeat(40), files: [{ ...snapshot.files[0], patch: 'newer' }] };
  await cache.load('runtime/repo', source, async () => newer);
  resolveOld(snapshot);
  await old;
  expect(await cache.load('runtime/repo', source, async () => { throw new Error('Unexpected fetch'); })).toBe(newer);
  expect(cache.load('runtime/other', source, async () => { throw new Error('Unexpected fetch'); })).toBe(other);
});

test('failed reads can be retried and successful empty snapshots remain cached', async () => {
  const cache = new PullRequestSnapshotCache();
  await expect(cache.load('repo', source, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(await cache.load('repo', source, async () => ({ files: [], headSha: null }))).toEqual({ files: [], headSha: null });
  expect(await cache.load('repo', source, async () => { throw new Error('Unexpected fetch'); })).toEqual({ files: [], headSha: null });
});

test('bounds completed snapshots without evicting an in-flight request', async () => {
  const cache = new PullRequestSnapshotCache();
  let resolvePending: (value: typeof snapshot) => void = () => {};
  const pending = cache.load('repo', source, () => new Promise((resolve) => { resolvePending = resolve; }));
  for (let number = 1; number <= 9; number += 1) {
    await cache.load('repo', { kind: 'pr', number }, async () => snapshot);
  }
  expect(cache.load('repo', source, async () => { throw new Error('Unexpected fetch'); })).toBe(pending);
  let refetches = 0;
  await cache.load('repo', { kind: 'pr', number: 1 }, async () => { refetches += 1; return snapshot; });
  expect(refetches).toBe(1);
  resolvePending(snapshot);
  await pending;
});

test('caches and deduplicates lazy per-file diffs, retries failures, and clears on refresh or push', async () => {
  const cache = new PullRequestSnapshotCache();
  const deferredSnapshot = {
    headSha: 'a'.repeat(40),
    files: [{ path: 'lazy.ts', status: 'M', insertions: 3, deletions: 1 }],
  };
  await cache.load('runtime/repo', source, async () => deferredSnapshot, false, 'auth-1');

  let calls = 0;
  let resolveFile: (value: { diff: string; reviewHeadSha: string }) => void = () => {};
  const first = cache.loadFileDiff('runtime/repo', source, 'auth-1', 'lazy.ts', () => {
    calls += 1;
    return new Promise((resolve) => { resolveFile = resolve; });
  });
  const duplicate = cache.loadFileDiff('runtime/repo', source, 'auth-1', 'lazy.ts', async () => {
    calls += 1;
    return { diff: 'unexpected', reviewHeadSha: 'a'.repeat(40) };
  });
  expect(duplicate).toBe(first);
  resolveFile({ diff: 'lazy diff v1', reviewHeadSha: 'a'.repeat(40) });
  expect(await first).toEqual({ diff: 'lazy diff v1', reviewHeadSha: 'a'.repeat(40) });
  expect(await cache.loadFileDiff('runtime/repo', source, 'auth-1', 'lazy.ts', async () => {
    calls += 1;
    return { diff: 'unexpected' };
  })).toEqual({ diff: 'lazy diff v1', reviewHeadSha: 'a'.repeat(40) });
  expect(calls).toBe(1);

  await expect(cache.loadFileDiff('runtime/repo', source, 'auth-1', 'huge.json', async () => {
    throw new Error('This file is too large to show');
  })).rejects.toThrow('This file is too large to show');
  expect(await cache.loadFileDiff('runtime/repo', source, 'auth-1', 'huge.json', async () => ({
    diff: 'retried',
  }))).toEqual({ diff: 'retried' });

  await cache.load('runtime/repo', source, async () => deferredSnapshot, true, 'auth-1');
  expect(await cache.loadFileDiff('runtime/repo', source, 'auth-1', 'lazy.ts', async () => {
    calls += 1;
    return { diff: 'lazy diff v2', reviewHeadSha: 'b'.repeat(40) };
  })).toEqual({ diff: 'lazy diff v2', reviewHeadSha: 'b'.repeat(40) });
  expect(calls).toBe(2);

  cache.invalidate('runtime/repo');
  expect(await cache.loadFileDiff('runtime/repo', source, 'auth-1', 'lazy.ts', async () => ({
    diff: 'after eviction',
  }))).toEqual({ diff: 'after eviction' });
});
