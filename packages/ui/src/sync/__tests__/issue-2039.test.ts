import { beforeEach, describe, expect, mock, test } from "bun:test"
import { togglePermissionAutoAccept } from "../../components/chat/permissionAutoAccept"

const storage = new Map<string, string>()
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null; metadata?: unknown }> = []
const permissionAutoAcceptCalls: Array<[string, boolean]> = []
const optimisticSendCalls: unknown[] = []
let permissionAutoAcceptShouldFail = false

const getMockCalls = (fn: unknown): unknown[][] => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])

mock.module("zustand", () => ({
  create: () => (initializer: (set: (patch: unknown | ((state: unknown) => unknown)) => void, get: () => unknown) => Record<string, unknown>) => {
    let state: Record<string, unknown>
    const get = () => state
    const set = (patch: unknown | ((current: Record<string, unknown>) => unknown)) => {
      const next = typeof patch === "function" ? patch(state) : patch
      state = next && typeof next === "object" ? { ...state, ...(next as Record<string, unknown>) } : state
    }

    state = initializer(set, get)

    const store = ((selector?: (current: Record<string, unknown>) => unknown) => (
      typeof selector === "function" ? selector(state) : state
    )) as unknown as {
      getState: () => Record<string, unknown>
      setState: (patch: unknown | ((current: Record<string, unknown>) => unknown)) => void
      subscribe: () => () => void
    }

    store.getState = () => state
    store.setState = (patch) => set(patch)
    store.subscribe = () => () => undefined

    return store
  },
}))

const deferredStorage: Storage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
  clear: () => {
    storage.clear()
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size
  },
}

mock.module("@/stores/utils/safeStorage", () => ({
  getDeferredSafeStorage: () => deferredStorage,
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => null,
    setDirectory: mock(() => undefined),
  },
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock(async () => new Response(null, { status: 204 })),
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      setSessionAutoAccept: mock(async (sessionId: string, enabled: boolean) => {
        permissionAutoAcceptCalls.push([sessionId, enabled])
        if (permissionAutoAcceptShouldFail) throw new Error("policy unavailable")
      }),
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName: "agent-default",
      agents: [],
      activateDirectory: mock(async () => undefined),
      applyDefaultModelAgentSelection: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [],
      activeProjectId: null,
      getActiveProject: () => null,
    }),
  },
}))

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: null,
      setDirectory: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useUIStore", () => ({
  useUIStore: {
    getState: () => ({
      sessionGoalDefaultBudgetEnabled: false,
      sessionGoalDefaultBudget: 0,
    }),
  },
}))

mock.module("@/stores/useSessionGoalArmStore", () => ({
  useSessionGoalArmStore: {
    getState: () => ({
      consume: () => ({ armed: false, objectiveOverride: null }),
      setArmed: () => undefined,
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
    }),
  },
  resolveGlobalSessionDirectory: () => null,
}))

mock.module("@/stores/useSessionFoldersStore", () => ({
  useSessionFoldersStore: {
    getState: () => ({
      addSessionToFolder: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useCommandsStore", () => ({
  useCommandsStore: {
    getState: () => ({
      commands: [],
    }),
  },
}))

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [],
    }),
  },
}))

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("../selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => undefined,
      saveSessionAgentSelection: () => undefined,
      saveAgentModelForSession: () => undefined,
      saveAgentModelVariantForSession: () => undefined,
      getSessionAgentSelection: () => null,
      getSessionModelSelection: () => null,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: () => "",
  getRuntimeEndpointGeneration: () => 0,
  getRuntimeKey: () => "test-runtime",
  initializeRuntimeEndpoint: () => undefined,
  RuntimeContextChangedError: class RuntimeContextChangedError extends Error {},
  subscribeRuntimeEndpointChanged: () => () => undefined,
  switchRuntimeEndpoint: () => undefined,
}))

mock.module("@/lib/userSendAnimation", () => ({
  markPendingUserSendAnimation: () => undefined,
}))

mock.module("../sync-context", () => ({
  setActiveSession: () => undefined,
}))

mock.module("../notification-store", () => ({
  markSessionViewed: () => undefined,
}))

mock.module("../session-navigation", () => ({
  clearPersistedSessionNavigation: () => undefined,
  persistSessionNavigation: () => undefined,
  readPersistedSessionNavigation: () => null,
  setSessionOpener: () => undefined,
}))

mock.module("../session-worktree-contract", () => ({
  getAttachedSessionDirectory: () => null,
}))

mock.module("../session-worktree-store", () => ({
  useSessionWorktreeStore: {
    getState: () => ({
      getAttachment: () => undefined,
      setAttachment: () => undefined,
      clearAttachment: () => undefined,
    }),
  },
}))

mock.module("../viewport-store", () => ({
  getViewportSessionMemory: () => null,
  viewportSessionKey: (sessionId: string) => sessionId,
  useViewportStore: {
    getState: () => ({
      updateViewportAnchor: mock(() => undefined),
    }),
    setState: () => undefined,
  },
}))

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      clearAttachedFiles: () => undefined,
      setPendingInputText: () => undefined,
      addRestoredAttachment: () => undefined,
    }),
  },
}))

mock.module("../sync-refs", () => ({
  getDirectoryState: () => null,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getAllSyncSessions: () => [],
}))

mock.module("../session-actions", () => ({
  abortCurrentOperation: mock(async () => undefined),
  createSession: mock(async (title: string | undefined, directory: string | null, parentID: string | null, metadata?: unknown) => {
    createSessionCalls.push({ title, directory, parentID, metadata })
    return { id: "ses_issue_2039", directory }
  }),
  deleteSession: mock(async () => true),
  archiveSession: mock(async () => true),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async (input: unknown) => {
    optimisticSendCalls.push(input)
  }),
  refetchSessionMessages: mock(async () => undefined),
  revertToMessage: mock(async () => undefined),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  getSessionLastAssistantModel: () => null,
  patchSessionMetadata: mock(async () => undefined),
}))

const {
  materializeOpenDraftSession,
  supersedePendingDraftPermissionPolicy,
  useSessionUIStore,
} = await import("../session-ui-store")

describe("issue 2039 draft auto-accept", () => {
  test("toggles draft state before a session exists", () => {
    const setDraftPermissionAutoAcceptEnabled = mock(() => undefined)
    const setSessionAutoAccept = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    togglePermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: true,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled,
      setSessionAutoAccept,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled).length).toBe(1)
    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled)[0]).toEqual([true])
    expect(getMockCalls(setSessionAutoAccept).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(0)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  test("guards the toggle when no draft is open", () => {
    const setDraftPermissionAutoAcceptEnabled = mock(() => undefined)
    const setSessionAutoAccept = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    togglePermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: false,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled,
      setSessionAutoAccept,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled).length).toBe(0)
    expect(getMockCalls(setSessionAutoAccept).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(1)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  beforeEach(() => {
    storage.clear()
    createSessionCalls.length = 0
    permissionAutoAcceptCalls.length = 0
    optimisticSendCalls.length = 0
    permissionAutoAcceptShouldFail = false

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: false,
        directoryOverride: null,
        parentID: null,
      },
    })
  })

  test("defaults auto-accept on and applies it when the session materializes", async () => {
    useSessionUIStore.getState().openNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled).toBe(true)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result?.sessionId).toBe("ses_issue_2039")
    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", true]])
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_issue_2039")
  })

  test("persists an explicit auto-accept disable when the session materializes", async () => {
    useSessionUIStore.getState().openNewSessionDraft({ permissionAutoAcceptEnabled: false })

    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled).toBe(false)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result?.sessionId).toBe("ses_issue_2039")
    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", false]])
  })

  test("shares one session creation when the same open draft materializes concurrently", async () => {
    useSessionUIStore.getState().openNewSessionDraft()

    const first = materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(false)
    const second = materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult?.sessionId).toBe("ses_issue_2039")
    expect(secondResult?.sessionId).toBe("ses_issue_2039")
    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", true]])
  })

  test("retries a failed disabled policy before dispatching to the materialized session", async () => {
    useSessionUIStore.getState().openNewSessionDraft({ permissionAutoAcceptEnabled: false })
    permissionAutoAcceptShouldFail = true

    await expect(materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })).rejects.toThrow("policy unavailable")

    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", false]])
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_issue_2039")

    await expect(useSessionUIStore.getState().sendMessage(
      "retry",
      "provider",
      "model",
    )).rejects.toThrow("policy unavailable")

    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([
      ["ses_issue_2039", false],
      ["ses_issue_2039", false],
    ])
    expect(optimisticSendCalls).toHaveLength(0)

    permissionAutoAcceptShouldFail = false
    await useSessionUIStore.getState().sendMessage("retry", "provider", "model")

    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([
      ["ses_issue_2039", false],
      ["ses_issue_2039", false],
      ["ses_issue_2039", false],
    ])
    expect(optimisticSendCalls).toHaveLength(1)
  })

  test("does not replay a failed disabled policy after a later explicit override", async () => {
    useSessionUIStore.getState().openNewSessionDraft({ permissionAutoAcceptEnabled: false })
    permissionAutoAcceptShouldFail = true

    await expect(materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })).rejects.toThrow("policy unavailable")

    supersedePendingDraftPermissionPolicy("ses_issue_2039", "test-runtime")
    await useSessionUIStore.getState().sendMessage("send after override", "provider", "model")

    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", false]])
    expect(optimisticSendCalls).toHaveLength(1)
  })

  test("does not apply draft auto-accept after the draft is closed", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(true)
    useSessionUIStore.getState().closeNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled === undefined).toBe(true)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })

    expect(result).toBeNull()
    expect(createSessionCalls).toHaveLength(0)
    expect(permissionAutoAcceptCalls).toHaveLength(0)
  })
})
