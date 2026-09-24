import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createOpencodeClient, type Message, type Session, type SessionStatus } from "@opencode-ai/sdk/v2/client"
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
import { resetGlobalSessionStatuses, setGlobalSessionStatus, useGlobalSessionStatusStore } from "./global-session-status"
import { readDirectoryStatuses } from "./native-directory-snapshots"
import { recoverInterruptedTurnAfterMessageLoad, resyncBlockingRequestsForDirectory } from "./sync-context"
import { INITIAL_STATE, type State } from "./types"

const DIRECTORY = "/repo"
const NATIVE = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const NATIVE_CODEX = "ncx_019a5c1e-7a33-7d10-9c52-6f2b1d3e4a5b"
const OPENCODE = "ses_a"
const BUSY: SessionStatus = { type: "busy" }

const sessionRecord = (id: string): Session => ({
  id,
  slug: id,
  projectID: "",
  directory: DIRECTORY,
  title: id,
  version: "test",
  time: { created: 1, updated: 1 },
})

const question = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Go ahead" }] }],
})

const unfinishedAssistant: Message = {
  id: "ncl_a_0123456789abcdef_msg_1",
  sessionID: NATIVE,
  role: "assistant",
  time: { created: 2 },
  parentID: "ncl_u_1",
  modelID: "opus",
  providerID: "claude-native",
  mode: "build",
  agent: "build",
  path: { cwd: DIRECTORY, root: DIRECTORY },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const unreadable = async (): Promise<never> => {
  throw new NativeAgentsRequestError("Native session request failed (500)", 500, null)
}

let nativeStatuses: (signal?: AbortSignal) => Promise<Record<string, SessionStatus>> = async () => ({})
let nativeQuestions: () => Promise<NativeQuestionList> = async () => []

const nativeAgents = createTestNativeAgentsAPI({
  statuses: (_directory, options) => nativeStatuses(options?.signal),
  questions: () => nativeQuestions(),
})

let openCodeStatuses: Record<string, SessionStatus> | null = {}
let openCodeQuestions: QuestionRequest[] = []
const original = {
  getSessionStatusForDirectory: opencodeClient.getSessionStatusForDirectory,
  listPendingQuestions: opencodeClient.listPendingQuestions,
  listPendingPermissions: opencodeClient.listPendingPermissions,
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

// Answers OpenCode's directory reads during bootstrap: nothing pending, all idle.
const createSdk = () => createOpencodeClient({
  baseUrl: "https://native-snapshots.test",
  fetch: async (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString())
    const directory = url.searchParams.get("directory")
    const body = url.pathname === "/project/current" ? { id: "project-a" }
      : url.pathname === "/path" ? { directory, worktree: directory, state: "", config: "", home: "/home" }
      : url.pathname === "/config" ? {}
      : url.pathname === "/session/status" ? {}
      : url.pathname === "/vcs" ? { branch: "main" }
      : []
    return Response.json(body)
  },
})

const bootstrapWith = async (state: Partial<State>) => {
  const store = createStore<State>(() => ({ ...INITIAL_STATE, ...state }))
  const bootstrap = bootstrapDirectory({
    directory: DIRECTORY,
    sdk: createSdk(),
    store,
    set: (patch: Partial<State>) => { store.setState(patch) },
    global: { config: {}, projects: [] },
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
  openCodeStatuses = {}
  openCodeQuestions = []
  opencodeClient.getSessionStatusForDirectory = async () => openCodeStatuses
  opencodeClient.listPendingQuestions = async () => openCodeQuestions
  opencodeClient.listPendingPermissions = async () => []
  warnings = 0
  console.warn = () => { warnings += 1 }
})

afterEach(() => {
  registerRuntimeAPIs(null)
  opencodeClient.getSessionStatusForDirectory = original.getSessionStatusForDirectory
  opencodeClient.listPendingQuestions = original.listPendingQuestions
  opencodeClient.listPendingPermissions = original.listPendingPermissions
  console.warn = originalWarn
})

describe("readDirectoryStatuses", () => {
  test("merges native statuses and decides every session", async () => {
    openCodeStatuses = { [OPENCODE]: BUSY }
    nativeStatuses = async () => ({ [NATIVE]: BUSY })

    const snapshot = await readDirectoryStatuses(DIRECTORY)

    expect(snapshot?.statuses).toEqual({ [OPENCODE]: BUSY, [NATIVE]: BUSY })
    expect(snapshot?.covers(NATIVE)).toBe(true)
    expect(snapshot?.covers(OPENCODE)).toBe(true)
  })

  test("leaves native sessions undecided when their read fails", async () => {
    openCodeStatuses = { [OPENCODE]: BUSY }
    nativeStatuses = unreadable

    const snapshot = await readDirectoryStatuses(DIRECTORY)

    expect(snapshot?.statuses).toEqual({ [OPENCODE]: BUSY })
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

    expect(store.getState().session_status[NATIVE]).toEqual(BUSY)
    expect(store.getState().question[NATIVE]?.map((item) => item.id)).toEqual(["que_native"])
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
      question: { [NATIVE]: [question("que_native", NATIVE)] },
    })

    expect(store.getState().session_status[NATIVE]).toEqual(BUSY)
    expect(store.getState().session_status[OPENCODE]).toBeUndefined()
    expect(store.getState().question[NATIVE]?.map((item) => item.id)).toEqual(["que_native"])
    const global = useGlobalSessionStatusStore.getState().statusById
    expect(global.get(NATIVE)?.status).toEqual(BUSY)
    expect(global.get(NATIVE_CODEX)?.status).toEqual(BUSY)
    expect(global.has(OPENCODE)).toBe(false)
  })
})

describe("blocking request resync with native sessions", () => {
  const heldQuestions = () => createDirectoryStore({
    session: [sessionRecord(OPENCODE), sessionRecord(NATIVE)],
    question: {
      [OPENCODE]: [question("que_opencode", OPENCODE)],
      [NATIVE]: [question("que_native", NATIVE)],
    },
  })

  test("settles OpenCode questions and keeps native ones when the native read fails", async () => {
    nativeQuestions = unreadable
    const store = heldQuestions()

    await resyncBlockingRequestsForDirectory(DIRECTORY, store)

    expect(store.getState().question[OPENCODE]).toBeUndefined()
    expect(store.getState().question[NATIVE]?.map((item) => item.id)).toEqual(["que_native"])
  })

  test("settles native questions from a successful native read", async () => {
    const store = heldQuestions()

    await resyncBlockingRequestsForDirectory(DIRECTORY, store)

    expect(store.getState().question[NATIVE]).toBeUndefined()
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
