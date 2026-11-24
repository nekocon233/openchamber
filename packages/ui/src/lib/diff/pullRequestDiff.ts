import { processFile } from '@pierre/diffs';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { buildTargetQuery } from '@/lib/walkthrough/api';
import type { WalkthroughSource } from '@/lib/walkthrough/types';

export type PullRequestSource = Extract<WalkthroughSource, { kind: 'pr' }>;
export interface PullRequestDiffFile {
  path: string;
  previousPath?: string;
  status: string;
  insertions: number;
  deletions: number;
  patch?: string;
}
export interface PullRequestDiffSnapshot {
  files: PullRequestDiffFile[];
  headSha: string | null;
}

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const pullRequestFilesResponseSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('files'),
    headSha: shaSchema.nullable(),
    files: z.array(z.object({
      path: z.string().min(1),
      previousPath: z.string().min(1).optional(),
      status: z.string().min(1),
      insertions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      patch: z.string().optional(),
    })),
  }),
  z.object({
    mode: z.literal('patch'),
    headSha: shaSchema.nullable(),
    patch: z.string(),
  }),
]);
const pullRequestFileDiffResponseSchema = z.object({
  diff: z.string(),
  headSha: shaSchema.nullable().optional(),
});

export const revisionSuffix = (source: PullRequestSource): string => (source.revision ? ` @${source.revision.slice(0, 7)}` : '');

export function parsePullRequestDiff(patch: string) {
  if (!patch.trim()) return [];
  if (!patch.startsWith('diff --git ')) throw new Error('Invalid pull request diff');
  return patch.split(/(?=^diff --git )/m).filter(Boolean).map((filePatch) => {
    const file = processFile(filePatch);
    if (!file) throw new Error('Invalid pull request file diff');
    return {
      path: file.name,
      previousPath: file.prevName,
      status: /^new file mode /m.test(filePatch) ? 'A'
        : /^deleted file mode /m.test(filePatch) ? 'D'
        : /^rename from /m.test(filePatch) ? 'R'
        : /^copy from /m.test(filePatch) ? 'C' : 'M',
      insertions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      patch: filePatch,
    };
  });
}

async function throwPullRequestError(response: Response, fallback: string): Promise<never> {
  const error = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
  throw new Error(error.success ? error.data.error : `${fallback} (${response.status})`);
}

async function fetchLegacyPullRequestDiff(
  directory: string,
  source: PullRequestSource,
  context: Readonly<SourceControlReadContext>,
): Promise<PullRequestDiffSnapshot> {
  const response = await runtimeFetch('/api/walkthrough/pr-diff', {
    query: buildTargetQuery(directory, { source, context }),
    signal: AbortSignal.timeout(5 * 60_000 + 5_000),
  });
  if (!response.ok) await throwPullRequestError(response, 'Failed to load pull request diff');
  if (!response.headers.get('content-type')?.includes('text/plain')) throw new Error('Pull request comparison is unavailable on this server');
  const revision = response.headers.get('X-OpenChamber-PR-Head-Sha');
  const headSha = revision ? shaSchema.parse(revision) : null;
  return { files: parsePullRequestDiff(await response.text()), headSha };
}

export async function fetchPullRequestDiff(directory: string, source: PullRequestSource, context: Readonly<SourceControlReadContext>): Promise<PullRequestDiffSnapshot> {
  const response = await runtimeFetch('/api/walkthrough/pr-files', {
    query: buildTargetQuery(directory, { source, context }),
    signal: AbortSignal.timeout(5 * 60_000 + 5_000),
  });
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  if (!isJson && (response.ok || response.status === 404)) {
    return fetchLegacyPullRequestDiff(directory, source, context);
  }
  if (!response.ok) await throwPullRequestError(response, 'Failed to load pull request diff');
  if (!isJson) throw new Error('Pull request comparison is unavailable on this server');
  const parsed = pullRequestFilesResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Pull request comparison is unavailable on this server');
  if (parsed.data.mode === 'files') {
    return { files: parsed.data.files, headSha: parsed.data.headSha };
  }
  return { files: parsePullRequestDiff(parsed.data.patch), headSha: parsed.data.headSha };
}

export async function fetchPullRequestFileDiff(
  directory: string,
  source: PullRequestSource,
  context: Readonly<SourceControlReadContext>,
  file: { path: string; previousPath?: string; status: string; headSha?: string | null },
): Promise<{ diff: string; reviewHeadSha?: string }> {
  const response = await runtimeFetch('/api/walkthrough/pr-file-diff', {
    query: {
      ...buildTargetQuery(directory, { source, context }),
      path: file.path,
      previousPath: file.previousPath ?? '',
      status: file.status,
      headSha: file.headSha ?? '',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) await throwPullRequestError(response, 'Failed to load pull request file diff');
  const parsed = pullRequestFileDiffResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Pull request file diff is unavailable on this server');
  return { diff: parsed.data.diff, reviewHeadSha: parsed.data.headSha ?? file.headSha ?? undefined };
}

const pullRequestFileSchema = z.object({ original: z.string(), modified: z.string() });

export async function fetchPullRequestFile(
  directory: string,
  source: PullRequestSource,
  context: Readonly<SourceControlReadContext>,
  file: { path: string; previousPath?: string; status: string; headSha?: string | null; binary?: boolean },
) {
  const response = await runtimeFetch('/api/walkthrough/pr-file', {
    query: {
      ...buildTargetQuery(directory, { source, context }),
      path: file.path,
      previousPath: file.previousPath ?? '',
      status: file.status,
      headSha: file.headSha ?? '',
      binary: file.binary ? 'true' : undefined,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) await throwPullRequestError(response, 'Failed to load pull request file');
  const parsed = pullRequestFileSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Pull request file contents are unavailable on this server');
  return { ...parsed.data, reviewHeadSha: file.headSha ?? undefined };
}
