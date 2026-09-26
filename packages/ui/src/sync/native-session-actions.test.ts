import { opencodeClient } from '@/lib/opencode/client';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Session } from "@/lib/opencode/model"

import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativeCompactRequest, NativeSessionPatch } from "@/lib/api/types"
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from "@/lib/native-agents/test-utils/runtime"
import { useConfigStore } from "@/stores/useConfigStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { ChildStoreManager } from "./child-store"
import {
  archiveSession,
  archiveSessions,
  compactNativeSession,
  deleteSession,
  patchSessionMetadata,
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
