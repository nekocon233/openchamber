import { projectNativeQuestion } from '@/lib/native-agents/forms';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Message, type Session, type SessionStatus } from "@/lib/opencode/model"
import { create, type StoreApi } from "zustand"
import { createStore } from "zustand/vanilla"

import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativeQuestionList } from "@/lib/api/types"
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from "@/lib/native-agents/test-utils/runtime"
import { opencodeClient } from "@/lib/opencode/client"
import type { QuestionRequest } from "@/types/question"
import { bootstrapDirectory } from "./bootstrap"
import type { DirectoryStore } from "./child-store"
import { createEventRoutingIndex } from "./event-routing-index"
import { resetGlobalSessionStatuses, setGlobalSessionStatus, useGlobalSessionStatusStore } from "./global-session-status"
import { readDirectoryStatuses } from "./native-directory-snapshots"
import { resyncDirectoryAfterReconnect } from "./session-reconnect-recovery"
import { recoverInterruptedTurnAfterMessageLoad, resyncBlockingRequestsForDirectory } from "./sync-context"
import { INITIAL_STATE, type State } from "./types"

const DIRECTORY = "/repo"
const NATIVE = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const NATIVE_CONVERSATION = "ncv_e4b756f7-72d3-43ef-9c8a-1aafdaaaf3ac"
const NATIVE_CODEX = "ncx_019a5c1e-7a33-7d10-9c52-6f2b1d3e4a5b"
const OPENCODE = "ses_a"
const BUSY: SessionStatus = { type: "busy" }

const sessionRecord = (id: string): Session => ({
  id,
  projectID: "",
  directory: DIRECTORY,
  title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

const question = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Go ahead" }] }],
})

const form = (id: string, sessionID = NATIVE) => {
  const request = projectNativeQuestion(question(id, sessionID));
  if (!request) throw new Error('The fixture needs a question');
  return request;
};

const unfinishedAssistant: Message = {
  id: "ncl_a_0123456789abcdef_msg_1",
  sessionID: NATIVE,
  role: "assistant",
  time: { created: 2 },
  parentID: "ncl_u_1",
  modelID: "opus",
  providerID: "claude-native",
  agent: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const unreadable = async (): Promise<never> => {
  throw new NativeAgentsRequestError("Native session request failed (500)", 500, null)
}

let nativeStatuses: (signal?: AbortSignal) => Promise<Record<string, SessionStatus>> = async () => ({})
let nativeQuestions: () => Promise<NativeQuestionList> = async () => []
let nativeSession: (id: string) => Promise<Session> = async (id) => sessionRecord(id)

const nativeAgents = createTestNativeAgentsAPI({
  getSession: (id) => nativeSession(id),
  statuses: (_directory, options) => nativeStatuses(options?.signal),
  questions: () => nativeQuestions(),
})

let openCodeStatuses: Record<string, SessionStatus> | null = {}
let openCodeQuestions: ReturnType<typeof form>[] = []
const original = {
  getActiveSessionStatuses: opencodeClient.getActiveSessionStatuses,
  listPendingForms: opencodeClient.listPendingForms,
  listPendingPermissions: opencodeClient.listPendingPermissions,
  getConfig: opencodeClient.getConfig,
  getLocation: opencodeClient.getLocation,
  getVcs: opencodeClient.getVcs,
}
const originalWarn = console.warn
let warnings = 0

const createDirectoryStore = (initial: Partial<State>): StoreApi<DirectoryStore> => (
  create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
)

const bootstrapWith = async (state: Partial<State>) => {
  const store = createStore<State>(() => ({ ...INITIAL_STATE, ...state }))
  const bootstrap = bootstrapDirectory({
    directory: DIRECTORY,
    store,
    set: (patch: Partial<State>) => { store.setState(patch) },
    global: { config: {}, projects: [], path: { home: "/home", directory: DIRECTORY, worktree: DIRECTORY } },
    loadSessions: async () => undefined,
  })
  await bootstrap.sessions
  await bootstrap.environment
  return store
}

beforeEach(() => {
  registerRuntimeAPIs(createTestRuntimeAPIs(nativeAgents))
  resetGlobalSessionStatuses()
  nativeStatuses = async () => ({})
  nativeQuestions = async () => []
  nativeSession = async (id) => sessionRecord(id)
  openCodeStatuses = {}
  openCodeQuestions = []
  opencodeClient.getActiveSessionStatuses = async () => openCodeStatuses
  opencodeClient.listPendingForms = async () => openCodeQuestions
  opencodeClient.listPendingPermissions = async () => []
  opencodeClient.getConfig = async () => ({})
  opencodeClient.getLocation = async () => ({ directory: DIRECTORY, workspace: 'workspace-a', project: { id: 'project-a', directory: DIRECTORY, canonical: DIRECTORY } })
  opencodeClient.getVcs = async () => ({ branch: 'main' })
  warnings = 0
  console.warn = () => { warnings += 1 }
})

afterEach(() => {
  registerRuntimeAPIs(null)
  opencodeClient.getActiveSessionStatuses = original.getActiveSessionStatuses
  opencodeClient.listPendingForms = original.listPendingForms
  opencodeClient.listPendingPermissions = original.listPendingPermissions
  Object.assign(opencodeClient, original)
  console.warn = originalWarn
})

describe("readDirectoryStatuses", () => {
  test("merges native statuses and decides every session", async () => {
    openCodeStatuses = { [OPENCODE]: BUSY }
    nativeStatuses = async () => ({ [NATIVE]: BUSY })

    const snapshot = await readDirectoryStatuses(DIRECTORY)

    expect(snapshot?.statuses).toEqual({ [OPENCODE]: BUSY, [NATIVE]: BUSY })
    expect(snapshot?.coversNativeSessions).toBe(true)
    expect(snapshot?.covers(NATIVE)).toBe(true)
    expect(snapshot?.covers(OPENCODE)).toBe(true)
  })

  test("leaves native sessions undecided when their read fails", async () => {
    openCodeStatuses = { [OPENCODE]: BUSY }
    nativeStatuses = unreadable

    const snapshot = await readDirectoryStatuses(DIRECTORY)

    expect(snapshot?.statuses).toEqual({ [OPENCODE]: BUSY })
    expect(snapshot?.coversNativeSessions).toBe(false)
    expect(snapshot?.covers(NATIVE)).toBe(false)
    expect(snapshot?.covers(OPENCODE)).toBe(true)
    expect(warnings).toBe(1)
  })

  test("fails as a whole when OpenCode's read fails", async () => {
    openCodeStatuses = null
    nativeStatuses = async () => ({ [NATIVE]: BUSY })

    expect(await readDirectoryStatuses(DIRECTORY)).toBeNull()
  })

  test("decides every session where the runtime has no native sessions", async () => {
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ supported: false })))
    openCodeStatuses = { [OPENCODE]: BUSY }

    const snapshot = await readDirectoryStatuses(DIRECTORY)

    expect(snapshot?.statuses).toEqual({ [OPENCODE]: BUSY })
    expect(snapshot?.covers(NATIVE)).toBe(true)
  })

  test("a stalled native read ends with the caller's signal, quietly", async () => {
    nativeStatuses = (signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    })
    const controller = new AbortController()

    const pending = readDirectoryStatuses(DIRECTORY, { signal: controller.signal })
    controller.abort()
    const snapshot = await pending

    expect(snapshot?.covers(NATIVE)).toBe(false)
    expect(warnings).toBe(0)
  })
})

describe("directory bootstrap with native sessions", () => {
  test("merges native statuses and questions next to OpenCode's", async () => {
    nativeStatuses = async () => ({ [NATIVE]: BUSY })
    nativeQuestions = async () => [question("que_native", NATIVE)]

    const store = await bootstrapWith({ session: [sessionRecord(NATIVE)] })

    expect(store.getState().nativeSessionStatusReady).toBe(true)
    expect(store.getState().session_status[NATIVE]).toEqual(BUSY)
    expect(store.getState().form[NATIVE]?.map((item) => item.id)).toEqual(["que_native"])
    expect(useGlobalSessionStatusStore.getState().statusById.get(NATIVE)?.status).toEqual(BUSY)
  })

  test("keeps what it holds for native sessions when their reads fail", async () => {
    nativeStatuses = unreadable
    nativeQuestions = unreadable
    setGlobalSessionStatus(NATIVE, DIRECTORY, "busy")
    // Known busy globally only, e.g. from the host seed: nothing to echo back.
    setGlobalSessionStatus(NATIVE_CODEX, DIRECTORY, "busy")
    setGlobalSessionStatus(OPENCODE, DIRECTORY, "busy")

    const store = await bootstrapWith({
      session: [sessionRecord(NATIVE), sessionRecord(NATIVE_CODEX), sessionRecord(OPENCODE)],
      session_status: { [NATIVE]: BUSY, [OPENCODE]: BUSY },
      form: { [NATIVE]: [form("que_native", NATIVE)] },
    })

    expect(store.getState().session_status[NATIVE]).toEqual(BUSY)
    expect(store.getState().session_status[OPENCODE]).toBeUndefined()
    expect(store.getState().sessionStatusReady).toBe(true)
    expect(store.getState().nativeSessionStatusReady).toBe(false)
    expect(store.getState().form[NATIVE]?.map((item) => item.id)).toEqual(["que_native"])
    const global = useGlobalSessionStatusStore.getState().statusById
    expect(global.get(NATIVE)?.status).toEqual(BUSY)
    expect(global.get(NATIVE_CODEX)?.status).toEqual(BUSY)
    expect(global.has(OPENCODE)).toBe(false)
  })
})

describe("blocking request resync with native sessions", () => {
  const heldQuestions = () => createDirectoryStore({
    session: [sessionRecord(OPENCODE), sessionRecord(NATIVE)],
    form: {
      [OPENCODE]: [form("que_opencode", OPENCODE)],
      [NATIVE]: [form("que_native", NATIVE)],
    },
  })

  test("settles OpenCode questions and keeps native ones when the native read fails", async () => {
    nativeQuestions = unreadable
    const store = heldQuestions()

    await resyncBlockingRequestsForDirectory(DIRECTORY, store)

    expect(store.getState().form[OPENCODE]).toBeUndefined()
    expect(store.getState().form[NATIVE]?.map((item) => item.id)).toEqual(["que_native"])
  })

  test("settles native questions from a successful native read", async () => {
    const store = heldQuestions()

    await resyncBlockingRequestsForDirectory(DIRECTORY, store)

    expect(store.getState().form[NATIVE]).toBeUndefined()
  })

  test("scopes single-session form recovery to the session's own backend and skips no-op store updates", async () => {
    let openCodeCalls = 0
    let permissionCalls = 0
    opencodeClient.listPendingForms = async () => { openCodeCalls += 1; return [] }
    opencodeClient.listPendingPermissions = async () => { permissionCalls += 1; return [] }
    nativeQuestions = async () => []
    const store = createDirectoryStore({ session: [sessionRecord(NATIVE_CONVERSATION)] })
    let updates = 0
    const unsubscribe = store.subscribe(() => { updates += 1 })
    try {
      await resyncBlockingRequestsForDirectory(DIRECTORY, store, [NATIVE_CONVERSATION], { includePermissions: false })
      expect(openCodeCalls).toBe(0)
      expect(permissionCalls).toBe(0)
      expect(updates).toBe(0)

      nativeQuestions = async () => [question("que_native", NATIVE_CONVERSATION)]
      await resyncBlockingRequestsForDirectory(DIRECTORY, store, [NATIVE_CONVERSATION], { includePermissions: false })
      expect(store.getState().form[NATIVE_CONVERSATION]?.map((item) => item.id)).toEqual(["que_native"])
      expect(openCodeCalls).toBe(0)
      expect(updates).toBe(1)

      // An identical second response publishes nothing.
      await resyncBlockingRequestsForDirectory(DIRECTORY, store, [NATIVE_CONVERSATION], { includePermissions: false })
      expect(updates).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  test("recovers native questions even when OpenCode pending forms fail", async () => {
    opencodeClient.listPendingForms = async () => { throw new Error("OpenCode unavailable") }
    nativeQuestions = async () => [question("que_native_live", NATIVE)]
    const store = createDirectoryStore({
      session: [sessionRecord(OPENCODE), sessionRecord(NATIVE)],
      form: { [OPENCODE]: [form("que_opencode_kept", OPENCODE)] },
    })

    const ok = await resyncBlockingRequestsForDirectory(DIRECTORY, store)

    expect(ok).toBe(false)
    expect(store.getState().form[OPENCODE]?.map((item) => item.id)).toEqual(["que_opencode_kept"])
    expect(store.getState().form[NATIVE]?.map((item) => item.id)).toEqual(["que_native_live"])
  })

  test("does not resurrect a form settled while resync is in flight and keeps a form created mid-flight", async () => {
    const existing = form("que_existing", NATIVE_CONVERSATION)
    const created = form("que_created", NATIVE_CONVERSATION)
    const store = createDirectoryStore({
      session: [sessionRecord(NATIVE_CONVERSATION)],
      form: { [NATIVE_CONVERSATION]: [existing] },
    })
    let resolveRead!: (value: NativeQuestionList) => void
    nativeQuestions = () => new Promise<NativeQuestionList>((resolve) => { resolveRead = resolve })

    const pending = resyncBlockingRequestsForDirectory(DIRECTORY, store, [NATIVE_CONVERSATION], { includePermissions: false })
    // User answers/dismisses `existing` and a newer `created` form arrives while the HTTP read is in flight.
    store.setState({ form: { [NATIVE_CONVERSATION]: [created] } })
    resolveRead([question("que_existing", NATIVE_CONVERSATION)])
    await pending

    expect(store.getState().form[NATIVE_CONVERSATION]?.map((item) => item.id)).toEqual(["que_created"])
  })
})

describe("reconnect recovery with native sessions", () => {
  test("recovers pending post-turn forms for idle native sessions on reconnect without touching OpenCode", async () => {
    let openCodeFormCalls = 0
    let openCodePermissionCalls = 0
    opencodeClient.listPendingForms = async () => { openCodeFormCalls += 1; return [] }
    opencodeClient.listPendingPermissions = async () => { openCodePermissionCalls += 1; return [] }
    const store = createDirectoryStore({
      session: [sessionRecord(NATIVE_CODEX), sessionRecord(OPENCODE)],
      session_status: { [NATIVE_CODEX]: { type: "idle" }, [OPENCODE]: { type: "idle" } },
    })
    nativeStatuses = async () => ({})
    nativeQuestions = async () => [question("que_codex_plan", NATIVE_CODEX)]

    const ok = await resyncDirectoryAfterReconnect(DIRECTORY, store, createEventRoutingIndex(), "stream-reconnect")

    expect(ok).toBe(true)
    expect(openCodeFormCalls).toBe(0)
    expect(openCodePermissionCalls).toBe(0)
    expect(store.getState().form[NATIVE_CODEX]?.map((item) => item.id)).toEqual(["que_codex_plan"])
  })
  test("still recovers pending native questions when a session is patched during the status fetch", async () => {
    const initial = sessionRecord(NATIVE_CONVERSATION)
    const patched = { ...initial, title: "Updated during reconnect", time: { created: 1, updated: 20 } }
    const store = createDirectoryStore({
      session: [initial],
      session_status: { [NATIVE_CONVERSATION]: BUSY },
    })
    nativeStatuses = async () => {
      // Simulate an in-flight `session.patched` replacing the session reference
      // while the reconnect status snapshot is still in flight.
      store.setState({ session: [patched] })
      return { [NATIVE_CONVERSATION]: BUSY }
    }
    let sessionReads = 0
    nativeSession = async () => {
      sessionReads += 1
      return { ...patched, title: "Authoritative recovery", time: { created: 1, updated: 25 } }
    }
    nativeQuestions = async () => [question("que_reconnect", NATIVE_CONVERSATION)]

    const ok = await resyncDirectoryAfterReconnect(DIRECTORY, store, createEventRoutingIndex(), "stream-reconnect")

    expect(ok).toBe(true)
    expect(sessionReads).toBe(1)
    expect(store.getState().session[0]?.title).toBe("Authoritative recovery")
    expect(store.getState().form[NATIVE_CONVERSATION]?.map((item) => item.id)).toEqual(["que_reconnect"])
  })

  test("does not overwrite a session patched while readRecoverySession is in flight, but still recovers its question", async () => {
    const initial = sessionRecord(NATIVE_CONVERSATION)
    const livePatch = { ...initial, title: "Live patch during recovery", time: { created: 1, updated: 30 } }
    const store = createDirectoryStore({
      session: [initial],
      session_status: { [NATIVE_CONVERSATION]: BUSY },
    })
    nativeStatuses = async () => ({ [NATIVE_CONVERSATION]: BUSY })
    nativeSession = async () => {
      store.setState({ session: [livePatch] })
      return { ...initial, title: "Stale recovery read", time: { created: 1, updated: 15 } }
    }
    nativeQuestions = async () => [question("que_after_patch", NATIVE_CONVERSATION)]

    const ok = await resyncDirectoryAfterReconnect(DIRECTORY, store, createEventRoutingIndex(), "stream-reconnect")

    expect(ok).toBe(true)
    expect(store.getState().session[0]?.title).toBe("Live patch during recovery")
    expect(store.getState().form[NATIVE_CONVERSATION]?.map((item) => item.id)).toEqual(["que_after_patch"])
  })

  test("excludes a session removed or archived during the status fetch", async () => {
    const removed = sessionRecord(NATIVE_CONVERSATION)
    const archived = sessionRecord(NATIVE)
    const store = createDirectoryStore({
      session: [removed, archived],
      session_status: { [NATIVE_CONVERSATION]: BUSY, [NATIVE]: BUSY },
    })
    const fetchedSessions: string[] = []
    nativeSession = async (id) => {
      fetchedSessions.push(id)
      return sessionRecord(id)
    }
    nativeStatuses = async () => {
      store.setState({
        session: [{ ...archived, time: { created: 1, updated: 5, archived: 5 } }],
      })
      return { [NATIVE_CONVERSATION]: BUSY, [NATIVE]: BUSY }
    }
    nativeQuestions = async () => [
      question("que_removed", NATIVE_CONVERSATION),
      question("que_archived", NATIVE),
    ]

    await resyncDirectoryAfterReconnect(DIRECTORY, store, createEventRoutingIndex(), "stream-reconnect")

    expect(fetchedSessions).toEqual([])
    expect(store.getState().form[NATIVE_CONVERSATION]).toBeUndefined()
    expect(store.getState().form[NATIVE]).toBeUndefined()
  })
})

describe("interrupted-turn recovery for native sessions", () => {
  const unfinishedTurn = () => createDirectoryStore({
    session: [sessionRecord(NATIVE)],
    message: { [NATIVE]: [unfinishedAssistant] },
  })

  test("leaves an unfinished native turn alone when its status cannot be read", async () => {
    nativeStatuses = unreadable
    const store = unfinishedTurn()

    await recoverInterruptedTurnAfterMessageLoad(DIRECTORY, store, NATIVE)

    expect(store.getState().session_status[NATIVE]).toBeUndefined()
    expect(store.getState().message[NATIVE]).toEqual([unfinishedAssistant])
  })

  test("settles it when the native read reports the session idle", async () => {
    const store = unfinishedTurn()

    await recoverInterruptedTurnAfterMessageLoad(DIRECTORY, store, NATIVE)

    expect(store.getState().session_status[NATIVE]).toEqual({ type: "idle" })
  })
})
