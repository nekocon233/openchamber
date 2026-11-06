import { opencodeClient } from '@/lib/opencode/client';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Session } from "@/lib/opencode/model"

import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativeCompactRequest, NativeSessionCreate, NativeSessionPatch, NativeSessionSelection } from "@/lib/api/types"
import type { NativeAgentConfigurationWrite } from '@/lib/native-agents/combinations';
import { buildNativeProvider } from '@/lib/native-agents/providers';
import { captureAgentCombinationDraft, readAgentCombinationDraft, useAgentCombinationDrafts } from '@/lib/native-agents/combination-drafts';
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from "@/lib/native-agents/test-utils/runtime"
import { NATIVE_BACKENDS, nativeProviderIdOf, type NativeBackend } from "@/lib/native-agents/ids"
import { materializeOpenDraftSession, useSessionUIStore } from './session-ui-store';
import { useConfigStore } from "@/stores/useConfigStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { ChildStoreManager } from "./child-store"
import {
  archiveSession,
  archiveSessions,
  compactNativeSession,
  createNativeSession,
  deleteSession,
  patchSessionMetadata,
  configureNativeAgents,
  selectNativeConversationModel,
  setActionRefs,
  unarchiveSession,
  updateSessionTitle,
} from "./session-actions"

const originalGetSession = opencodeClient.getSession;
const DIRECTORY = "/work/project"
const SESSION = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const OTHER = "ncx_01a0d2a6-b55b-7162-a837-c62053537e00"

const nativeSession = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  projectID: "",
  directory: DIRECTORY,
  title: "Work",
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  ...patch,
})

let updates: Array<{ sessionId: string; directory: string; patch: NativeSessionPatch }> = []
let deletes: string[] = []
let compactions: Array<{ sessionId: string; request: NativeCompactRequest }> = []
let createRequests: NativeSessionCreate[] = []
let capabilityReads = 0
let unifiedBackends: NativeBackend[] | undefined = undefined
let unifiedSessions = true
let deleteFailure: NativeAgentsRequestError | null = null
let openChamberRequests: string[] = []
let openCodeRequests: string[] = []
let childStores = new ChildStoreManager()
// Records the server answers with, where a test needs more than a plain session.
let storedSessions = new Map<string, Session>()

const store = () => {
  const child = childStores.getChild(DIRECTORY)
  if (!child) throw new Error("the test directory has no child store")
  return child
}

beforeEach(() => {
  updates = []
  deletes = []
  compactions = []
  createRequests = []
  capabilityReads = 0
  unifiedBackends = undefined
  unifiedSessions = true
  deleteFailure = null
  openChamberRequests = []
  openCodeRequests = []
  storedSessions = new Map()
  childStores = new ChildStoreManager()
  childStores.ensureChild(DIRECTORY, { bootstrap: false })
  store().setState({ session: [nativeSession(SESSION), nativeSession(OTHER)] })
  useGlobalSessionsStore.getState().applySnapshot([nativeSession(SESSION), nativeSession(OTHER)], [])
  // Sidebar structure kept in this client, as a deletion cleans it up.
  const localSidebarState = { supported: false, load: async () => null, mutate: async () => null }
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
    getSession: async (sessionId) => storedSessions.get(sessionId) ?? nativeSession(sessionId),
    updateSession: async (sessionId, directory, patch) => {
      updates.push({ sessionId, directory, patch })
      const archived = patch.archived === true ? { archived: 50 } : {}
      return nativeSession(sessionId, { title: patch.title ?? "Work", time: { created: 1, updated: 3, ...archived } })
    },
    deleteSession: async (sessionId) => {
      deletes.push(sessionId)
      if (deleteFailure) throw deleteFailure
    },
    compact: async (sessionId, request) => {
      compactions.push({ sessionId, request })
    },
    capabilities: async () => {
      capabilityReads += 1
      return {
        supported: true,
        unifiedSessions,
        unifiedBackends,
        backends: { claude: { cli: true }, codex: { cli: true } },
        registry: { reset: false },
      }
    },
    createSession: async (input) => {
      createRequests.push(input)
      return nativeSession(input.backend === 'antigravity' ? 'nag_created' : 'ncv_created')
    },
  }), { sidebarState: localSidebarState }))
  // Native sessions must never reach OpenCode or its batch routes; any request is recorded and refused.
  opencodeClient.getSession = async (sessionId) => {
    openCodeRequests.push(sessionId)
    throw new Error('OpenCode must not be asked about a native session')
  }
  setActionRefs(childStores, () => DIRECTORY)
  useConfigStore.setState({ isConnected: true })
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    openChamberRequests.push(String(input))
    return Response.json({ error: "not expected" }, { status: 500 })
  }, { preconnect: () => undefined })
})

afterEach(() => {
  opencodeClient.getSession = originalGetSession;
  registerRuntimeAPIs(null)
  childStores.disposeAll()
  useAgentCombinationDrafts.setState({ drafts: new Map() });
})

describe('native combination identity', () => {
  const id = 'ncv_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
  const selection: NativeSessionSelection = { model: { providerID: 'claude-native', modelID: 'opus' }, agent: 'plan', variant: 'high' };
  const configuration: NativeAgentConfigurationWrite = {
    combination: { id: '11111111-1111-4111-8111-111111111111', name: 'Mixed team' },
    subagent: { model: { providerID: 'codex-native', modelID: 'gpt-test' } },
    execution: { model: { providerID: 'deepseek-native', modelID: 'deepseek-test' } },
  };
  const sessionOf = (agents: NativeAgentConfigurationWrite, revision: number) => nativeSession(id, {
    model: { providerID: selection.model.providerID, id: selection.model.modelID, variant: selection.variant }, agent: 'plan',
    metadata: { openchamber: { native: { kind: 'unified', backend: 'claude', revision, recordRevision: revision,
      historyRevision: 0, sourceSessionID: SESSION, switchReady: true, preparing: false, agents: { ...agents, revision } } } },
  });

  test('explicitly choosing the same main model clears only combination identity', async () => {
    let current = sessionOf(configuration, 3);
    const writes: NativeAgentConfigurationWrite[] = [];
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
      getSession: async () => current,
      configureAgents: async (_id, _directory, next, expected, main, selectionRevision) => {
        expect(expected).toBe(3);
        expect(selectionRevision).toBe(3);
        expect(main).toEqual(selection);
        writes.push(next); current = sessionOf(next, 4); return current;
      },
    })));
    expect(await selectNativeConversationModel(id, DIRECTORY, selection)).toBe(current);
    expect(writes).toHaveLength(0);
    const updated = await selectNativeConversationModel(id, DIRECTORY, selection, true);
    expect(writes).toEqual([{ subagent: configuration.subagent, execution: configuration.execution }]);
    expect(updated.metadata).toEqual(sessionOf(writes[0], 4).metadata);
    await selectNativeConversationModel(id, DIRECTORY, selection, true);
    expect(writes).toHaveLength(1);
  });

  test('reads the latest roles after a queued combination write before clearing its name', async () => {
    let current = sessionOf({ subagent: null, execution: null }, 0);
    const writes: NativeAgentConfigurationWrite[] = [];
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
      getSession: async () => current,
      configureAgents: async (_id, _directory, next, expected) => {
        expect(expected).toBe(writes.length);
        writes.push(next); current = sessionOf(next, writes.length); return current;
      },
    })));
    const applied = configureNativeAgents(id, DIRECTORY, configuration, selection);
    const individual = selectNativeConversationModel(id, DIRECTORY, selection, true);
    await Promise.all([applied, individual]);
    expect(writes).toEqual([configuration, { subagent: configuration.subagent, execution: configuration.execution }]);
  });
});

describe('native session creation', () => {
  test('a deleted default combination stops before materializing a draft', async () => {
    const configBefore = useConfigStore.getState();
    const sessionBefore = useSessionUIStore.getState();
    try {
      useConfigStore.setState({ selectionSource: 'auto', currentDefaultAgentCombinationId: '11111111-1111-4111-8111-111111111111', nativeAgentCombinations: [] });
      useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...sessionBefore.newSessionDraft, open: true, draftId: 885, target: 'chat' } });
      await expect(materializeOpenDraftSession({ providerID: 'claude-native', modelID: 'opus' })).rejects.toThrow('Default combination is unavailable');
      expect(createRequests).toEqual([]);
      expect(openChamberRequests).toEqual([]);
      expect(openCodeRequests).toEqual([]);
    } finally { useConfigStore.setState(configBefore); useSessionUIStore.setState(sessionBefore); }
  });

  test('carries a directory-free chat choice into creation and consumes only the captured draft', async () => {
    const target = { draftId: 81 };
    const configuration: NativeAgentConfigurationWrite = {
      combination: { id: '11111111-1111-4111-8111-111111111111', name: 'Chat team' },
      subagent: { model: { providerID: 'codex-native', modelID: 'gpt-test' } },
      execution: { model: { providerID: 'deepseek-native', modelID: 'deepseek-test' } },
    };
    useAgentCombinationDrafts.getState().set(target, { ...configuration, inheritedMain: { model: { providerID: 'claude-native', modelID: 'opus' }, variant: 'high' } });
    useAgentCombinationDrafts.getState().set({ draftId: 82 }, { subagent: null, execution: null });
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
      capabilities: async () => ({ supported: true, unifiedSessions: true, agentCombinations: true,
        unifiedBackends: [...NATIVE_BACKENDS], backends: { claude: { cli: true }, codex: { cli: true } }, registry: { reset: false } }),
      createSession: async (input) => { createRequests.push(input); return nativeSession('ncv_created'); },
    })));
    await createNativeSession('claude', '/managed/chat-just-created', undefined, {
      model: { providerID: 'claude-native', id: 'opus', variant: 'high' }, agent: 'plan', combinationDraft: captureAgentCombinationDraft(target),
    });
    expect(createRequests[0]).toMatchObject({ directory: '/managed/chat-just-created', configuration });
    expect(createRequests[0].kind === 'unified' && createRequests[0].configuration).not.toHaveProperty('inheritedMain');
    expect(readAgentCombinationDraft(target)).toBeUndefined();
    expect(readAgentCombinationDraft({ draftId: 82 })).toEqual({ subagent: null, execution: null });
  });
  test('an unavailable captured main effort stops before creating a session', async () => {
    const configBefore = useConfigStore.getState();
    const sessionBefore = useSessionUIStore.getState();
    const main = { model: { providerID: 'claude-native' as const, modelID: 'opus' }, variant: 'ultra' };
    const entry = { id: '11111111-1111-4111-8111-111111111111', name: 'Stale effort', main, subagent: null, execution: main };
    try {
      useConfigStore.setState({ selectionSource: 'auto', currentDefaultAgentCombinationId: entry.id, nativeAgentCombinations: [entry],
        currentVariantSelection: { override: undefined, inherited: 'ultra' }, providers: [buildNativeProvider('claude', [{ id: 'opus', name: 'Opus', efforts: ['max'], fast: false, defaultEffort: null, contextWindow: 64000, outputLimit: 8192, input: { image: false, pdf: false } }])] });
      useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...sessionBefore.newSessionDraft, open: true, draftId: 886, target: 'chat' } });
      useAgentCombinationDrafts.getState().set({ draftId: 886 }, { combination: { id: entry.id, name: entry.name }, inheritedMain: main, subagent: null, execution: main });
      await expect(materializeOpenDraftSession({ providerID: 'claude-native', modelID: 'opus' })).rejects.toThrow('Default combination is unavailable');
      expect(createRequests).toEqual([]);
    } finally { useConfigStore.setState(configBefore); useSessionUIStore.setState(sessionBefore); }
  });

  test('an older server keeps Antigravity on a standalone session', async () => {
    await createNativeSession('antigravity', DIRECTORY, undefined, {
      model: { providerID: 'antigravity-native', id: 'gemini-3-pro' }, agent: 'plan',
    })
    expect(capabilityReads).toBe(1)
    expect(createRequests).toEqual([{ backend: 'antigravity', directory: DIRECTORY }])
  })

  for (const backend of NATIVE_BACKENDS) test(`creates a unified ${backend} draft when the server supports it`, async () => {
    unifiedBackends = NATIVE_BACKENDS
    await createNativeSession(backend, DIRECTORY, 'Unified work', {
      model: { providerID: nativeProviderIdOf(backend), id: 'selected-model', variant: 'high' }, agent: 'plan',
    })
    expect(createRequests).toEqual([{
      kind: 'unified', backend, directory: DIRECTORY, title: 'Unified work',
      selection: { model: { providerID: nativeProviderIdOf(backend), modelID: 'selected-model' }, agent: 'plan', variant: 'high' },
    }])
  })

  test('keeps utility creation and servers without unified sessions standalone', async () => {
    await createNativeSession('codex', DIRECTORY, undefined)
    expect(capabilityReads).toBe(0)
    unifiedSessions = false
    unifiedBackends = NATIVE_BACKENDS
    await createNativeSession('antigravity', DIRECTORY, undefined, {
      model: { providerID: 'antigravity-native', id: 'gemini-test' }, agent: 'build',
    })
    expect(createRequests).toEqual([{ backend: 'codex', directory: DIRECTORY }, { backend: 'antigravity', directory: DIRECTORY }])
  })

  test('other native providers keep the unified creation path', async () => {
    await createNativeSession('codex', DIRECTORY, 'Work', {
      model: { providerID: 'codex-native', id: 'gpt-5.5', variant: 'high' }, agent: 'plan',
    })
    expect(capabilityReads).toBe(1)
    expect(createRequests).toEqual([{
      kind: 'unified', backend: 'codex', directory: DIRECTORY, title: 'Work',
      selection: { model: { providerID: 'codex-native', modelID: 'gpt-5.5' }, agent: 'plan', variant: 'high' },
    }])
  })
})

describe("native session management actions", () => {
  test("rename through the server and keep the record it answers with", async () => {
    await updateSessionTitle(SESSION, "Renamed")
    expect(updates).toEqual([{ sessionId: SESSION, directory: DIRECTORY, patch: { title: "Renamed" } }])
    expect(store().getState().session.find((session) => session.id === SESSION)?.title).toBe("Renamed")
    expect(openCodeRequests).toEqual([])
  })

  test("archive and restore through the server", async () => {
    expect(await archiveSession(SESSION)).toBe(true)
    expect(updates.at(-1)).toEqual({ sessionId: SESSION, directory: DIRECTORY, patch: { archived: true } })
    expect(store().getState().session.map((session) => session.id)).toEqual([OTHER])
    expect(useGlobalSessionsStore.getState().archivedSessions.map((session) => session.id)).toEqual([SESSION])

    expect(await unarchiveSession(SESSION)).toBe(true)
    expect(updates.at(-1)).toEqual({ sessionId: SESSION, directory: DIRECTORY, patch: { archived: false } })
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("archive several native sessions one by one instead of through the OpenCode batch route", async () => {
    expect(await archiveSessions([SESSION, OTHER])).toEqual({ archivedIds: [SESSION, OTHER], failedIds: [] })
    expect(updates.map((update) => update.sessionId)).toEqual([SESSION, OTHER])
    expect(openChamberRequests).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("patch OpenChamber metadata through the server, which keeps it for a native session", async () => {
    const updated = await patchSessionMetadata(SESSION, DIRECTORY, (metadata) => ({ ...metadata, openchamber: { btwSessionID: "ncl_fork" } }))
    expect(updates).toEqual([{ sessionId: SESSION, directory: DIRECTORY, patch: { metadata: { openchamber: { btwSessionID: "ncl_fork" } } } }])
    expect(updated.id).toBe(SESSION)
    expect(openCodeRequests).toEqual([])
  })

  test("compact through the server on the selected model, with the agent the CLI knows", async () => {
    await compactNativeSession(SESSION, { providerID: "claude-native", modelID: "opus", variant: "high", agent: "review", instructions: "keep the plan" })
    await compactNativeSession(SESSION, { providerID: "claude-native", modelID: "opus", variant: null, agent: "plan" })
    expect(compactions).toEqual([
      { sessionId: SESSION, request: { directory: DIRECTORY, model: { providerID: "claude-native", modelID: "opus" }, variant: "high", agent: "build", instructions: "keep the plan" } },
      { sessionId: SESSION, request: { directory: DIRECTORY, model: { providerID: "claude-native", modelID: "opus" }, agent: "plan" } },
    ])
    expect(openCodeRequests).toEqual([])
  })

  test("unlink the parent before deleting a btw fork, whose link the server keeps", async () => {
    storedSessions.set(OTHER, nativeSession(OTHER, { metadata: { openchamber: { kind: "btw", originalSessionID: SESSION } } }))
    storedSessions.set(SESSION, nativeSession(SESSION, { metadata: { openchamber: { btwSessionID: OTHER } } }))

    expect(await deleteSession(OTHER)).toBe(true)

    expect(updates).toEqual([{ sessionId: SESSION, directory: DIRECTORY, patch: { metadata: {} } }])
    expect(deletes).toEqual([OTHER])
    expect(openCodeRequests).toEqual([])
  })

  test("delete through the server, and take a session the server no longer has as deleted", async () => {
    expect(await deleteSession(SESSION)).toBe(true)
    expect(deletes).toEqual([SESSION])
    expect(store().getState().session.map((session) => session.id)).toEqual([OTHER])

    deleteFailure = new NativeAgentsRequestError("Native session not found", 404, "NATIVE_SESSION_NOT_FOUND")
    expect(await deleteSession(OTHER)).toBe(true)
    expect(store().getState().session).toEqual([])

    deleteFailure = new NativeAgentsRequestError("Codex keeps this thread while its forks still use it", 409, "NATIVE_DELETE_FORK_SOURCE")
    store().setState({ session: [nativeSession(OTHER)] })
    expect(await deleteSession(OTHER)).toBe(false)
    expect(store().getState().session.map((session) => session.id)).toEqual([OTHER])
    expect(openCodeRequests).toEqual([])
  })
})
