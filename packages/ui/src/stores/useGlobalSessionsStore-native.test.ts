import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Session } from "@/lib/opencode/model"

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeSessionList } from '@/lib/api/types';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { flushPendingSessionWrites, persistGlobalSessionSnapshot, persistManagedChatSessions } from '@/sync/persist-cache';
import { useProjectsStore } from './useProjectsStore';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

const DIRECTORY = '/work/project';
const WORKTREE = '/work/linked/claude';

const session = (id: string, directory = DIRECTORY): Session => ({
  id,
  projectID: '',
  directory,
  title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

let openCodeSessions: Session[] = [];
let nativeListing: (directory: string) => Promise<NativeSessionList> = async () => ({
  backends: { claude: { status: 'ok', sessions: [] }, codex: { status: 'ok', sessions: [] } },
});

let chatDirectories: () => Promise<string[]> = async () => [];

const runtimeApis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
  listSessions: (directory) => nativeListing(directory),
  chatDirectories: () => chatDirectories(),
}));
const originalListSessions = opencodeClient.listSessionsPage;
const originalProjects = useProjectsStore.getState().projects;
const originalWorktrees = useSessionUIStore.getState().availableWorktreesByProject;

const nativeList = (claude: Session[] = [], codex: Session[] = []): NativeSessionList => ({
  backends: {
    claude: { status: 'ok', sessions: claude },
    codex: { status: 'ok', sessions: codex },
    deepseek: { status: 'ok', sessions: [] },
  },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('global sessions with native CLI sessions', () => {
  beforeEach(() => {
    flushPendingSessionWrites();
    persistGlobalSessionSnapshot([]);
    persistManagedChatSessions([]);
    flushPendingSessionWrites();
    openCodeSessions = [];
    nativeListing = async () => nativeList();
    chatDirectories = async () => [];
    useProjectsStore.setState({ projects: [] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
    opencodeClient.listSessionsPage = async () => ({ sessions: openCodeSessions, cursor: {} });
    registerRuntimeAPIs(runtimeApis);
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    opencodeClient.listSessionsPage = originalListSessions;
    useProjectsStore.setState({ projects: originalProjects });
    useSessionUIStore.setState({ availableWorktreesByProject: originalWorktrees });
    registerRuntimeAPIs(null);
  });

  test('lists native sessions next to OpenCode sessions', async () => {
    openCodeSessions = [session('ses_opencode')];
    useGlobalSessionsStore.getState().applySnapshot([session('ncl_old')], []);
    nativeListing = async () => ({
      backends: { claude: { status: 'ok', sessions: [session('ncl_new')] }, codex: { status: 'ok', sessions: [session('ncx_thread')] } },
    });

    await useGlobalSessionsStore.getState().loadSessions();

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id).sort()).toEqual(['ncl_new', 'ncx_thread', 'ses_opencode']);
  });

  test('discovers native sessions in known worktrees without a cached session', async () => {
    useProjectsStore.setState({ projects: [{ id: 'project', path: DIRECTORY, addedAt: 1 }] });
    const worktree = { path: WORKTREE, projectDirectory: DIRECTORY, branch: 'claude', label: 'claude' };
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([[DIRECTORY, [worktree, worktree]]]) });
    const listed: string[] = [];
    const target = { ...session('ncl_worktree', WORKTREE), metadata: { openchamber: { work: { state: 'open' } } } };
    nativeListing = async (directory) => {
      listed.push(directory);
      return nativeList(directory === WORKTREE ? [target] : []);
    };

    await useGlobalSessionsStore.getState().loadSessions();

    expect(listed.sort()).toEqual([WORKTREE, DIRECTORY].sort());
    const loaded = useGlobalSessionsStore.getState().entityById.get(target.id);
    expect(loaded).toEqual(target);
    expect(isSessionInWork(loaded)).toBe(true);
  });

  test('refreshes only native sessions when worktree discovery finishes after the global load', async () => {
    await useGlobalSessionsStore.getState().loadSessions();
    const openCode = session('ses_opencode', WORKTREE);
    const elsewhere = session('ncl_elsewhere', '/other');
    const archived = { ...session('ncl_archived', WORKTREE), time: { created: 1, updated: 1, archived: 5 } };
    useGlobalSessionsStore.getState().upsertSessions([openCode, elsewhere]);
    const listed: string[] = [];
    nativeListing = async (directory) => {
      listed.push(directory);
      return nativeList([session('ncl_worktree', directory), archived]);
    };
    opencodeClient.listSessionsPage = async () => { throw new Error('Native discovery must not read OpenCode'); };

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE, `${WORKTREE}/`]);

    const state = useGlobalSessionsStore.getState();
    expect(listed).toEqual([WORKTREE]);
    expect(state.activeSessions.map((item) => item.id).sort()).toEqual(['ncl_elsewhere', 'ncl_worktree', 'ses_opencode']);
    expect(state.archivedSessions).toEqual([archived]);
    expect(state.entityById.get(openCode.id)).toBe(openCode);
    expect(state.entityById.get(elsewhere.id)).toBe(elsewhere);
  });

  test('native discovery cannot establish complete global coverage', async () => {
    nativeListing = async (directory) => nativeList([session('ncl_worktree', directory)]);

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);

    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(false);
    expect(useGlobalSessionsStore.getState().status).toBe('idle');
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['ncl_worktree']);
  });

  test('a failed backend keeps its sessions while an empty successful backend removes its roots and children', async () => {
    const claude = session('ncl_keep', WORKTREE);
    const codex = session('ncx_remove', WORKTREE);
    const child = { ...session('ncx_child', WORKTREE), parentID: codex.id };
    const elsewhere = session('ncl_elsewhere', '/other');
    useGlobalSessionsStore.getState().applySnapshot([claude, codex, child, elsewhere], []);
    nativeListing = async () => ({ backends: {
      claude: { status: 'error', message: 'unavailable' },
      codex: { status: 'ok', sessions: [] },
    } });

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id).sort()).toEqual(['ncl_elsewhere', 'ncl_keep']);
    expect(useGlobalSessionsStore.getState().entityById.get(claude.id)).toBe(claude);
  });

  test('one failed directory preserves its sessions without blocking another directory', async () => {
    const existing = session('ncl_keep', WORKTREE);
    useGlobalSessionsStore.getState().applySnapshot([existing], []);
    nativeListing = async (directory) => {
      if (directory === WORKTREE) throw new Error('unreachable');
      return nativeList([session('ncl_other', directory)]);
    };

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE, '/other']);

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id).sort()).toEqual(['ncl_keep', 'ncl_other']);
    expect(useGlobalSessionsStore.getState().entityById.get(existing.id)).toBe(existing);
  });

  test('keeps unlinked children outside the successful directory and backend partition', async () => {
    const failedChild = { ...session('ncl_pending_child', WORKTREE), parentID: 'ncl_parent_not_loaded' };
    const elsewhere = { ...session('ncx_pending_child', '/other'), parentID: 'ncx_parent_not_loaded' };
    const removed = session('ncx_remove', WORKTREE);
    useGlobalSessionsStore.getState().applySnapshot([failedChild, elsewhere, removed], []);
    nativeListing = async () => ({ backends: {
      claude: { status: 'error', message: 'unavailable' },
      codex: { status: 'ok', sessions: [] },
    } });

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);

    expect(useGlobalSessionsStore.getState().entityById.get(failedChild.id)).toBe(failedChild);
    expect(useGlobalSessionsStore.getState().entityById.get(elsewhere.id)).toBe(elsewhere);
    expect(useGlobalSessionsStore.getState().entityById.has(removed.id)).toBe(false);
  });

  test('a worktree discovered during an older global load survives its completion', async () => {
    const page = deferred<Session[]>();
    const started = deferred<void>();
    opencodeClient.listSessionsPage = async () => {
      started.resolve();
      return { sessions: await page.promise, cursor: {} };
    };
    const loading = useGlobalSessionsStore.getState().loadSessions();
    await started.promise;
    nativeListing = async (directory) => nativeList([session('ncl_discovered', directory)]);

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);
    page.resolve([]);
    await loading;

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['ncl_discovered']);
  });

  test('a successful empty native refresh prevents an older global load from resurrecting a session', async () => {
    const existing = session('ncl_deleted', WORKTREE);
    useGlobalSessionsStore.getState().applySnapshot([existing], []);
    const page = deferred<Session[]>();
    const listed = deferred<void>();
    opencodeClient.listSessionsPage = async () => ({ sessions: await page.promise, cursor: {} });
    nativeListing = async () => {
      listed.resolve();
      return nativeList([existing]);
    };
    const loading = useGlobalSessionsStore.getState().loadSessions();
    await listed.promise;
    nativeListing = async () => nativeList();

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);
    page.resolve([]);
    await loading;

    expect(useGlobalSessionsStore.getState().entityById.has(existing.id)).toBe(false);
  });

  test('keeps newer Done, archive, delete, and create mutations while a native read is in flight', async () => {
    const inWork = { ...session('ncl_work', WORKTREE), metadata: { openchamber: { work: { state: 'open' } } } };
    const archived = session('ncl_archive', WORKTREE);
    const removed = session('ncl_delete', WORKTREE);
    useGlobalSessionsStore.getState().applySnapshot([inWork, archived, removed], []);
    const pending = deferred<NativeSessionList>();
    const started = deferred<void>();
    nativeListing = async () => { started.resolve(); return pending.promise; };
    const refreshing = useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);
    await started.promise;
    useGlobalSessionsStore.getState().upsertSession({ ...inWork, metadata: { openchamber: { work: { state: 'done' } } } });
    useGlobalSessionsStore.getState().archiveSessions([archived.id], 10);
    useGlobalSessionsStore.getState().removeSessions([removed.id]);
    useGlobalSessionsStore.getState().upsertSession(session('ncl_created', WORKTREE));
    pending.resolve(nativeList([inWork, archived, removed]));
    await refreshing;

    const state = useGlobalSessionsStore.getState();
    expect(isSessionInWork(state.entityById.get(inWork.id))).toBe(false);
    expect(state.archivedSessions.map((item) => item.id)).toEqual([archived.id]);
    expect(state.entityById.has(removed.id)).toBe(false);
    expect(state.entityById.has('ncl_created')).toBe(true);
  });

  test('rejects a native refresh from the runtime that was left', async () => {
    const pending = deferred<NativeSessionList>();
    const started = deferred<void>();
    nativeListing = async () => { started.resolve(); return pending.promise; };
    const refreshing = useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);
    await started.promise;
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    pending.resolve(nativeList([session('ncl_previous_runtime', WORKTREE)]));
    await refreshing;

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(false);
  });

  test('keeps children of a parent updated during a successful empty read', async () => {
    const parent = session('ncl_parent', WORKTREE);
    const child = { ...session('ncl_child', WORKTREE), parentID: parent.id };
    useGlobalSessionsStore.getState().applySnapshot([parent, child], []);
    const pending = deferred<NativeSessionList>();
    const started = deferred<void>();
    nativeListing = async () => { started.resolve(); return pending.promise; };
    const refreshing = useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);
    await started.promise;
    useGlobalSessionsStore.getState().upsertSession({ ...parent, title: 'Newer parent' });
    pending.resolve(nativeList());
    await refreshing;

    expect(useGlobalSessionsStore.getState().entityById.get(parent.id)?.title).toBe('Newer parent');
    expect(useGlobalSessionsStore.getState().entityById.get(child.id)).toBe(child);
  });

  test('bounds native discovery concurrency across a deduplicated directory list', async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    let active = 0;
    let peak = 0;
    const listed: string[] = [];
    nativeListing = async (directory) => {
      listed.push(directory);
      active += 1;
      peak = Math.max(peak, active);
      if (active === 4) started.resolve();
      await gate.promise;
      active -= 1;
      return nativeList();
    };
    const directories = Array.from({ length: 7 }, (_, index) => `/work/tree-${index}`);
    const refreshing = useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([...directories, ...directories]);
    await started.promise;
    gate.resolve();
    await refreshing;

    expect(peak).toBe(4);
    expect(listed.sort()).toEqual(directories.sort());
  });

  test('skips native discovery on unsupported runtimes', async () => {
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ supported: false })));

    await useGlobalSessionsStore.getState().refreshNativeSessionsForDirectories([WORKTREE]);

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  });

  test('lists the native sessions of managed chats this client never held', async () => {
    const chat = '/home/user/.config/openchamber/chats/2026-09-29/session-a';
    chatDirectories = async () => [chat];
    nativeListing = async (directory) => ({
      backends: {
        claude: { status: 'ok', sessions: directory === chat ? [session('ncl_chat', chat)] : [] },
        codex: { status: 'ok', sessions: [] },
      },
    });

    await useGlobalSessionsStore.getState().loadSessions();

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toContain('ncl_chat');
  });

  test('a failed read of the chat directories keeps the chats already held', async () => {
    const chat = '/home/user/.config/openchamber/chats/2026-09-29/session-a';
    useGlobalSessionsStore.getState().applySnapshot([session('ncl_chat', chat)], []);
    chatDirectories = async () => {
      throw new Error('the server is unreachable');
    };
    const listed: string[] = [];
    nativeListing = async (directory) => {
      listed.push(directory);
      return {
        backends: {
          claude: { status: 'ok', sessions: directory === chat ? [session('ncl_chat', chat)] : [] },
          codex: { status: 'ok', sessions: [] },
        },
      };
    };

    await useGlobalSessionsStore.getState().loadSessions();

    expect(listed).toContain(chat);
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toContain('ncl_chat');
  });

  test('keeps the sessions of a native backend that failed', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('ncl_old'), session('ncx_old')], []);
    nativeListing = async () => ({
      backends: { claude: { status: 'error', message: 'unreadable' }, codex: { status: 'ok', sessions: [] } },
    });

    await useGlobalSessionsStore.getState().loadSessions();

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['ncl_old']);
  });

  test('refreshes the native sessions of the requested directories only', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('ncl_here'), session('ncl_elsewhere', '/other')], []);
    const listed: string[] = [];
    nativeListing = async (directory) => {
      listed.push(directory);
      return { backends: { claude: { status: 'ok', sessions: [session('ncl_fresh')] }, codex: { status: 'ok', sessions: [] } } };
    };

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories([DIRECTORY]);

    expect(listed).toEqual([DIRECTORY]);
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id).sort()).toEqual(['ncl_elsewhere', 'ncl_fresh']);
  });
});

const originalHomeInfo = opencodeClient.getFilesystemHomeInfo;
opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' });
await ensureChatsRootDirectory();
opencodeClient.getFilesystemHomeInfo = originalHomeInfo;
