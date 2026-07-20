import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { opencodeClient } from '@/lib/opencode/client';
import type {
  RuntimeAPIs,
  SidebarStateAPI,
  SidebarStateOperation,
  SidebarStateSnapshot,
} from '@/lib/api/types';
import { applySidebarStateOperation } from '@/lib/sidebarState';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { useSessionFoldersStore } from './useSessionFoldersStore';
import { useSessionPinnedStore } from './useSessionPinnedStore';
import { useSidebarStateStore } from './useSidebarStateStore';
import { useWorktreeOrderStore } from './useWorktreeOrderStore';

const initialSnapshot = (): SidebarStateSnapshot => ({
  schemaVersion: 1,
  revision: 0,
  projects: [{ id: 'project-one', path: '/workspace/project', label: 'Project' }],
  pinnedSessionIds: [],
  worktreeOrderByProject: {},
  sessionFoldersByScope: {},
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('authoritative sidebar structure projections', () => {
  let authoritative: SidebarStateSnapshot;
  let operations: SidebarStateOperation[];
  let mutationFailure: Error | null;

  beforeEach(() => {
    authoritative = initialSnapshot();
    operations = [];
    mutationFailure = null;
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => authoritative,
      mutate: async (request) => {
        operations.push(request.operation);
        if (mutationFailure) throw mutationFailure;
        authoritative = {
          ...applySidebarStateOperation(authoritative, request.operation),
          revision: authoritative.revision + 1,
        };
        return {
          snapshot: authoritative,
          applied: true,
          deduplicated: false,
          mutationRevision: authoritative.revision,
        };
      },
    };
    registerRuntimeAPIs({ sidebarState: api } as RuntimeAPIs);
    useSidebarStateStore.setState({
      runtimeKey: getRuntimeKey().trim() || 'default',
      generation: 0,
      supported: true,
      status: 'ready',
      baseSnapshot: null,
      snapshot: null,
      pendingOperations: [],
      error: null,
    });
    useSidebarStateStore.getState().installAuthoritativeSnapshot(authoritative);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    registerRuntimeAPIs(null);
  });

  test('submits pin intents and projects the returned snapshot', async () => {
    const worktreeOrderBefore = useWorktreeOrderStore.getState().orderByProject;
    const foldersBefore = useSessionFoldersStore.getState().foldersMap;
    useSessionPinnedStore.getState().toggle('session-one');
    expect(useSessionPinnedStore.getState().ids.has('session-one')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operations.some((operation) => (
      operation.type === 'session.pin' && operation.sessionId === 'session-one'
    ))).toBe(true);
    expect(useSessionPinnedStore.getState().ids).toEqual(new Set(['session-one']));
    expect(useWorktreeOrderStore.getState().orderByProject).toBe(worktreeOrderBefore);
    expect(useSessionFoldersStore.getState().foldersMap).toBe(foldersBefore);
  });

  test('restores active project and directory after an optimistic project add fails', async () => {
    const originalProject = authoritative.projects[0];
    useProjectsStore.setState({
      projects: [originalProject],
      activeProjectId: originalProject.id,
      manualProjectOrder: [originalProject.id],
    });
    useDirectoryStore.getState().setDirectory(originalProject.path, { showOverlay: false });
    mutationFailure = new Error('injected project add failure');

    const added = useProjectsStore.getState().addProject('/workspace/optimistic', {
      id: 'project-optimistic',
      label: 'Optimistic',
    });

    expect(added?.id).toBe('project-optimistic');
    expect(useProjectsStore.getState().activeProjectId).toBe('project-optimistic');
    expect(opencodeClient.getDirectory()).toBe('/workspace/optimistic');
    expect(useDirectoryStore.getState().currentDirectory).toBe('/workspace/optimistic');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([originalProject.id]);
    expect(useProjectsStore.getState().activeProjectId).toBe(originalProject.id);
    expect(opencodeClient.getDirectory()).toBe(originalProject.path);
    expect(useDirectoryStore.getState().currentDirectory).toBe(originalProject.path);
  });

  test('preserves local open intent while replacing fallback project metadata', () => {
    useProjectsStore.setState({
      projects: [{
        ...authoritative.projects[0],
        label: 'Cached label',
        color: 'cached-color',
        lastOpenedAt: 123,
        sidebarCollapsed: false,
      }],
      activeProjectId: 'project-one',
      manualProjectOrder: ['project-one'],
    });

    authoritative = {
      ...authoritative,
      revision: 1,
      projects: [{
        ...authoritative.projects[0],
        label: 'Canonical label',
        color: 'canonical-color',
      }],
    };
    useSidebarStateStore.getState().installAuthoritativeSnapshot(authoritative);

    expect(useProjectsStore.getState().projects).toEqual([{
      ...authoritative.projects[0],
      lastOpenedAt: 123,
      sidebarCollapsed: false,
    }]);
    expect(useProjectsStore.getState().activeProjectId).toBe('project-one');
  });

  test('rejects a late project icon snapshot after the runtime changes', async () => {
    const originalFetch = globalThis.fetch;
    const iconResponse = deferred<Response>();
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      return iconResponse.promise;
    }) as typeof fetch;

    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://icon-runtime-a.test', runtimeKey: 'icon-runtime-a' });
      useSidebarStateStore.getState().switchRuntime('icon-runtime-a');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const staleSnapshot = { ...authoritative, revision: 5 };
      const removal = useProjectsStore.getState().removeProjectIcon('project-one');
      while (!requestedUrl) await Promise.resolve();

      authoritative = {
        ...initialSnapshot(),
        revision: 20,
        projects: [{ id: 'project-new', path: '/workspace/new', label: 'New runtime project' }],
      };
      switchRuntimeEndpoint({ apiBaseUrl: 'http://icon-runtime-b.test', runtimeKey: 'icon-runtime-b' });
      useSidebarStateStore.getState().switchRuntime('icon-runtime-b');
      await new Promise((resolve) => setTimeout(resolve, 0));
      iconResponse.resolve(new Response(JSON.stringify({ snapshot: staleSnapshot }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const result = await removal;
      expect(requestedUrl.startsWith('http://icon-runtime-a.test/')).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('runtime changed');
      expect(useSidebarStateStore.getState().runtimeKey).toBe('icon-runtime-b');
      expect(useSidebarStateStore.getState().baseSnapshot).toEqual(authoritative);
      expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual(['project-new']);
    } finally {
      globalThis.fetch = originalFetch;
      authoritative = initialSnapshot();
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'default' });
      useSidebarStateStore.getState().switchRuntime('default');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  test('submits a first worktree move with the complete pre-move order', async () => {
    useWorktreeOrderStore.getState().moveWorktree(
      'project-one',
      '/workspace/project/tree-two',
      0,
      ['/workspace/project/tree-one', '/workspace/project/tree-two'],
    );

    expect(useWorktreeOrderStore.getState().orderByProject['project-one']).toEqual([
      '/workspace/project/tree-two',
      '/workspace/project/tree-one',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operations.some((operation) => JSON.stringify(operation) === JSON.stringify({
      type: 'worktree.move',
      projectId: 'project-one',
      path: '/workspace/project/tree-two',
      toIndex: 0,
      orderedPaths: ['/workspace/project/tree-one', '/workspace/project/tree-two'],
    }))).toBe(true);
  });

  test('keeps synchronous folder creation while queueing create and assignment intents', async () => {
    const folder = useSessionFoldersStore.getState().createFolder('/workspace/project', 'Work');
    useSessionFoldersStore.getState().addSessionToFolder('/workspace/project', folder.id, 'session-one');

    expect(useSessionFoldersStore.getState().getSessionFolderId('/workspace/project', 'session-one')).toBe(folder.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operations.some((operation) => JSON.stringify(operation) === JSON.stringify({
      type: 'folder.create',
      scopeKey: '/workspace/project',
      folder: {
        id: folder.id,
        name: 'Work',
        createdAt: folder.createdAt,
        parentId: null,
      },
    }))).toBe(true);
    expect(operations.some((operation) => JSON.stringify(operation) === JSON.stringify({
      type: 'folder.assign',
      scopeKey: '/workspace/project',
      folderId: folder.id,
      sessionIds: ['session-one'],
    }))).toBe(true);
  });
});
