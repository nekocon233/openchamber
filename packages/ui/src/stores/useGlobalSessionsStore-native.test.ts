import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Session } from "@/lib/opencode/model"

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeSessionList } from '@/lib/api/types';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

const DIRECTORY = '/work/project';

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

const runtimeApis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
  listSessions: (directory) => nativeListing(directory),
}));
const originalListSessions = opencodeClient.listSessionsPage;

describe('global sessions with native CLI sessions', () => {
  beforeEach(() => {
    openCodeSessions = [];
    opencodeClient.listSessionsPage = async () => ({ sessions: openCodeSessions, cursor: {} });
    registerRuntimeAPIs(runtimeApis);
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    opencodeClient.listSessionsPage = originalListSessions;
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
