import { describe, expect, test, mock } from 'bun:test';
import { readGitHubPullFileStats } from './pull-file-stats.js';

const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const file = (index) => ({ filename: `file-${index}.ts`, status: 'added', additions: 2, deletions: 1, changes: 3, patch: 'not sent to the client' });
function setup(total = 201) {
  const get = mock(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha }, changed_files: total } }));
  const listFiles = mock(async ({ page }) => ({ data: Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, index) => file(index + (page - 1) * 100)) }));
  const input = { octokit: { rest: { pulls: { get, listFiles } } }, repo: { owner: 'acme', repo: 'app' }, number: 7, expectedHeadSha: headSha, context: { accountId: 'exact-account' } };
  return { input, get, listFiles };
}

describe('complete lightweight GitHub PR statistics', () => {
  test('reads every page and omits patch content', async () => {
    const { input, get, listFiles } = setup();
    const result = await readGitHubPullFileStats(input);
    expect(result.files).toHaveLength(201);
    expect(result.files[200]).toEqual({ path: 'file-200.ts', additions: 2, deletions: 1 });
    expect(listFiles.mock.calls.map(([options]) => options.page)).toEqual([1, 2, 3]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  test('large PRs reuse the authorized snapshot fallback', async () => {
    const { input, listFiles } = setup(3001);
    const readSnapshot = mock(async () => ({ files: Array.from({ length: 3001 }, (_, index) => file(index)) }));
    expect((await readGitHubPullFileStats({ ...input, readSnapshot })).files).toHaveLength(3001);
    expect(listFiles).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledWith(expect.objectContaining({ context: input.context, expectedHeadSha: headSha, expectedBaseSha: baseSha }));
  });
  test('a failed page and an incomplete page sequence cannot publish partial counts', async () => {
    const failure = setup();
    failure.listFiles.mockImplementation(async ({ page }) => { if (page === 2) throw new Error('offline'); return { data: Array.from({ length: 100 }, (_, index) => file(index)) }; });
    await expect(readGitHubPullFileStats(failure.input)).rejects.toThrow('offline');
    const partial = setup();
    partial.listFiles.mockImplementation(async () => ({ data: [file(1)] }));
    await expect(readGitHubPullFileStats(partial.input)).rejects.toMatchObject({ status: 409 });
  });
  test('a changed head or base during reading is stale', async () => {
    for (const side of ['head', 'base']) {
      const { input, get } = setup(1);
      get.mockImplementationOnce(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha }, changed_files: 1 } }));
      get.mockImplementation(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha }, changed_files: 1, [side]: { sha: 'c'.repeat(40) } } }));
      await expect(readGitHubPullFileStats(input)).rejects.toMatchObject({ status: 409 });
    }
  });
  test('a stale list head is refused before reading files', async () => {
    const { input, listFiles } = setup(1);
    await expect(readGitHubPullFileStats({ ...input, expectedHeadSha: 'd'.repeat(40) })).rejects.toMatchObject({ status: 409 });
    expect(listFiles).not.toHaveBeenCalled();
  });
});
