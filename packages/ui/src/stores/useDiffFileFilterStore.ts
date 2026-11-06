import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizePath } from '@/lib/pathNormalization';
import { normalizeExcludedFileTypes } from '@/lib/diff/fileTypeFilter';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const EMPTY_TYPES: string[] = [];

export const diffFileFilterKey = (runtimeKey: string, projectPath: string): string =>
  JSON.stringify([runtimeKey, normalizePath(projectPath)]);

const parseExcludedByProject = (value: unknown): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, types] of Object.entries(value)) {
    try {
      const owner: unknown = JSON.parse(key);
      if (!Array.isArray(owner) || owner.length !== 2 || !owner.every((part) => typeof part === 'string' && part.length > 0)) continue;
      const normalized = normalizeExcludedFileTypes(types);
      if (normalized.length > 0) result[key] = normalized;
    } catch {
      // A malformed owner's record cannot discard another project's preferences.
    }
  }
  return result;
};

interface DiffFileFilterState {
  excludedByProject: Record<string, string[]>;
  setExcludedTypes: (ownerKey: string, types: readonly string[]) => void;
}

export const useDiffFileFilterStore = create<DiffFileFilterState>()(persist((set) => ({
  excludedByProject: {},
  setExcludedTypes: (ownerKey, types) => set((state) => {
    const next = normalizeExcludedFileTypes(types);
    const previous = state.excludedByProject[ownerKey] ?? EMPTY_TYPES;
    if (next.length === previous.length && next.every((type, index) => type === previous[index])) return state;
    const excludedByProject = { ...state.excludedByProject };
    if (next.length > 0) excludedByProject[ownerKey] = next;
    else delete excludedByProject[ownerKey];
    return { excludedByProject };
  }),
}), {
  name: 'openchamber.diff-file-types.v1',
  storage: createDeferredSafeJSONStorage(),
  partialize: (state) => ({ excludedByProject: state.excludedByProject }),
  merge: (persisted: unknown, current) => ({
    ...current,
    excludedByProject: parseExcludedByProject(persisted && typeof persisted === 'object' && 'excludedByProject' in persisted
      ? persisted.excludedByProject : undefined),
  }),
}));

export const selectExcludedFileTypes = (state: DiffFileFilterState, ownerKey: string | null): string[] =>
  (ownerKey ? state.excludedByProject[ownerKey] : undefined) ?? EMPTY_TYPES;
