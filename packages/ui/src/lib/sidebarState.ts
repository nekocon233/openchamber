import type {
  SidebarProjectEntry,
  SidebarSessionFolder,
  SidebarStateMutationResult,
  SidebarStateOperation,
  SidebarStateSnapshot,
} from '@/lib/api/types';

const ARCHIVED_SCOPE_PREFIX = '__archived__:';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export class SidebarStateConflictError extends Error {
  readonly latestSnapshot: SidebarStateSnapshot;

  constructor(latestSnapshot: SidebarStateSnapshot) {
    super('Sidebar state revision conflict');
    this.name = 'SidebarStateConflictError';
    this.latestSnapshot = latestSnapshot;
  }
}

const normalizeSegments = (segments: string[], minimumDepth: number): string[] => {
  const result = segments.slice(0, minimumDepth);
  for (let index = minimumDepth; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (result.length <= minimumDepth) throw new Error('Path cannot traverse above its root');
      result.pop();
      continue;
    }
    result.push(segment);
  }
  return result;
};

export const normalizeSidebarPath = (value: string): string => {
  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!trimmed || hasControlCharacter) throw new Error('Path is invalid');
  const slashed = trimmed.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(slashed)) {
    const segments = normalizeSegments(slashed.slice(3).split('/'), 0);
    return segments.length > 0 ? `${slashed[0].toUpperCase()}:/${segments.join('/')}` : `${slashed[0].toUpperCase()}:/`;
  }
  if (slashed.startsWith('//') && !slashed.startsWith('///')) {
    const components = slashed.slice(2).split('/').filter(Boolean);
    if (components.length < 2 || components[0] === '.' || components[0] === '..' || components[1] === '.' || components[1] === '..') {
      throw new Error('UNC path must include a server and share');
    }
    return `//${normalizeSegments(components, 2).join('/')}`;
  }
  if (slashed.startsWith('/')) {
    const segments = normalizeSegments(slashed.replace(/^\/+/, '').split('/'), 0);
    return segments.length > 0 ? `/${segments.join('/')}` : '/';
  }
  throw new Error('Path must be absolute');
};

export const normalizeSidebarFolderScope = (value: string): string => {
  const archived = value.startsWith(ARCHIVED_SCOPE_PREFIX);
  const path = normalizeSidebarPath(archived ? value.slice(ARCHIVED_SCOPE_PREFIX.length) : value);
  return archived ? `${ARCHIVED_SCOPE_PREFIX}${path}` : path;
};

const parseProject = (value: unknown): SidebarProjectEntry => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') {
    throw new Error('Invalid sidebar project');
  }
  return { ...value } as SidebarProjectEntry;
};

const parseFolder = (value: unknown): SidebarSessionFolder => {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || !Array.isArray(value.sessionIds)
    || !value.sessionIds.every((entry) => typeof entry === 'string')
    || typeof value.createdAt !== 'number'
    || (value.parentId !== null && typeof value.parentId !== 'string')
  ) {
    throw new Error('Invalid sidebar session folder');
  }
  return {
    id: value.id,
    name: value.name,
    sessionIds: [...value.sessionIds],
    createdAt: value.createdAt,
    parentId: value.parentId,
  };
};

export const parseSidebarStateSnapshot = (value: unknown): SidebarStateSnapshot => {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !Array.isArray(value.projects)
    || !Array.isArray(value.pinnedSessionIds)
    || !value.pinnedSessionIds.every((entry) => typeof entry === 'string')
    || !isRecord(value.worktreeOrderByProject)
    || !isRecord(value.sessionFoldersByScope)
  ) {
    throw new Error('Invalid sidebar state snapshot');
  }

  const worktreeOrderByProject: Record<string, string[]> = {};
  for (const [projectId, paths] of Object.entries(value.worktreeOrderByProject)) {
    if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === 'string')) {
      throw new Error('Invalid sidebar worktree order');
    }
    worktreeOrderByProject[projectId] = [...paths];
  }
  const sessionFoldersByScope: Record<string, SidebarSessionFolder[]> = {};
  for (const [scopeKey, folders] of Object.entries(value.sessionFoldersByScope)) {
    if (!Array.isArray(folders)) throw new Error('Invalid sidebar folder scope');
    sessionFoldersByScope[scopeKey] = folders.map(parseFolder);
  }
  return {
    schemaVersion: 1,
    revision: Number(value.revision),
    projects: value.projects.map(parseProject),
    pinnedSessionIds: [...value.pinnedSessionIds],
    worktreeOrderByProject,
    sessionFoldersByScope,
  };
};

export const parseSidebarStateMutationResult = (value: unknown): SidebarStateMutationResult => {
  if (
    !isRecord(value)
    || typeof value.applied !== 'boolean'
    || typeof value.deduplicated !== 'boolean'
    || !Number.isSafeInteger(value.mutationRevision)
  ) {
    throw new Error('Invalid sidebar mutation result');
  }
  return {
    snapshot: parseSidebarStateSnapshot(value.snapshot),
    applied: value.applied,
    deduplicated: value.deduplicated,
    mutationRevision: Number(value.mutationRevision),
  };
};

const cloneSnapshot = (snapshot: SidebarStateSnapshot): SidebarStateSnapshot => ({
  ...snapshot,
  projects: snapshot.projects.map((project) => ({
    ...project,
    ...(project.iconImage ? { iconImage: { ...project.iconImage } } : {}),
  })),
  pinnedSessionIds: [...snapshot.pinnedSessionIds],
  worktreeOrderByProject: Object.fromEntries(
    Object.entries(snapshot.worktreeOrderByProject).map(([projectId, paths]) => [projectId, [...paths]]),
  ),
  sessionFoldersByScope: Object.fromEntries(
    Object.entries(snapshot.sessionFoldersByScope).map(([scopeKey, folders]) => [
      scopeKey,
      folders.map((folder) => ({ ...folder, sessionIds: [...folder.sessionIds] })),
    ]),
  ),
});

export const applySidebarStateOperation = (
  snapshot: SidebarStateSnapshot,
  operation: SidebarStateOperation,
): SidebarStateSnapshot => {
  const next = cloneSnapshot(snapshot);
  switch (operation.type) {
    case 'project.add': {
      if (next.projects.some((project) => project.id === operation.project.id || project.path === operation.project.path)) return next;
      next.projects.splice(operation.index ?? next.projects.length, 0, { ...operation.project });
      return next;
    }
    case 'project.remove':
      next.projects = next.projects.filter((project) => project.id !== operation.projectId);
      delete next.worktreeOrderByProject[operation.projectId];
      return next;
    case 'project.update': {
      const index = next.projects.findIndex((project) => project.id === operation.projectId);
      if (index < 0) throw new Error('Unknown project');
      const project = { ...next.projects[index] } as Record<string, unknown>;
      for (const [key, value] of Object.entries(operation.patch)) {
        if (value === null) delete project[key];
        else project[key] = value;
      }
      next.projects[index] = project as SidebarProjectEntry;
      return next;
    }
    case 'project.move': {
      const index = next.projects.findIndex((project) => project.id === operation.projectId);
      if (index < 0 || operation.toIndex < 0 || operation.toIndex >= next.projects.length) throw new Error('Invalid project move');
      const [project] = next.projects.splice(index, 1);
      next.projects.splice(operation.toIndex, 0, project);
      return next;
    }
    case 'session.pin':
      if (!next.pinnedSessionIds.includes(operation.sessionId)) next.pinnedSessionIds.push(operation.sessionId);
      return next;
    case 'session.unpin':
      next.pinnedSessionIds = next.pinnedSessionIds.filter((sessionId) => sessionId !== operation.sessionId);
      return next;
    case 'worktree.move': {
      if (!next.projects.some((project) => project.id === operation.projectId)) throw new Error('Unknown project');
      const paths = [...operation.orderedPaths];
      const index = paths.indexOf(operation.path);
      if (index < 0 || operation.toIndex < 0 || operation.toIndex >= paths.length) throw new Error('Invalid worktree move');
      const [path] = paths.splice(index, 1);
      paths.splice(operation.toIndex, 0, path);
      next.worktreeOrderByProject[operation.projectId] = paths;
      return next;
    }
    case 'worktree.clearOrder':
      delete next.worktreeOrderByProject[operation.projectId];
      return next;
    case 'folder.create': {
      const folders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      if (Object.values(next.sessionFoldersByScope).some((entries) => entries.some((folder) => folder.id === operation.folder.id))) return next;
      next.sessionFoldersByScope[operation.scopeKey] = [...folders, { ...operation.folder, sessionIds: [] }];
      return next;
    }
    case 'folder.rename': {
      const folders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      next.sessionFoldersByScope[operation.scopeKey] = folders.map((folder) => (
        folder.id === operation.folderId ? { ...folder, name: operation.name } : folder
      ));
      return next;
    }
    case 'folder.delete': {
      const folders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      const deleted = new Set([operation.folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of folders) {
          if (folder.parentId && deleted.has(folder.parentId) && !deleted.has(folder.id)) {
            deleted.add(folder.id);
            changed = true;
          }
        }
      }
      const remaining = folders.filter((folder) => !deleted.has(folder.id));
      if (remaining.length > 0) next.sessionFoldersByScope[operation.scopeKey] = remaining;
      else delete next.sessionFoldersByScope[operation.scopeKey];
      return next;
    }
    case 'folder.assign': {
      const assigned = new Set(operation.sessionIds);
      const folders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      next.sessionFoldersByScope[operation.scopeKey] = folders.map((folder) => {
        const sessionIds = folder.sessionIds.filter((sessionId) => !assigned.has(sessionId));
        return folder.id === operation.folderId
          ? { ...folder, sessionIds: [...sessionIds, ...operation.sessionIds] }
          : { ...folder, sessionIds };
      });
      return next;
    }
    case 'folder.unassign': {
      const removed = new Set(operation.sessionIds);
      const folders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      next.sessionFoldersByScope[operation.scopeKey] = folders.map((folder) => ({
        ...folder,
        sessionIds: folder.sessionIds.filter((sessionId) => !removed.has(sessionId)),
      }));
      return next;
    }
    case 'folder.cleanup': {
      const existing = new Set(operation.existingSessionIds);
      let folders = (next.sessionFoldersByScope[operation.scopeKey] ?? [])
        .map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter((sessionId) => existing.has(sessionId)) }))
        .filter((folder) => !operation.pruneEmpty || folder.sessionIds.length > 0);
      let hierarchyChanged = true;
      while (hierarchyChanged) {
        const folderIds = new Set(folders.map((folder) => folder.id));
        const hierarchyCleaned = folders.filter((folder) => !folder.parentId || folderIds.has(folder.parentId));
        hierarchyChanged = hierarchyCleaned.length !== folders.length;
        folders = hierarchyCleaned;
      }
      if (folders.length > 0) next.sessionFoldersByScope[operation.scopeKey] = folders;
      else delete next.sessionFoldersByScope[operation.scopeKey];
      return next;
    }
  }
};
