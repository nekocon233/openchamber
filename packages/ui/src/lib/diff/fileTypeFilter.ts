import { getFileExtension } from '@/lib/toolHelpers';

export interface DiffFileTypeOption {
  type: string;
  count: number;
}

/** An empty type names files without an extension, including leading-dot files. */
export const normalizeExcludedFileTypes = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((type): type is string => typeof type === 'string'
    && type === type.trim() && !/[.\\/\0]/u.test(type)).map((type) => type.toLowerCase()))].sort();
};

export const filterDiffFileTypes = <T extends { path: string }>(files: T[], excludedTypes: readonly string[]) => {
  const excluded = new Set(excludedTypes);
  const counts = new Map<string, number>(excludedTypes.map((type) => [type, 0]));
  const visibleFiles: T[] = [];
  for (const file of files) {
    const type = getFileExtension(file.path);
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (!excluded.has(type)) visibleFiles.push(file);
  }
  return {
    files: visibleFiles.length === files.length ? files : visibleFiles,
    options: Array.from(counts, ([type, count]): DiffFileTypeOption => ({ type, count }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    hiddenCount: files.length - visibleFiles.length,
  };
};
