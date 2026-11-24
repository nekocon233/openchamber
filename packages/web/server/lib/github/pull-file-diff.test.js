import { describe, expect, it, vi } from 'vitest';
import { fileDiffFromPatch, isBinaryPatch } from '../../../../ui/src/lib/diff/patchFileDiff';
import {
  MAX_INLINE_PR_FILE_PATCH_BYTES,
  MAX_SINGLE_FILE_BYTES,
  buildGitHubFilePatch,
  computeUnifiedFilePatch,
  readGitHubPullFileDiff,
  readGitHubPullFileList,
} from './pull-file-diff.js';

const repo = { owner: 'acme', repo: 'app' };
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergeBaseSha = 'c'.repeat(40);
const tooLargeContentError = (status = 403) => Object.assign(new Error('This API returns blobs up to 1 MB in size.'), {
  status,
  response: { data: { errors: [{ resource: 'Blob', field: 'data', code: 'too_large' }] } },
});

describe('GitHub PR file list and lazy per-file diffs', () => {
  it('loads paginated files with inline patches for small files and defers oversized or omitted patches', async () => {
    const smallHunk = '@@ -1 +1 @@\n-old\n+new';
    const largeInlineHunk = `@@ -1 +1 @@\n+${'x'.repeat(MAX_INLINE_PR_FILE_PATCH_BYTES + 128)}`;
    const get = vi.fn(async () => ({
      data: { number: 7, head: { sha: headSha }, base: { sha: baseSha }, changed_files: 4 },
    }));
    const listFiles = vi.fn(async () => ({
      data: [
        { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: smallHunk },
        { filename: 'src/renamed.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 1, deletions: 1, changes: 2, patch: smallHunk },
        { filename: 'generated/huge.json', status: 'modified', additions: 250_000, deletions: 0, changes: 250_000 },
        { filename: 'generated/medium-lock.json', status: 'modified', additions: 5000, deletions: 0, changes: 5000, patch: largeInlineHunk },
      ],
    }));

    const result = await readGitHubPullFileList({
      octokit: { rest: { pulls: { get, listFiles } } },
      repo,
      number: 7,
    });

    expect(result.headSha).toBe(headSha);
    expect(result.files).toHaveLength(4);
    expect(result.files[0]).toMatchObject({ path: 'src/app.ts', status: 'M', insertions: 1, deletions: 1 });
    expect(result.files[0].patch).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(fileDiffFromPatch('src/app.ts', result.files[0].patch).hunks).toHaveLength(1);
    expect(result.files[1]).toMatchObject({ path: 'src/renamed.ts', previousPath: 'src/old.ts', status: 'R' });
    expect(result.files[1].patch).toContain('rename from src/old.ts\nrename to src/renamed.ts');
    expect(result.files[2]).toEqual({ path: 'generated/huge.json', status: 'M', insertions: 250_000, deletions: 0 });
    expect(result.files[2].patch).toBeUndefined();
    expect(result.files[3].patch).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('uses the metadata-only snapshot fallback above 3000 files and marks binary files directly', async () => {
    const get = vi.fn(async () => ({
      data: { number: 7, head: { sha: headSha }, base: { sha: baseSha }, changed_files: 3001 },
    }));
    const listFiles = vi.fn();
    const readSnapshot = vi.fn(async () => ({
      files: [
        { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4 },
        { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0, binary: true },
      ],
    }));

    const result = await readGitHubPullFileList({
      octokit: { rest: { pulls: { get, listFiles } } },
      repo,
      number: 7,
      readSnapshot,
    });

    expect(listFiles).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledWith({ expectedHeadSha: headSha, expectedBaseSha: baseSha });
    expect(result.headSha).toBe(headSha);
    expect(result.files[0]).toEqual({ path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1 });
    expect(isBinaryPatch(result.files[1].patch ?? '')).toBe(true);
  });

  it('rejects stale revisions when the PR head changes while reading files', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha }, changed_files: 1 } })
      .mockResolvedValueOnce({ data: { number: 7, head: { sha: 'd'.repeat(40) }, base: { sha: baseSha }, changed_files: 1 } });
    const listFiles = vi.fn(async () => ({
      data: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
    }));

    await expect(readGitHubPullFileList({
      octokit: { rest: { pulls: { get, listFiles } } },
      repo,
      number: 7,
    })).rejects.toMatchObject({ code: 'STALE_CONFIG', status: 409 });
  });

  it('builds parseable patches for special filenames with quotes and spaces', () => {
    const patch = buildGitHubFilePatch({
      path: 'dir/file "quoted" name.txt',
      status: 'added',
      patch: '@@ -0,0 +1 @@\n+hello',
    });
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('--- /dev/null');
    expect(fileDiffFromPatch('dir/file "quoted" name.txt', patch).hunks).toHaveLength(1);
  });

  it('computes a single file unified diff from GitHub contents and caches the merge base', async () => {
    const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } }));
    const request = vi.fn(async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
        return { data: { merge_base_commit: { sha: mergeBaseSha } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        const text = params.ref === mergeBaseSha ? 'line1\nold\nline3\n' : 'line1\nnew\nline3\n';
        return {
          data: {
            type: 'file',
            size: Buffer.byteLength(text),
            sha: '1'.repeat(40),
            encoding: 'base64',
            content: Buffer.from(text).toString('base64'),
          },
        };
      }
      throw new Error(`Unexpected route ${route}`);
    });
    const octokit = { rest: { pulls: { get } }, request };

    const first = await readGitHubPullFileDiff({
      octokit,
      repo,
      number: 7,
      path: 'src/app.ts',
      status: 'M',
      expectedHeadSha: headSha,
    });
    expect(first.headSha).toBe(headSha);
    expect(first.diff).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(first.diff).toContain('-old\n+new');
    expect(fileDiffFromPatch('src/app.ts', first.diff).hunks).toHaveLength(1);

    const second = await readGitHubPullFileDiff({
      octokit,
      repo,
      number: 7,
      path: 'src/second.ts',
      status: 'M',
      expectedHeadSha: headSha,
    });
    expect(second.diff).toContain('diff --git a/src/second.ts b/src/second.ts');
    expect(request.mock.calls.filter(([route]) => route === 'GET /repos/{owner}/{repo}/compare/{basehead}')).toHaveLength(1);
  });

  it('rejects files over 5 MiB via parent directory metadata without downloading the blob', async () => {
    const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } }));
    const request = vi.fn(async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === 'generated/huge.json') {
        throw tooLargeContentError();
      }
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === 'generated') {
        return {
          data: [
            { type: 'file', path: 'generated/huge.json', name: 'huge.json', sha: '2'.repeat(40), size: MAX_SINGLE_FILE_BYTES + 1024 },
          ],
        };
      }
      throw new Error(`Should not have called ${route} for ${JSON.stringify(params)}`);
    });

    await expect(readGitHubPullFileDiff({
      octokit: { rest: { pulls: { get } }, request },
      repo,
      number: 7,
      path: 'generated/huge.json',
      status: 'A',
      expectedHeadSha: headSha,
    })).rejects.toMatchObject({ status: 413, code: 'file-too-large' });
    expect(request.mock.calls.some(([route]) => route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}')).toBe(false);
  });

  it('loads a 1-5 MiB file through its blob SHA when contents returns too_large', async () => {
    const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } }));
    const body = `${'a'.repeat(1024)}\nnew-line\n`;
    const request = vi.fn(async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === 'large/data.txt') {
        throw tooLargeContentError();
      }
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === 'large') {
        return {
          data: [{ type: 'file', path: 'large/data.txt', name: 'data.txt', sha: '3'.repeat(40), size: 2 * 1024 * 1024 }],
        };
      }
      if (route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}') {
        return {
          data: { size: Buffer.byteLength(body), encoding: 'base64', content: Buffer.from(body).toString('base64') },
        };
      }
      throw new Error(`Unexpected ${route}`);
    });

    const result = await readGitHubPullFileDiff({
      octokit: { rest: { pulls: { get } }, request },
      repo,
      number: 7,
      path: 'large/data.txt',
      status: 'A',
      expectedHeadSha: headSha,
    });
    expect(result.diff).toContain('new file mode 100644');
    expect(result.diff).toContain('+new-line');
  });

  it('handles binary files, submodules, pure renames, and stale heads cleanly', async () => {
    const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } }));

    const binaryResult = await readGitHubPullFileDiff({
      octokit: {
        rest: { pulls: { get } },
        request: vi.fn(async () => ({
          data: { type: 'file', size: 4, sha: '4'.repeat(40), encoding: 'base64', content: Buffer.from([0x89, 0x50, 0x00, 0x47]).toString('base64') },
        })),
      },
      repo,
      number: 7,
      path: 'logo.png',
      status: 'A',
    });
    expect(isBinaryPatch(binaryResult.diff)).toBe(true);

    const submoduleResult = await readGitHubPullFileDiff({
      octokit: {
        rest: { pulls: { get } },
        request: vi.fn(async (route, params) => {
          if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { merge_base_commit: { sha: mergeBaseSha } } };
          return { data: { type: 'submodule', sha: params.ref === mergeBaseSha ? '1'.repeat(40) : '2'.repeat(40) } };
        }),
      },
      repo,
      number: 7,
      path: 'vendor/sub',
      status: 'M',
    });
    expect(submoduleResult.diff).toContain(`-Subproject commit ${'1'.repeat(40)}`);
    expect(submoduleResult.diff).toContain(`+Subproject commit ${'2'.repeat(40)}`);

    const renameResult = await readGitHubPullFileDiff({
      octokit: {
        rest: { pulls: { get } },
        request: vi.fn(async (route) => {
          if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { merge_base_commit: { sha: mergeBaseSha } } };
          return { data: { type: 'file', size: 5, sha: '5'.repeat(40), encoding: 'base64', content: Buffer.from('same\n').toString('base64') } };
        }),
      },
      repo,
      number: 7,
      path: 'new.ts',
      previousPath: 'old.ts',
      status: 'R',
    });
    expect(renameResult.diff).toBe('diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n');

    await expect(readGitHubPullFileDiff({
      octokit: { rest: { pulls: { get } }, request: vi.fn() },
      repo,
      number: 7,
      path: 'a.ts',
      status: 'M',
      expectedHeadSha: 'f'.repeat(40),
    })).rejects.toMatchObject({ status: 409, code: 'STALE_CONFIG' });
  });

  it('rejects a single file diff whose computed output exceeds the limit', async () => {
    await expect(computeUnifiedFilePatch({
      path: 'wide.txt',
      status: 'A',
      original: '',
      modified: 'a\n'.repeat(200),
      maxOutputBytes: 64,
    })).rejects.toMatchObject({ status: 413, code: 'file-too-large' });
  });

  it('falls back to blob fetch when 200 contents omits or nulls base64 content on a non-empty file', async () => {
    const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } }));
    const cases = [
      { encoding: 'base64', content: '' },
      { encoding: null, content: null },
    ];
    for (const payload of cases) {
      const request = vi.fn(async (route) => {
        if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
          return { data: { type: 'file', size: 12, sha: '6'.repeat(40), ...payload } };
        }
        if (route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}') {
          return { data: { size: 12, encoding: 'base64', content: Buffer.from('from-blob\n').toString('base64') } };
        }
        throw new Error(`Unexpected ${route}`);
      });
      const result = await readGitHubPullFileDiff({
        octokit: { rest: { pulls: { get } }, request },
        repo,
        number: 7,
        path: 'large/inline-omitted.txt',
        status: 'A',
        expectedHeadSha: headSha,
      });
      expect(result.diff).toContain('+from-blob');
    }
  });
});
