import { z } from 'zod';
import { filterDiffFileTypes } from '@/lib/diff/fileTypeFilter';
import type { ChangeRequestFileStats } from './types';

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const count = z.number().int().nonnegative().nullable();
export const changeRequestFileStatsSchema = z.object({
  headSha: sha, baseSha: sha,
  files: z.array(z.object({ path: z.string().min(1), additions: count, deletions: count })),
}).refine(value => new Set(value.files.map(file => file.path)).size === value.files.length, 'Duplicate file paths');

/** Unknown line counts remain unknown, while a fully filtered result is zero. */
export function summarizeFileStats(stats: ChangeRequestFileStats, excludedTypes: readonly string[]) {
  const { files } = filterDiffFileTypes(stats.files, excludedTypes);
  let additions: number | null = 0;
  let deletions: number | null = 0;
  for (const file of files) {
    additions = additions === null || file.additions === null ? null : additions + file.additions;
    deletions = deletions === null || file.deletions === null ? null : deletions + file.deletions;
  }
  return { files: files.length, additions, deletions };
}
