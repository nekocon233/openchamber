import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"

// Mock SDK client that records permission.reply / question.reply calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const scopedClientDirectories: string[] = []
const registeredSessionDirectories: Array<{ sessionID: string; directory: string }> = []
let sessionRevertResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let questionReplyError: unknown | null = null
let questionRejectError: unknown | null = null
let sessionShareResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionUpdateResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionUpdatePromise: Promise<Session> | null = null
let sessionMessagesResult: { data?: unknown; error?: unknown; response?: { status?: number } } = { data: [] }
let sessionDeleteResult: Promise<boolean> = Promise.resolve(true)
let sessionGetResult: Promise<Session> | null = null
const sessionDeleteCalls: Array<{ sessionId: string; directory?: string | null }> = []
let sessionDeleteError: unknown | null = null
const globalUpsertedSessions: unknown[] = []
const globalRemovedSessionIds: string[] = []
const deletedCleanupIdentities: Array<{ runtimeKey: string; directory: string; sessionId: string }> = []
const movedSessionDirectories: Array<{ sessionID: string; directory: string }> = []

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const mockScopedClient = {
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

const mockSdk = {
  experimental: {
    controlPlane: {
      moveSession: mock((params: Record<string, unknown>) => {
        replyCalls.push({ method: "controlPlane.moveSession", params })
        return Promise.resolve({})
      }),
    },
  },
  session: {
    messages: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.messages", params })
      return Promise.resolve(sessionMessagesResult)
    }),
    revert: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.revert", params })
      return Promise.resolve(sessionRevertResult)
    }),
    abort: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.abort", params })
      return Promise.resolve({ data: true })
    }),
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return Promise.resolve(sessionUpdateResult.data as Session)
    }),
    update: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.update", params })
      return Promise.resolve(sessionUpdateResult)
    }),
    share: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.share", params })
      return Promise.resolve(sessionShareResult)
    }),
    unshare: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.unshare", params })
      return Promise.resolve(sessionShareResult)
    }),
  },
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

// Mock opencodeClient singleton
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      scopedClientDirectories.push(directory)
      return mockScopedClient
    },
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    replyToPermission: mock((requestId: string, reply: string, options?: { directory?: string | null }) => {
      replyCalls.push({ method: "permission.reply", params: { requestID: requestId, reply, directory: options?.directory } })
      return Promise.resolve(true)
    }),
    replyToQuestion: mock((requestId: string, answers: string[] | string[][], directory?: string | null) => {
      replyCalls.push({ method: "question.reply", params: { requestID: requestId, answers, directory } })
      return Promise.resolve(true)
    }),
    revertSession: mock((sessionId: string, messageId: string, partId?: string, directory?: string | null) => {
      replyCalls.push({
        method: "session.revert",
        params: { sessionID: sessionId, messageID: messageId, partID: partId, directory },
      })
      if (sessionRevertResult.error) {
        const status = sessionRevertResult.response?.status
        throw new Error(`session.revert failed${status ? ` (${status})` : ""}: rejected`)
      }
      return Promise.resolve(sessionRevertResult.data)
    }),
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return sessionUpdatePromise ?? Promise.resolve(sessionUpdateResult.data)
    }),
    getSession: mock(() => {
      if (sessionGetResult) return sessionGetResult
      return Promise.reject(new Error("session not found"))
    }),
    deleteSession: mock((sessionId: string, directory?: string | null) => {
      sessionDeleteCalls.push({ sessionId, directory })
      replyCalls.push({ method: "session.delete", params: { sessionID: sessionId, directory } })
      if (sessionDeleteError) throw sessionDeleteError
      return sessionDeleteResult
    }),
  },
}))

// Mock useConfigStore
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

// Mock useSessionUIStore
const sessionUIState = {
  currentSessionId: null as string | null,
  getDirectoryForSession: (sessionId: string) => {
    if (sessionId === "session-a") return "/test/project"
    if (sessionId === "session-b") return "/other/project"
    return null
  },
  setCurrentSession: (sessionId: string | null) => {
    sessionUIState.currentSessionId = sessionId
  },
  setWorktreeMetadata: () => {},
  setSessionDirectory: (sessionID: string, directory: string) => {
    movedSessionDirectories.push({ sessionID, directory })
  },
}

mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => sessionUIState,
  },
}))

// Mock useInputStore
const inputState = {
  pendingInputText: "",
  pendingInputMode: "normal" as const,
  attachedFiles: [],
  clearAttachedFiles: () => {
    inputState.attachedFiles = []
  },
  addRestoredAttachment: (attachment: never) => {
    inputState.attachedFiles = [...inputState.attachedFiles, attachment]
  },
}

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => inputState,
    setState: (patch: Partial<typeof inputState>) => Object.assign(inputState, patch),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: (session: SessionWithDirectory) => session.directory ?? session.project?.worktree ?? null,
  mergeSessionDirectoryMetadata: (incoming: Session, existing?: SessionWithDirectory | null): SessionWithDirectory => {
    if (!existing) return incoming as SessionWithDirectory
    const next = { ...(incoming as SessionWithDirectory) }
    if (!next.directory && existing.directory) next.directory = existing.directory
    if (!next.project && existing.project) next.project = existing.project
    if (next.project && !next.project.worktree && existing.project?.worktree) {
      next.project = { ...next.project, worktree: existing.project.worktree }
    }
    return next
  },
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      upsertSession: (session: unknown) => {
        globalUpsertedSessions.push(session)
      },
      removeSessions: (ids: Iterable<string>) => {
        globalRemovedSessionIds.push(...ids)
      },
    }),
  },
}))

mock.module("./session-deletion-cleanup", () => ({
  cleanupPersistedSessionState: (identity: { runtimeKey: string; directory: string; sessionId: string }) => {
    deletedCleanupIdentities.push(identity)
  },
}))

mock.module("./sync-refs", () => ({
  registerSessionDirectory: (sessionID: string, directory: string) => {
    registeredSessionDirectories.push({ sessionID, directory })
  },
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"

type OptimisticAddCall = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveCall = { sessionID: string; directory?: string | null; messageID: string }
type SessionWithDirectory = Session & {
  directory?: string | null
  project?: { worktree?: string | null }
}

function createStore(
  permissions: Record<string, PermissionRequest[]>,
  state?: Partial<DirectoryStore>,
): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    permission: permissions,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("./child-store").ChildStoreManager
}

describe("moveSessionToDirectory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    registeredSessionDirectories.length = 0
    movedSessionDirectories.length = 0
    globalUpsertedSessions.length = 0
  })

  test("moves through the control plane and reconciles directory stores", async () => {
    const message = {
      id: "message-a",
      sessionID: "session-a",
      role: "user",
      time: { created: 1 },
    } as Message
    const part = {
      id: "part-a",
      messageID: "message-a",
      type: "text",
      text: "hello",
    } as Part
    const source = createStore({ "session-a": [{ id: "permission-a" }] as never }, {
      session: [{ id: "session-a", title: "Move me", directory: "/source" } as Session],
      sessionTotal: 1,
      session_status: { "session-a": { type: "idle" } },
      session_diff: { "session-a": [{ file: "changed.ts", additions: 1, deletions: 0 }] },
      todo: { "session-a": [{ id: "todo-a", content: "Check move", status: "pending", priority: "medium" }] as never },
      question: { "session-a": [{ id: "question-a" }] as never },
      message: { "session-a": [message] },
      part: { "message-a": [part] },
    })
    const destination = createStore({})
    const childStores = createChildStores([["/source", source], ["/destination", destination]])
    const { moveSessionToDirectory, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/source")

    await moveSessionToDirectory(source.getState().session[0], "/source", "/destination", true)

    expect(replyCalls.filter((call) => call.method === "controlPlane.moveSession")).toEqual([{
      method: "controlPlane.moveSession",
      params: {
        sessionID: "session-a",
        destination: { directory: "/destination" },
        moveChanges: true,
      },
    }])
    expect(source.getState().session).toHaveLength(0)
    expect(source.getState().sessionTotal).toBe(0)
    expect(source.getState().session_status["session-a"]).toBe(undefined)
    expect(source.getState().session_diff["session-a"]).toBe(undefined)
    expect(source.getState().todo["session-a"]).toBe(undefined)
    expect(source.getState().permission["session-a"]).toBe(undefined)
    expect(source.getState().question["session-a"]).toBe(undefined)
    expect(source.getState().message["session-a"]).toBe(undefined)
    expect(source.getState().part["message-a"]).toBe(undefined)
    expect(destination.getState().session[0]?.id).toBe("session-a")
    expect(destination.getState().sessionTotal).toBe(1)
    expect((destination.getState().session[0] as SessionWithDirectory)?.directory).toBe("/destination")
    expect(destination.getState().session_status["session-a"]?.type).toBe("idle")
    expect(destination.getState().session_diff["session-a"]?.[0]?.file).toBe("changed.ts")
    expect(destination.getState().todo["session-a"]?.[0]?.content).toBe("Check move")
    expect(destination.getState().permission["session-a"]?.[0]?.id).toBe("permission-a")
    expect(destination.getState().question["session-a"]?.[0]?.id).toBe("question-a")
    expect(destination.getState().message["session-a"]?.[0]?.id).toBe("message-a")
    expect(destination.getState().part["message-a"]?.[0]?.id).toBe("part-a")
    expect(registeredSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/destination" }])
    expect(movedSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/destination" }])
    expect((globalUpsertedSessions[0] as SessionWithDirectory).directory).toBe("/destination")

    await moveSessionToDirectory(destination.getState().session[0], "/destination", "/source", true)

    expect(replyCalls.filter((call) => call.method === "controlPlane.moveSession")[1]?.params.moveChanges).toBe(true)
    expect(source.getState().session[0]?.id).toBe("session-a")
    expect(source.getState().message["session-a"]?.[0]?.id).toBe("message-a")
    expect(source.getState().part["message-a"]?.[0]?.id).toBe("part-a")
    expect(destination.getState().session).toHaveLength(0)
    expect(destination.getState().message["session-a"]).toBe(undefined)
    expect(destination.getState().part["message-a"]).toBe(undefined)
  })
})

describe("confirmed session removal", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    globalRemovedSessionIds.length = 0
    deletedCleanupIdentities.length = 0
    sessionDeleteCalls.length = 0
    sessionDeleteResult = Promise.resolve(true)
    sessionDeleteError = null
    sessionUpdateResult = {}
  })

  test("does not remove live or persisted state when delete fails", async () => {
    sessionDeleteError = new Error("delete failed")
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(false)
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalRemovedSessionIds).toEqual([])
    expect(deletedCleanupIdentities).toEqual([])
  })

  test("cleans persisted state after the server confirms deletion", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(true)
    expect(source.getState().session).toEqual([])
    expect(globalRemovedSessionIds).toEqual(["session-a"])
    expect(deletedCleanupIdentities).toHaveLength(1)
    expect({
      directory: deletedCleanupIdentities[0]?.directory,
      sessionId: deletedCleanupIdentities[0]?.sessionId,
    }).toEqual({ directory: "/test/project", sessionId: "session-a" })
  })

  test("does not archive locally until the server returns the archived session", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(false)
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalUpsertedSessions).toEqual([])
  })

  test("moves the session to archived state after server confirmation", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 2 } } as Session,
    }
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(true)
    expect(source.getState().session).toEqual([])
    expect((globalUpsertedSessions[0] as Session)?.time?.archived).toBe(2)
  })
})

describe("fetchMessagesForSession startup race", () => {
  test("does not reject before sync action refs are initialized", async () => {
    const { fetchMessagesForSession } = await import("./session-actions")

    let error: unknown = null
    try {
      await fetchMessagesForSession("session-a", "/test/project")
    } catch (err) {
      error = err
    }

    expect(error).toBe(null)
  })
})

describe("shareSession live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    sessionShareResult = {}
  })

  test("updates the directory live store after unsharing", async () => {
    const sharedSession = { id: "session-a", time: { created: 1 }, share: { url: "https://share.example/a" } } as Session
    const unsharedSession = { id: "session-a", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const otherStore = createStore({}, { session: [{ id: "other", time: { created: 1 } } as Session] })
    const childStores = createChildStores([
      ["/test/project", sessionStore],
      ["/other/project", otherStore],
    ])
    sessionShareResult = { data: unsharedSession }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await unshareSession("session-a")

    expect(result).toBe(unsharedSession)
    expect(replyCalls.find((call) => call.method === "session.unshare")?.params.directory).toBe("/test/project")
    expect(sessionStore.getState().session[0].share).toBe(undefined)
    expect(otherStore.getState().session[0].id).toBe("other")
    expect(globalUpsertedSessions).toEqual([unsharedSession])
  })

  test("updates the directory live store after sharing", async () => {
    const unsharedSession = { id: "session-a", time: { created: 1 } } as Session
    const sharedSession = { id: "session-a", time: { created: 1, updated: 2 }, share: { url: "https://share.example/a" } } as Session
    const sessionStore = createStore({}, { session: [unsharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: sharedSession }

    const { setActionRefs, shareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await shareSession("session-a")

    expect(result).toBe(sharedSession)
    expect(replyCalls.find((call) => call.method === "session.share")?.params.directory).toBe("/test/project")
    expect(sessionStore.getState().session[0].share?.url).toBe("https://share.example/a")
    expect(globalUpsertedSessions).toEqual([sharedSession])
  })

  test("preserves live directory metadata while clearing share from null response", async () => {
    const sharedSession = {
      id: "session-a",
      time: { created: 1 },
      directory: "/test/project",
      project: { worktree: "/test/project" },
      share: { url: "https://share.example/a" },
    } as SessionWithDirectory
    const unsharedSession = {
      id: "session-a",
      time: { created: 1, updated: 2 },
      share: null,
    } as unknown as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: unsharedSession }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await unshareSession("session-a")

    const liveSession = sessionStore.getState().session[0] as SessionWithDirectory & { share?: null }
    expect(liveSession.share).toBe(null)
    expect(liveSession.directory).toBe("/test/project")
    expect(liveSession.project?.worktree).toBe("/test/project")
  })

  test("strips oversized diff snapshots before updating session stores", async () => {
    const sessionWithDiff = {
      id: "session-a",
      time: { created: 1, updated: 2 },
      share: { url: "https://share.example/a" },
      summary: {
        diffs: [{ file: "a.txt", before: "old", after: "new", additions: 1, deletions: 1 }],
      },
    } as unknown as Session
    const sessionStore = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: sessionWithDiff }

    const { setActionRefs, shareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await shareSession("session-a")

    const storedDiff = ((sessionStore.getState().session[0] as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0]
    const globalDiff = (((globalUpsertedSessions[0] as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0])
    const resultDiff = ((result as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0]
    expect(storedDiff.before).toBe(undefined)
    expect(storedDiff.after).toBe(undefined)
    expect(globalDiff.before).toBe(undefined)
    expect(resultDiff.after).toBe(undefined)
  })
})

describe("session removal navigation runtime scope", () => {
  beforeEach(() => {
    replyCalls.length = 0
    sessionDeleteCalls.length = 0
    sessionDeleteResult = Promise.resolve(true)
    sessionDeleteError = null
    sessionGetResult = null
    sessionUpdatePromise = null
    globalUpsertedSessions.length = 0
    sessionUIState.currentSessionId = null
  })

  test("does not send a delete through the replacement runtime while prerequisite work is pending", async () => {
    const getSession = deferred<Session>()
    sessionGetResult = getSession.promise
    const oldSession = { id: "session-a", time: { created: 1 } } as Session
    const oldStore = createStore({}, { session: [oldSession] })
    const newSession = { id: "session-a", title: "New runtime", time: { created: 2 } } as Session
    const newStore = createStore({}, { session: [newSession] })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { deleteSession, setActionRefs } = await import("./session-actions")

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-prerequisite-a.test", runtimeKey: "runtime-prerequisite-a" })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/test/project", oldStore]]),
      () => "/test/project",
    )
    const deletion = deleteSession("session-a")
    await Promise.resolve()

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-prerequisite-b.test", runtimeKey: "runtime-prerequisite-b" })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/test/project", newStore]]),
      () => "/test/project",
    )
    getSession.resolve(oldSession)

    expect(await deletion).toBe(false)
    expect(sessionDeleteCalls).toEqual([])
    expect(newStore.getState().session).toEqual([newSession])
  })

  test("preserves the session and concurrent updates until deletion is confirmed", async () => {
    const target = { id: "session-a", title: "Target", time: { created: 1 } } as Session
    const existing = { id: "existing", title: "Existing", time: { created: 2 } } as Session
    const concurrent = { id: "concurrent", title: "Concurrent", time: { created: 3 } } as Session
    const store = createStore({}, { session: [target, existing] })
    const deletionResult = deferred<boolean>()
    sessionDeleteResult = deletionResult.promise
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { deleteSession, setActionRefs } = await import("./session-actions")

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-rollback.test", runtimeKey: "runtime-rollback" })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/test/project", store]]),
      () => "/test/project",
    )
    const deletion = deleteSession("session-a")
    while (sessionDeleteCalls.length === 0) await Promise.resolve()

    store.setState({ session: [target, concurrent, existing] })
    expect(store.getState().session.map((session) => session.id)).toEqual([
      "session-a",
      "concurrent",
      "existing",
    ])
    deletionResult.reject(new Error("injected delete failure"))

    expect(await deletion).toBe(false)
    expect(store.getState().session.map((session) => session.id)).toEqual([
      "session-a",
      "concurrent",
      "existing",
    ])
    expect(store.getState().session[1]).toBe(concurrent)
    expect(store.getState().session[2]).toBe(existing)
  })

  test("does not resurrect a session removed by an authoritative event while deletion is pending", async () => {
    const target = { id: "session-a", title: "Target", time: { created: 1 } } as Session
    const store = createStore({}, { session: [target] })
    const deletionResult = deferred<boolean>()
    sessionDeleteResult = deletionResult.promise
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { deleteSession, setActionRefs } = await import("./session-actions")

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-authoritative-delete.test", runtimeKey: "runtime-authoritative-delete" })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/test/project", store]]),
      () => "/test/project",
    )
    const deletion = deleteSession("session-a")
    while (sessionDeleteCalls.length === 0) await Promise.resolve()

    store.setState({ session: [] })
    deletionResult.reject(new Error("response lost after delete"))

    expect(await deletion).toBe(false)
    expect(store.getState().session).toEqual([])
  })

  test("drops follow-up state after a cross-directory delete succeeds", async () => {
    const target = { id: "session-cross-directory", title: "Target", time: { created: 1 } } as Session
    const store = createStore({}, { session: [target] })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { useMessageQueueStore } = await import("@/stores/messageQueueStore")
    const { deleteSessionInDirectory, setActionRefs } = await import("./session-actions")
    const runtimeKey = "runtime-cross-directory-delete"
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-cross-directory-delete.test", runtimeKey })
    useMessageQueueStore.getState().switchRuntime(runtimeKey)
    useMessageQueueStore.setState({
      queuedMessages: {
        "session-cross-directory": [{
          id: "queued-cross-directory",
          messageId: "msg_cross_directory",
          content: "delete me",
          createdAt: 1,
          status: "staged",
        }],
      },
    })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/other/project", store]]),
      () => "/current/project",
    )

    expect(await deleteSessionInDirectory("session-cross-directory", "/other/project")).toBe(true)
    expect(useMessageQueueStore.getState().queuedMessages["session-cross-directory"]).toBe(undefined)
  })

  test("does not write an archived response into stores rebound to another runtime", async () => {
    const archiveResult = deferred<Session>()
    sessionUpdatePromise = archiveResult.promise
    const oldSession = { id: "session-a", title: "Old runtime", time: { created: 1 } } as Session
    const oldStore = createStore({}, { session: [oldSession] })
    const newSession = { id: "session-a", title: "New runtime", time: { created: 2 } } as Session
    const newStore = createStore({}, { session: [newSession] })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { archiveSession, setActionRefs } = await import("./session-actions")

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-archive-a.test", runtimeKey: "runtime-archive-a" })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/test/project", oldStore]]),
      () => "/test/project",
    )
    const archive = archiveSession("session-a")
    while (!replyCalls.some((call) => call.method === "session.update")) await Promise.resolve()

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-archive-b.test", runtimeKey: "runtime-archive-b" })
    setActionRefs(
      mockSdk as unknown as OpencodeClient,
      createChildStores([["/test/project", newStore]]),
      () => "/test/project",
    )
    archiveResult.resolve({ id: "session-a", title: "Archived old runtime", time: { created: 1, archived: 3 } } as Session)

    expect(await archive).toBe(true)
    expect(globalUpsertedSessions).toEqual([])
    expect(newStore.getState().session).toEqual([newSession])
  })

  test("cleans the initiating runtime after a runtime switch without clearing the new runtime", async () => {
    let resolveDelete!: (value: boolean) => void
    sessionDeleteResult = new Promise<boolean>((resolve) => {
      resolveDelete = resolve
    })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const {
      clearPersistedSessionNavigation,
      persistSessionNavigation,
      readPersistedSessionNavigation,
    } = await import("./session-navigation")
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([]), () => "/test/project")

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-delete-a.test", runtimeKey: "runtime-delete-a" })
    persistSessionNavigation("session-a", "/test/project", getRuntimeKey())
    const deletion = deleteSession("session-a")
    while (sessionDeleteCalls.length === 0) await Promise.resolve()

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-delete-b.test", runtimeKey: "runtime-delete-b" })
    persistSessionNavigation("session-a", "/other/project", getRuntimeKey())
    sessionUIState.currentSessionId = "session-a"
    resolveDelete(true)

    try {
      expect(await deletion).toBe(true)
      expect(readPersistedSessionNavigation("runtime-delete-a")).toBeNull()
      expect(readPersistedSessionNavigation("runtime-delete-b")?.directory).toBe("/other/project")
      expect(sessionUIState.currentSessionId).toBe("session-a")
    } finally {
      clearPersistedSessionNavigation(null, "runtime-delete-a")
      clearPersistedSessionNavigation(null, "runtime-delete-b")
    }
  })
})

describe("updateSessionTitle live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    sessionUpdateResult = {}
  })

  test("updates the live directory store after renaming", async () => {
    const oldSession = { id: "session-a", title: "Old Title", time: { created: 1, updated: 1 } } as Session
    const updatedSession = { id: "session-a", title: "New Title", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [oldSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionUpdateResult = { data: updatedSession }

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await updateSessionTitle("session-a", "New Title")

    const updateCall = replyCalls.find((call) => call.method === "session.update")
    expect(updateCall?.params.sessionID).toBe("session-a")
    expect(updateCall?.params.title).toBe("New Title")
    expect(updateCall?.params.directory).toBe("/test/project")
    expect(globalUpsertedSessions).toEqual([updatedSession])
    expect(sessionStore.getState().session[0].title).toBe("New Title")
  })
})

describe("optimisticSend target directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionMessagesResult = { data: [] }
  })

  test("passes the prompt directory to optimistic state during session switch races", async () => {
    const currentStore = createStore({})
    const targetStore = createStore({})
    const childStores = createChildStores([
      ["/current/project", currentStore],
      ["/target/project", targetStore],
    ])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    await optimisticSend({
      sessionId: "session-new",
      directory: "/target/project",
      content: "hello",
      providerID: "provider",
      modelID: "model",
      send: async (messageID) => {
        sentMessageID = messageID
      },
    })

    expect(optimisticAdd).not.toBeNull()
    const add = optimisticAdd as unknown as OptimisticAddCall
    expect(add.directory).toBe("/target/project")
    expect(add.sessionID).toBe("session-new")
    expect(add.message.id).toBe(sentMessageID)
    expect(optimisticRemove).toBe(null)
    expect(targetStore.getState().session_status["session-new"]?.type).toBe("busy")
    expect(currentStore.getState().session_status["session-new"]).toBe(undefined)
  })

  test("does not insert or dispatch when the runtime changes during pre-insert work", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    const beforeStarted = deferred<void>()
    const releaseBeforeInsert = deferred<void>()
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let finalSendCalled = false
    const {
      getRuntimeEndpointGeneration,
      getRuntimeKey,
      RuntimeContextChangedError,
      switchRuntimeEndpoint,
    } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })
    const expectedRuntime = {
      runtimeKey: getRuntimeKey(),
      generation: getRuntimeEndpointGeneration(),
    }

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    const sendPromise = optimisticSend({
      sessionId: "session-race",
      directory: "/target/project",
      content: "hello",
      providerID: "provider",
      modelID: "model",
      expectedRuntime,
      beforeOptimisticInsert: async () => {
        beforeStarted.resolve()
        await releaseBeforeInsert.promise
      },
      send: async () => {
        finalSendCalled = true
      },
    })
    await beforeStarted.promise
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-a" })
    releaseBeforeInsert.resolve()

    let caught: unknown = null
    try {
      await sendPromise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RuntimeContextChangedError)
    expect(optimisticAdd).toBeNull()
    expect(optimisticRemove).toBeNull()
    expect(finalSendCalled).toBe(false)
    expect(targetStore.getState().session_status["session-race"]).toBe(undefined)
  })

  test("does not confirm or roll back an old runtime after a late send failure", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    const sendStarted = deferred<void>()
    const sendResult = deferred<void>()
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null
    const {
      getRuntimeEndpointGeneration,
      getRuntimeKey,
      RuntimeContextChangedError,
      switchRuntimeEndpoint,
    } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-late-a.test", runtimeKey: "runtime-late" })
    const expectedRuntime = {
      runtimeKey: getRuntimeKey(),
      generation: getRuntimeEndpointGeneration(),
    }

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    const sendPromise = optimisticSend({
      sessionId: "session-late-failure",
      directory: "/target/project",
      content: "hello",
      providerID: "provider",
      modelID: "model",
      expectedRuntime,
      send: async () => {
        sendStarted.resolve()
        return sendResult.promise
      },
    })
    await sendStarted.promise
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-late-b.test", runtimeKey: "runtime-late" })
    sendResult.reject(new TypeError("Load failed"))

    let caught: unknown = null
    try {
      await sendPromise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RuntimeContextChangedError)
    expect(optimisticRemove).toBeNull()
    expect(optimisticConfirm).toBeNull()
    expect(targetStore.getState().session_status["session-late-failure"]?.type).toBe("busy")
    expect(replyCalls.some((call) => call.method === "session.messages")).toBe(false)
  })

  test("commits the new branch locally when sending after a revert", async () => {
    const retainedMessage = { id: "msg_1", role: "user", sessionID: "session-reverted" } as Message
    const revertedMessage = { id: "msg_2", role: "user", sessionID: "session-reverted" } as Message
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: "msg_2" } } as Session],
      message: { "session-reverted": [retainedMessage, revertedMessage] },
      part: { msg_2: [{ id: "part_2", type: "text", text: "old branch" } as Part] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticMessage: Message | null = null

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticMessage = input.message
        targetStore.setState((state) => ({
          message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message] },
          part: { ...state.part, [input.message.id]: input.parts },
        }))
      },
      () => {},
    )

    await optimisticSend({
      sessionId: "session-reverted",
      directory: "/target/project",
      content: "new branch",
      providerID: "provider",
      modelID: "model",
      send: async () => {},
    })

    expect(targetStore.getState().session[0].revert).toBe(undefined)
    expect(targetStore.getState().message["session-reverted"].map((message) => message.id)).toEqual([
      "msg_1",
      (optimisticMessage as unknown as Message).id,
    ])
    expect(targetStore.getState().part.msg_2).toBe(undefined)
  })

  test("restores the reverted branch when sending fails", async () => {
    const retainedMessage = { id: "msg_1", role: "user", sessionID: "session-reverted" } as Message
    const revertedMessage = { id: "msg_2", role: "user", sessionID: "session-reverted" } as Message
    const revertedPart = { id: "part_2", type: "text", text: "old branch" } as Part
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: "msg_2" } } as Session],
      message: { "session-reverted": [retainedMessage, revertedMessage] },
      part: { msg_2: [revertedPart] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => targetStore.setState((state) => ({
        message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message] },
        part: { ...state.part, [input.message.id]: input.parts },
      })),
      (input) => targetStore.setState((state) => ({
        message: { ...state.message, [input.sessionID]: (state.message[input.sessionID] ?? []).filter((message) => message.id !== input.messageID) },
        part: Object.fromEntries(Object.entries(state.part).filter(([messageID]) => messageID !== input.messageID)),
      })),
    )

    await expect(optimisticSend({
      sessionId: "session-reverted",
      directory: "/target/project",
      content: "new branch",
      providerID: "provider",
      modelID: "model",
      send: async () => { throw new Error("rejected") },
    })).rejects.toThrow("rejected")

    expect(targetStore.getState().session[0].revert?.messageID).toBe("msg_2")
    expect(targetStore.getState().message["session-reverted"]).toEqual([retainedMessage, revertedMessage])
    expect(targetStore.getState().part.msg_2).toEqual([revertedPart])
  })

  test("allows callers to block final send when runtime changes after optimistic insert", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let finalSendCalled = false
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-race",
        directory: "/target/project",
        content: "hello",
        providerID: "provider",
        modelID: "model",
        beforeOptimisticInsert: () => {
          expect(getRuntimeKey()).toBe("runtime-a")
        },
        send: async () => {
          switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
          if (getRuntimeKey() !== "runtime-a") throw new Error("Auto-review stopped because the runtime changed.")
          finalSendCalled = true
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("runtime changed")

    expect(optimisticAdd).not.toBeNull()
    expect(finalSendCalled).toBe(false)
    expect(optimisticRemove).not.toBeNull()
    expect((optimisticRemove as unknown as OptimisticRemoveCall).sessionID).toBe("session-race")
    expect(targetStore.getState().session_status["session-race"]?.type).toBe("idle")
  })

  test("confirms an ambiguous send failure with a recent message refetch", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    await optimisticSend({
      sessionId: "session-confirmed",
      directory: "/target/project",
      content: "hello",
      providerID: "provider",
      modelID: "model",
      send: async (messageID) => {
        sentMessageID = messageID
        sessionMessagesResult = {
          data: [{
            info: { id: messageID, role: "user", sessionID: "session-confirmed", time: { created: 1 } } as Message,
            parts: [{ id: "server-part", type: "text", text: "hello" } as Part],
          }],
        }
        const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
        error.status = 504
        throw error
      },
    })

    expect(optimisticRemove).toBe(null)
    expect((optimisticConfirm as OptimisticRemoveCall | null)?.messageID).toBe(sentMessageID)
    expect(replyCalls.find((call) => call.method === "session.messages")?.params.limit).toBe(30)
    expect(targetStore.getState().message["session-confirmed"]?.[0]?.id).toBe(sentMessageID)
    expect(targetStore.getState().part[sentMessageID]?.[0]?.id).toBe("server-part")
  })

  test("rolls back an ambiguous send failure when recent messages do not contain the sent ID", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-missing",
        directory: "/target/project",
        content: "hello",
        providerID: "provider",
        modelID: "model",
        send: async () => {
          const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
          error.status = 504
          throw error
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((optimisticRemove as OptimisticRemoveCall | null)?.sessionID).toBe("session-missing")
    expect(optimisticConfirm).toBe(null)
    expect(replyCalls.filter((call) => call.method === "session.messages").every((call) => call.params.limit === 30)).toBe(true)
    expect(targetStore.getState().session_status["session-missing"]?.type).toBe("idle")
  })
})

describe("ambiguous send failure classification", () => {
  test("covers transport errors and retryable gateway statuses", async () => {
    const { isAmbiguousSendFailure } = await import("./session-actions")
    const unavailable = new Error("Service Unavailable") as Error & { status?: number }
    unavailable.status = 503

    expect(isAmbiguousSendFailure(unavailable)).toBe(true)
    expect(isAmbiguousSendFailure(new TypeError("Load failed"))).toBe(true)
    expect(isAmbiguousSendFailure(new DOMException("aborted", "AbortError"))).toBe(true)
    expect(isAmbiguousSendFailure(new Error("validation failed"))).toBe(false)
  })
})

describe("respondToPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionRevertResult = {}
  })

  test("passes directory from child store when permission is found", async () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-a", "perm-1", "once")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-1")
    expect(replyCalls[0].params.reply).toBe("once")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })

  test("passes directory from session mapping when permission not in store", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-b", "perm-2", "always")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-2")
    expect(replyCalls[0].params.reply).toBe("always")
    expect(replyCalls[0].params.directory).toBe("/other/project")
  })

  test("passes directory from current directory as last resort", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/fallback/dir")

    await respondToPermission("unknown-session", "perm-3", "reject")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-3")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/fallback/dir")
  })
})

describe("revertToMessage passes session directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionRevertResult = {}
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
    })
  })

  test("routes revert through the session directory instead of the current directory", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const currentStore = createStore({})
    const childStores = createChildStores([
      ["/test/project", sessionStore],
      ["/current/project", currentStore],
    ])
    sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await revertToMessage("session-a", "msg_2")

    expect(replyCalls.find((call) => call.method === "session.revert")?.params.directory).toBe("/test/project")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_2")
    expect(currentStore.getState().session).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("edit this")
  })

  test("rolls back optimistic revert when the SDK returns an error", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionRevertResult = { error: { message: "rejected" }, response: { status: 500 } }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("session.revert failed (500)")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert).toBe(undefined)
    expect(inputState.pendingInputText).toBe("previous draft")
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("passes directory and reply=reject", async () => {
    const permission: PermissionRequest = {
      id: "perm-10",
      sessionID: "session-a",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await dismissPermission("session-a", "perm-10")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-10")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("respondToQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("passes directory to question.reply", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("session-a", "q-1", [["answer1"]])

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-1")
    expect(replyCalls[0].params.directory).toBe("/test/project")
    expect(scopedClientDirectories).toEqual(["/test/project"])
  })

  test("removes stale question from child store when reply returns not found", async () => {
    const question: QuestionRequest = {
      id: "q-stale",
      sessionID: "session-a",
      questions: [
        {
          question: "Choose an option",
          header: "Choice",
          options: [{ label: "Yes", description: "Proceed" }],
        },
      ],
    }
    const store = createStore({}, { question: { "session-a": [question] } })
    const childStores = createChildStores([["/test/project", store]])
    questionReplyError = Object.assign(new Error("question.reply failed (404): QuestionNotFoundError"), { status: 404 })

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown
    try {
      await respondToQuestion("session-a", "q-stale", [["Yes"]])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(store.getState().question["session-a"]).toBe(undefined)
  })
})

describe("rejectQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("passes directory to question.reject", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, rejectQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await rejectQuestion("session-a", "q-2")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-2")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

function buildQuestion(id: string, sessionId: string): QuestionRequest {
  return {
    id,
    sessionID: sessionId,
    questions: [
      {
        question: "Choose an option",
        header: "Choice",
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  }
}

describe("dismissOpenQuestionsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("returns false and rejects nothing when no questions are pending", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(false)
    expect(replyCalls.filter((call) => call.method === "question.reject")).toHaveLength(0)
  })

  test("rejects every pending question in the session subtree (root + subagent child)", async () => {
    const rootQuestion = buildQuestion("q-root", "session-a")
    const childQuestion = buildQuestion("q-child", "session-child")
    const store = createStore({}, {
      session: [
        { id: "session-a", time: { created: 1 } } as Session,
        { id: "session-child", parentID: "session-a", time: { created: 2 } } as Session,
      ],
      question: {
        "session-a": [rootQuestion],
        "session-child": [childQuestion],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(2)
    const rejectedIds = rejectCalls.map((call) => call.params.requestID).sort()
    expect(rejectedIds).toEqual(["q-child", "q-root"])
    // Optimistic clear: the questions are removed from the local store so the
    // prompt disappears instantly, without waiting for the reject round-trip.
    expect(store.getState().question["session-a"]).toBe(undefined)
    expect(store.getState().question["session-child"]).toBe(undefined)
  })

  test("swallows QuestionNotFoundError so a stranded question never blocks the send", async () => {
    const staleQuestion = buildQuestion("q-stale", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: { "session-a": [staleQuestion] },
    })
    const childStores = createChildStores([["/test/project", store]])
    questionRejectError = Object.assign(new Error("question.reject failed (404): QuestionNotFoundError"), { status: 404 })

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(1)
    expect(rejectCalls[0].params.requestID).toBe("q-stale")
    // The stale entry is cleared from the store even though the server reported not-found.
    expect(store.getState().question["session-a"]).toBe(undefined)
  })
})
