import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SidebarStateConflictError,
  SidebarStateCorruptError,
  SidebarStateIdempotencyError,
  SidebarStateNotInitializedError,
  SidebarStateError,
  SidebarStateValidationError,
  SidebarStateWriteError,
  createSidebarStateRuntime,
  createSidebarStateServerRuntime,
  normalizeSidebarPath,
} from './index.js';

const temporaryRoots = new Set();

afterEach(async () => {
  await Promise.all(
    Array.from(temporaryRoots, async (root) => {
      await fs.rm(root, { recursive: true, force: true });
      temporaryRoots.delete(root);
    }),
  );
});

const createFileSystem = (overrides = {}) => ({
  readFile: (...args) => fs.readFile(...args),
  writeFile: (...args) => fs.writeFile(...args),
  mkdir: (...args) => fs.mkdir(...args),
  rename: (...args) => fs.rename(...args),
  unlink: (...args) => fs.unlink(...args),
  ...overrides,
});

const createHarness = async (options = {}) => {
  const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-sidebar-state-'));
  temporaryRoots.add(root);
  const filePath = options.filePath ?? path.join(root, 'sidebar-state.json');
  let tempId = 0;
  const runtime = createSidebarStateRuntime({
    fsPromises: options.fsPromises ?? createFileSystem(),
    path,
    filePath,
    dedupeLimit: options.dedupeLimit,
    createTempId: options.createTempId ?? (() => `test-${tempId += 1}`),
  });
  return { filePath, root, runtime };
};

const project = (id, projectPath, metadata = {}) => ({
  id,
  path: projectPath,
  label: id,
  addedAt: 1,
  ...metadata,
});

const apply = (runtime, baseRevision, clientMutationId, operation) => runtime.applyMutation({
  baseRevision,
  clientMutationId,
  operation,
});

describe('sidebar state runtime', () => {
  it('distinguishes missing state from an authoritative empty success', async () => {
    const { filePath, runtime } = await createHarness();

    await expect(runtime.readSnapshot()).rejects.toBeInstanceOf(SidebarStateNotInitializedError);

    const initialized = await runtime.initialize();
    expect(initialized).toEqual({
      schemaVersion: 1,
      revision: 0,
      projects: [],
      pinnedSessionIds: [],
      worktreeOrderByProject: {},
      sessionFoldersByScope: {},
    });
    await expect(runtime.readSnapshot()).resolves.toEqual(initialized);

    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(stored).toMatchObject({
      storageVersion: 1,
      snapshot: initialized,
      recentMutations: [],
    });
  });

  it('initializes from sanitized legacy projects without device-local fields', async () => {
    const { runtime } = await createHarness();

    const snapshot = await runtime.initialize({
      legacyProjects: [{
        id: 'project-alpha',
        path: '/workspace//alpha/./',
        label: ' Alpha ',
        color: 'primary',
        defaultModel: 'openai/gpt-5',
        addedAt: 10.4,
        lastOpenedAt: 999,
        sidebarCollapsed: true,
      }],
    });

    expect(snapshot.projects).toEqual([{
      id: 'project-alpha',
      path: '/workspace/alpha',
      label: 'Alpha',
      color: 'primary',
      defaultModel: 'openai/gpt-5',
      addedAt: 10,
    }]);
    expect(snapshot.projects[0]).not.toHaveProperty('lastOpenedAt');
    expect(snapshot.projects[0]).not.toHaveProperty('sidebarCollapsed');
    expect(snapshot).not.toHaveProperty('activeProjectId');
  });

  it('imports the legacy session-folder disk projection only during first initialization', async () => {
    const { runtime } = await createHarness();
    const snapshot = await runtime.initialize({
      legacySessionFoldersByScope: {
        '/workspace//project/': [{
          id: 'folder-one',
          name: ' Work ',
          sessionIds: ['session-one', 'session-one'],
          createdAt: 4.6,
        }],
      },
    });

    expect(snapshot.sessionFoldersByScope).toEqual({
      '/workspace/project': [{
        id: 'folder-one',
        name: 'Work',
        sessionIds: ['session-one'],
        createdAt: 5,
        parentId: null,
      }],
    });

    const unchanged = await runtime.initialize({
      legacySessionFoldersByScope: {
        '/ignored': [{ id: 'folder-two', name: 'Ignored', sessionIds: [], createdAt: 1 }],
      },
    });
    expect(unchanged).toEqual(snapshot);
  });

  it('isolates malformed legacy projects and preserves truncation collisions by stable id', async () => {
    const { runtime } = await createHarness();
    const sharedLabel = 'x'.repeat(256);

    const snapshot = await runtime.initialize({
      legacyProjects: [
        project('project-a', '/repos//a/', {
          label: ` ${sharedLabel}alpha `,
          lastOpenedAt: 99,
          sidebarCollapsed: true,
        }),
        null,
        project('invalid id', '/repos/invalid-id'),
        project('project-relative', 'relative/path'),
        project('project-a', '/repos/duplicate-id'),
        project('project-b', '/repos/b', {
          label: `${sharedLabel}beta`,
          defaultModel: 'invalid-model',
          iconBackground: 'red',
          addedAt: -1,
          unsupportedLegacyMetadata: true,
        }),
        project('project-duplicate-path', '/repos/b/./'),
        project('project-c', '/repos/c', { label: ' C ' }),
      ],
    });

    expect(snapshot.projects.map((entry) => entry.id)).toEqual([
      'project-a',
      'project-b',
      'project-c',
    ]);
    expect(snapshot.projects[0]).toEqual({
      id: 'project-a',
      path: '/repos/a',
      label: sharedLabel,
      addedAt: 1,
    });
    expect(snapshot.projects[1]).toEqual({
      id: 'project-b',
      path: '/repos/b',
      label: sharedLabel,
    });
    expect(snapshot.projects[2]).toEqual({
      id: 'project-c',
      path: '/repos/c',
      label: 'C',
      addedAt: 1,
    });
    await expect(runtime.readSnapshot()).resolves.toEqual(snapshot);
  });

  it('isolates malformed legacy folders while preserving valid hierarchy and source order', async () => {
    const { runtime } = await createHarness();
    const sharedName = 'n'.repeat(256);

    const snapshot = await runtime.initialize({
      legacySessionFoldersByScope: {
        '/workspace//project/': [
          {
            id: 'folder-parent',
            name: `${sharedName}alpha`,
            sessionIds: ['session-one', 'bad session', 'session-one'],
            createdAt: 1.4,
          },
          {
            id: 'folder-child',
            name: ' Child ',
            sessionIds: ['session-one', 'session-two'],
            createdAt: 'invalid',
            parentId: 'folder-parent',
          },
          { id: 'folder-orphan', name: 'Orphan', sessionIds: [], createdAt: 2, parentId: 'missing' },
          { id: 'folder-invalid', name: '\n', sessionIds: [], createdAt: 2 },
          { id: 'folder-invalid-child', name: 'Invalid child', sessionIds: [], createdAt: 2, parentId: 'folder-invalid' },
          { id: 'folder-cycle-a', name: 'Cycle A', sessionIds: [], createdAt: 2, parentId: 'folder-cycle-b' },
          { id: 'folder-cycle-b', name: 'Cycle B', sessionIds: [], createdAt: 2, parentId: 'folder-cycle-a' },
          null,
        ],
        '/workspace/project': [{
          id: 'folder-second',
          name: `${sharedName}beta`,
          sessionIds: ['session-two', 'session-three'],
          createdAt: 3,
        }],
        'relative/scope': [{ id: 'folder-relative', name: 'Ignored', sessionIds: [], createdAt: 1 }],
        '/workspace/other': [
          { id: 'folder-parent', name: 'Duplicate ID', sessionIds: [], createdAt: 4 },
          { id: 'folder-other', name: 'Other', sessionIds: ['session-four'], createdAt: 5 },
        ],
      },
    });

    expect(snapshot.sessionFoldersByScope).toEqual({
      '/workspace/project': [
        {
          id: 'folder-parent',
          name: sharedName,
          sessionIds: ['session-one'],
          createdAt: 1,
          parentId: null,
        },
        {
          id: 'folder-child',
          name: 'Child',
          sessionIds: ['session-two'],
          createdAt: 0,
          parentId: 'folder-parent',
        },
        {
          id: 'folder-second',
          name: sharedName,
          sessionIds: ['session-three'],
          createdAt: 3,
          parentId: null,
        },
      ],
      '/workspace/other': [{
        id: 'folder-other',
        name: 'Other',
        sessionIds: ['session-four'],
        createdAt: 5,
        parentId: null,
      }],
    });
    await expect(runtime.readSnapshot()).resolves.toEqual(snapshot);
  });

  it('implements every v1 semantic operation', async () => {
    const { runtime } = await createHarness();
    await runtime.initialize({
      legacyProjects: [
        project('project-a', '/repos/a'),
        project('project-b', '/repos/b'),
      ],
    });

    let revision = 0;
    const mutate = async (clientMutationId, operation) => {
      const result = await apply(runtime, revision, clientMutationId, operation);
      revision = result.snapshot.revision;
      return result.snapshot;
    };

    let snapshot = await mutate('add-c', {
      type: 'project.add',
      project: project('project-c', '/repos//c/', { iconBackground: '#ABC' }),
      index: 1,
    });
    expect(snapshot.projects.map((entry) => entry.id)).toEqual(['project-a', 'project-c', 'project-b']);
    expect(snapshot.projects[1].path).toBe('/repos/c');
    expect(snapshot.projects[1].iconBackground).toBe('#abc');

    snapshot = await mutate('update-c', {
      type: 'project.update',
      projectId: 'project-c',
      patch: {
        label: 'Renamed C',
        color: 'keyword',
        defaultModel: 'anthropic/claude-sonnet',
      },
    });
    expect(snapshot.projects[1]).toMatchObject({
      label: 'Renamed C',
      color: 'keyword',
      defaultModel: 'anthropic/claude-sonnet',
    });

    snapshot = await mutate('move-c', {
      type: 'project.move',
      projectId: 'project-c',
      toIndex: 0,
    });
    expect(snapshot.projects.map((entry) => entry.id)).toEqual(['project-c', 'project-a', 'project-b']);

    await mutate('pin-one', { type: 'session.pin', sessionId: 'session-one' });
    snapshot = await mutate('pin-two', { type: 'session.pin', sessionId: 'session-two' });
    expect(snapshot.pinnedSessionIds).toEqual(['session-one', 'session-two']);
    snapshot = await mutate('unpin-one', { type: 'session.unpin', sessionId: 'session-one' });
    expect(snapshot.pinnedSessionIds).toEqual(['session-two']);

    snapshot = await mutate('move-worktree', {
      type: 'worktree.move',
      projectId: 'project-c',
      path: '/repos/c/.worktrees/two',
      toIndex: 0,
      orderedPaths: [
        '/repos/c/.worktrees/one',
        '/repos/c/.worktrees/two',
      ],
    });
    expect(snapshot.worktreeOrderByProject).toEqual({
      'project-c': [
        '/repos/c/.worktrees/two',
        '/repos/c/.worktrees/one',
      ],
    });

    snapshot = await mutate('clear-worktrees', {
      type: 'worktree.clearOrder',
      projectId: 'project-c',
    });
    expect(snapshot.worktreeOrderByProject).toEqual({});

    await mutate('restore-worktrees', {
      type: 'worktree.move',
      projectId: 'project-c',
      path: '/repos/c/.worktrees/one',
      toIndex: 1,
      orderedPaths: [
        '/repos/c/.worktrees/one',
        '/repos/c/.worktrees/two',
      ],
    });
    snapshot = await mutate('remove-c', {
      type: 'project.remove',
      projectId: 'project-c',
    });
    expect(snapshot.projects.map((entry) => entry.id)).toEqual(['project-a', 'project-b']);
    expect(snapshot.worktreeOrderByProject).toEqual({});
    expect(snapshot.revision).toBe(10);
  });

  it('serializes concurrently submitted mutations without losing updates', async () => {
    const { runtime } = await createHarness();
    await runtime.initialize();

    const count = 24;
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) => apply(runtime, index, `pin-${index}`, {
        type: 'session.pin',
        sessionId: `session-${index}`,
      })),
    );

    expect(results.map((result) => result.snapshot.revision)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    const snapshot = await runtime.readSnapshot();
    expect(snapshot.revision).toBe(count);
    expect(snapshot.pinnedSessionIds).toEqual(
      Array.from({ length: count }, (_, index) => `session-${index}`),
    );
  });

  it('applies folder hierarchy, assignment, cleanup, and recursive deletion operations', async () => {
    const { runtime } = await createHarness();
    await runtime.initialize();
    let revision = 0;
    const mutate = async (clientMutationId, operation) => {
      const result = await apply(runtime, revision, clientMutationId, operation);
      revision = result.snapshot.revision;
      return result.snapshot;
    };

    await mutate('folder-parent', {
      type: 'folder.create',
      scopeKey: '/workspace//project',
      folder: { id: 'folder-parent', name: ' Parent ', createdAt: 1.4, parentId: null },
    });
    await mutate('folder-child', {
      type: 'folder.create',
      scopeKey: '/workspace/project',
      folder: { id: 'folder-child', name: 'Child', createdAt: 2, parentId: 'folder-parent' },
    });
    let snapshot = await mutate('folder-assign', {
      type: 'folder.assign',
      scopeKey: '/workspace/project',
      folderId: 'folder-child',
      sessionIds: ['session-one', 'session-two'],
    });
    expect(snapshot.sessionFoldersByScope).toEqual({
      '/workspace/project': [
        { id: 'folder-parent', name: 'Parent', sessionIds: [], createdAt: 1, parentId: null },
        { id: 'folder-child', name: 'Child', sessionIds: ['session-one', 'session-two'], createdAt: 2, parentId: 'folder-parent' },
      ],
    });

    snapshot = await mutate('folder-rename', {
      type: 'folder.rename',
      scopeKey: '/workspace/project',
      folderId: 'folder-child',
      name: 'Renamed',
    });
    expect(snapshot.sessionFoldersByScope['/workspace/project'][1].name).toBe('Renamed');

    snapshot = await mutate('folder-unassign', {
      type: 'folder.unassign',
      scopeKey: '/workspace/project',
      sessionIds: ['session-one'],
    });
    expect(snapshot.sessionFoldersByScope['/workspace/project'][1].sessionIds).toEqual(['session-two']);

    snapshot = await mutate('folder-cleanup', {
      type: 'folder.cleanup',
      scopeKey: '/workspace/project',
      existingSessionIds: [],
      pruneEmpty: false,
    });
    expect(snapshot.sessionFoldersByScope['/workspace/project']).toHaveLength(2);
    expect(snapshot.sessionFoldersByScope['/workspace/project'][1].sessionIds).toEqual([]);

    snapshot = await mutate('folder-delete', {
      type: 'folder.delete',
      scopeKey: '/workspace/project',
      folderId: 'folder-parent',
    });
    expect(snapshot.sessionFoldersByScope).toEqual({});
    expect(snapshot.revision).toBe(7);
  });

  it('deduplicates concurrent and restarted retries before checking stale revisions', async () => {
    const { filePath, runtime } = await createHarness();
    await runtime.initialize();
    const request = {
      baseRevision: 0,
      clientMutationId: 'same-mutation',
      operation: { type: 'session.pin', sessionId: 'session-one' },
    };

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => runtime.applyMutation(request)),
    );
    expect(concurrent.filter((result) => result.applied)).toHaveLength(1);
    expect(concurrent.filter((result) => result.deduplicated)).toHaveLength(7);
    expect(concurrent.every((result) => result.mutationRevision === 1)).toBe(true);

    const restarted = createSidebarStateRuntime({
      fsPromises: createFileSystem(),
      path,
      filePath,
      createTempId: () => 'restart',
    });
    const retry = await restarted.applyMutation(request);
    expect(retry).toMatchObject({ applied: false, deduplicated: true, mutationRevision: 1 });
    expect(retry.snapshot).toMatchObject({ revision: 1, pinnedSessionIds: ['session-one'] });

    await expect(restarted.applyMutation({
      ...request,
      operation: { type: 'session.pin', sessionId: 'session-two' },
    })).rejects.toBeInstanceOf(SidebarStateIdempotencyError);
  });

  it('keeps the persisted idempotency ledger bounded', async () => {
    const { filePath, runtime } = await createHarness({ dedupeLimit: 3 });
    await runtime.initialize();

    for (let index = 0; index < 5; index += 1) {
      await apply(runtime, index, `mutation-${index}`, {
        type: 'session.pin',
        sessionId: `session-${index}`,
      });
    }

    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(stored.recentMutations.map((record) => record.clientMutationId)).toEqual([
      'mutation-2',
      'mutation-3',
      'mutation-4',
    ]);
    expect(stored.recentMutations.map((record) => record.revision)).toEqual([3, 4, 5]);
  });

  it('returns a typed conflict with the latest authoritative snapshot', async () => {
    const { runtime } = await createHarness();
    await runtime.initialize();
    await apply(runtime, 0, 'first', { type: 'session.pin', sessionId: 'session-one' });

    let conflict;
    try {
      await apply(runtime, 0, 'stale', { type: 'session.pin', sessionId: 'session-two' });
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(SidebarStateConflictError);
    expect(conflict).toBeInstanceOf(SidebarStateError);
    expect(conflict).toMatchObject({
      code: 'SIDEBAR_STATE_CONFLICT',
      baseRevision: 0,
      actualRevision: 1,
      latestSnapshot: {
        revision: 1,
        pinnedSessionIds: ['session-one'],
      },
    });
    await expect(runtime.readSnapshot()).resolves.toMatchObject({
      revision: 1,
      pinnedSessionIds: ['session-one'],
    });
  });

  it('throws on corrupt storage and never replaces it with empty state', async () => {
    const { filePath, runtime } = await createHarness();
    await runtime.initialize({ legacyProjects: [project('project-a', '/repos/a')] });
    const validRaw = await fs.readFile(filePath, 'utf8');
    const malformed = JSON.parse(validRaw);
    malformed.snapshot.projects[0].sidebarCollapsed = true;
    const malformedRaw = JSON.stringify(malformed);
    await fs.writeFile(filePath, malformedRaw, 'utf8');

    await expect(runtime.readSnapshot()).rejects.toBeInstanceOf(SidebarStateCorruptError);
    await expect(runtime.initialize()).rejects.toBeInstanceOf(SidebarStateCorruptError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(malformedRaw);

    await fs.writeFile(filePath, validRaw, 'utf8');
    await expect(runtime.readSnapshot()).resolves.toMatchObject({
      revision: 0,
      projects: [{ id: 'project-a', path: '/repos/a' }],
    });

    await fs.writeFile(filePath, '{', 'utf8');
    await expect(runtime.readSnapshot()).rejects.toBeInstanceOf(SidebarStateCorruptError);
  });

  it('rolls back a failed atomic replacement and recovers the mutation queue', async () => {
    let failNextRename = false;
    const fsPromises = createFileSystem({
      rename: async (...args) => {
        if (failNextRename) {
          failNextRename = false;
          const error = new Error('injected rename failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(...args);
      },
    });
    const { root, runtime } = await createHarness({ fsPromises });
    await runtime.initialize();

    failNextRename = true;
    await expect(apply(runtime, 0, 'failed-pin', {
      type: 'session.pin',
      sessionId: 'session-failed',
    })).rejects.toBeInstanceOf(SidebarStateWriteError);

    await expect(runtime.readSnapshot()).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      projects: [],
      pinnedSessionIds: [],
      worktreeOrderByProject: {},
      sessionFoldersByScope: {},
    });
    expect((await fs.readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);

    const recovered = await apply(runtime, 0, 'recovered-pin', {
      type: 'session.pin',
      sessionId: 'session-recovered',
    });
    expect(recovered.snapshot).toMatchObject({
      revision: 1,
      pinnedSessionIds: ['session-recovered'],
    });
  });

  it('retries the complete server migration after an atomic initialization failure', async () => {
    let failNextRename = true;
    const fsPromises = createFileSystem({
      rename: async (...args) => {
        if (failNextRename) {
          failNextRename = false;
          const error = new Error('injected initialization rename failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(...args);
      },
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-sidebar-state-server-'));
    temporaryRoots.add(root);
    const filePath = path.join(root, 'sidebar-state.json');
    const sharedLabel = 'x'.repeat(256);
    let settingsReads = 0;
    const runtime = createSidebarStateServerRuntime({
      fsPromises,
      path,
      filePath,
      legacyFoldersFilePath: null,
      readSettingsFromDiskMigratedStrict: async () => {
        settingsReads += 1;
        return {
          projects: [
            project('project-relative', 'relative/path'),
            project('project-a', '/repos/a', { label: `${sharedLabel}suffix` }),
          ],
        };
      },
      broadcastGlobalUiEvent: () => {},
    });

    await expect(runtime.initialize()).rejects.toBeInstanceOf(SidebarStateWriteError);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);

    const migrated = await runtime.initialize();
    expect(migrated.projects).toEqual([{
      id: 'project-a',
      path: '/repos/a',
      label: sharedLabel,
      addedAt: 1,
    }]);
    expect(settingsReads).toBe(2);
    await expect(runtime.initialize()).resolves.toEqual(migrated);
    expect(settingsReads).toBe(2);
    await expect(runtime.readSnapshot()).resolves.toEqual(migrated);
  });

  it('uses a unique exclusive temp file and rename for each persistence', async () => {
    const writes = [];
    const renames = [];
    const fsPromises = createFileSystem({
      writeFile: async (target, content, options) => {
        writes.push({ target, options });
        return fs.writeFile(target, content, options);
      },
      rename: async (source, target) => {
        renames.push({ source, target });
        return fs.rename(source, target);
      },
    });
    const { filePath, runtime } = await createHarness({
      fsPromises,
      createTempId: () => 'fixed-id',
    });
    await runtime.initialize();
    await apply(runtime, 0, 'pin-one', { type: 'session.pin', sessionId: 'session-one' });
    await apply(runtime, 1, 'pin-two', { type: 'session.pin', sessionId: 'session-two' });

    expect(writes).toHaveLength(3);
    expect(new Set(writes.map((write) => write.target)).size).toBe(3);
    expect(writes.every((write) => write.target.startsWith(`${filePath}.tmp-`))).toBe(true);
    expect(writes.every((write) => write.options.flag === 'wx' && write.options.mode === 0o600)).toBe(true);
    expect(renames).toEqual(writes.map((write) => ({ source: write.target, target: filePath })));
  });

  it('normalizes and deduplicates Windows worktree paths stably', async () => {
    const { runtime } = await createHarness();
    const initialized = await runtime.initialize({
      legacyProjects: [project('project-win', 'c:\\Repo\\')],
    });
    expect(initialized.projects[0].path).toBe('C:/Repo');

    const result = await apply(runtime, 0, 'move-windows-worktree', {
      type: 'worktree.move',
      projectId: 'project-win',
      path: 'c:\\Repo\\trees\\two\\',
      toIndex: 0,
      orderedPaths: [
        'C:\\Repo\\trees\\one\\',
        'c:/Repo/trees/two//',
        'C:/Repo/trees/two/',
      ],
    });

    expect(result.snapshot.worktreeOrderByProject).toEqual({
      'project-win': [
        'C:/Repo/trees/two',
        'C:/Repo/trees/one',
      ],
    });
    await expect(runtime.readSnapshot()).resolves.toEqual(result.snapshot);
    expect(normalizeSidebarPath('\\\\server\\share\\folder\\..\\other\\')).toBe('//server/share/other');
  });

  it('preserves project order when a racing metadata update conflicts and retries', async () => {
    const { runtime } = await createHarness();
    await runtime.initialize({
      legacyProjects: [
        project('project-a', '/repos/a'),
        project('project-b', '/repos/b'),
        project('project-c', '/repos/c'),
      ],
    });

    const outcomes = await Promise.allSettled([
      apply(runtime, 0, 'move-c-first', {
        type: 'project.move',
        projectId: 'project-c',
        toIndex: 0,
      }),
      apply(runtime, 0, 'rename-b-race', {
        type: 'project.update',
        projectId: 'project-b',
        patch: { label: 'Renamed B' },
      }),
    ]);

    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    const conflict = outcomes[1].reason;
    expect(conflict).toBeInstanceOf(SidebarStateConflictError);
    expect(conflict.latestSnapshot.projects.map((entry) => entry.id)).toEqual([
      'project-c',
      'project-a',
      'project-b',
    ]);

    const retried = await apply(runtime, conflict.actualRevision, 'rename-b-race', {
      type: 'project.update',
      projectId: 'project-b',
      patch: { label: 'Renamed B' },
    });
    expect(retried.snapshot.projects.map((entry) => entry.id)).toEqual([
      'project-c',
      'project-a',
      'project-b',
    ]);
    expect(retried.snapshot.projects.find((entry) => entry.id === 'project-b').label).toBe('Renamed B');
    expect(retried.snapshot.revision).toBe(2);
  });

  it('keeps top-level migration and new mutation validation strict', async () => {
    const { filePath, runtime } = await createHarness();

    await expect(runtime.initialize({
      legacyProjects: {},
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const initialized = await runtime.initialize({
      legacyProjects: [
        project('project-relative', 'relative/path'),
        project('project-a', '/repos/a'),
      ],
    });
    expect(initialized.projects).toEqual([project('project-a', '/repos/a')]);
    await expect(apply(runtime, 0, 'invalid-session', {
      type: 'session.pin',
      sessionId: 'not a session id',
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(apply(runtime, 0, 'invalid-path', {
      type: 'project.add',
      project: project('project-relative', 'relative/path'),
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(apply(runtime, 0, 'overlong-label', {
      type: 'project.add',
      project: project('project-long-label', '/repos/long-label', { label: 'x'.repeat(257) }),
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(apply(runtime, 0, 'overlong-folder-name', {
      type: 'folder.create',
      scopeKey: '/repos/a',
      folder: { id: 'folder-long-name', name: 'x'.repeat(257), createdAt: 1, parentId: null },
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(apply(runtime, 0, 'duplicate-path', {
      type: 'project.add',
      project: project('project-other-id', '/repos/a/./'),
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(apply(runtime, 0, 'local-field', {
      type: 'project.add',
      project: {
        ...project('project-b', '/repos/b'),
        sidebarCollapsed: true,
      },
    })).rejects.toBeInstanceOf(SidebarStateValidationError);
    await expect(runtime.readSnapshot()).resolves.toMatchObject({
      revision: 0,
      projects: [{ id: 'project-a', path: '/repos/a' }],
      pinnedSessionIds: [],
    });
    expect(() => normalizeSidebarPath('../../relative')).toThrow(SidebarStateValidationError);
  });
});
