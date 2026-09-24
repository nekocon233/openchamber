import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeSessionList } from '@/lib/api/types';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

const DIRECTORY = '/work/project';

const session = (id: string, directory = DIRECTORY): Session => ({
  id,
  slug: id,
  projectID: '',
  directory,
  title: id,
  version: 'test',
  time: { created: 1, updated: 1 },
});

let openCodeSessions: Session[] = [];
let nativeListing: (directory: string) => Promise<NativeSessionList> = async () => ({
  backends: { claude: { status: 'ok', sessions: [] }, codex: { status: 'ok', sessions: [] } },
});

// OpenCode answers its one-page session listing with the sessions the test sets.
const sdk = createOpencodeClient({
  baseUrl: 'http://opencode.test',
  fetch: async () => Response.json(openCodeSessions),
});

const runtimeApis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
  listSessions: (directory) => nativeListing(directory),
}));
const originalGetSdkClient = opencodeClient.getSdkClient;

describe('global sessions with native CLI sessions', () => {
  beforeEach(() => {
    openCodeSessions = [];
    opencodeClient.getSdkClient = () => sdk;
    registerRuntimeAPIs(runtimeApis);
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    opencodeClient.getSdkClient = originalGetSdkClient;
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
