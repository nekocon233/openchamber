import React from 'react';
import { getFileExtension } from '@/lib/toolHelpers';
import { filterDiffFileTypes } from '@/lib/diff/fileTypeFilter';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { diffFileFilterKey, selectExcludedFileTypes, useDiffFileFilterStore } from '@/stores/useDiffFileFilterStore';

export const useDiffFileFilter = <T extends { path: string }>(runtimeKey: string, directory: string | null | undefined, files: T[]) => {
  const projects = useProjectsStore((state) => state.projects);
  const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
  const ownerKey = React.useMemo(() => {
    const path = normalizePath(directory);
    if (!path) return null;
    const project = resolveProjectForSessionDirectory(projects, worktrees, path);
    return diffFileFilterKey(runtimeKey, project?.path ?? path);
  }, [directory, projects, runtimeKey, worktrees]);
  const excludedTypes = useDiffFileFilterStore((state) => selectExcludedFileTypes(state, ownerKey));
  const setExcludedTypes = useDiffFileFilterStore((state) => state.setExcludedTypes);
  const setTypes = React.useCallback((types: readonly string[]) => {
    if (ownerKey) setExcludedTypes(ownerKey, types);
  }, [ownerKey, setExcludedTypes]);
  const restoreAll = React.useCallback(() => setTypes([]), [setTypes]);
  const restoreType = React.useCallback((path: string) => {
    if (!ownerKey) return;
    const current = selectExcludedFileTypes(useDiffFileFilterStore.getState(), ownerKey);
    setTypes(current.filter((type) => type !== getFileExtension(path)));
  }, [ownerKey, setTypes]);
  const isHidden = React.useCallback((path: string) => excludedTypes.includes(getFileExtension(path)), [excludedTypes]);
  const filtered = React.useMemo(() => filterDiffFileTypes(files, excludedTypes), [excludedTypes, files]);
  return { ...filtered, excludedTypes, setTypes, restoreAll, restoreType, isHidden };
};
