import { describe, expect, test } from "bun:test"
import { type Session } from "@/lib/opencode/model"

import type { NativeMessagePage } from "@/lib/api/types"
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

const SESSION = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const DIRECTORY = "/work/project"

const userRecord = (id: string, created: number): NativeMessagePage["records"][number] => ({
  info: {
    id,
    sessionID: SESSION,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "claude-native", modelID: "opus" },
  },
  parts: [{ id: `${id}_p0`, sessionID: SESSION, messageID: id, type: "text", text: id, time: { start: created, end: created } }],
})

const childSession: Session = {
  id: `${SESSION}_t_toolu_1`,
  projectID: "",
  directory: DIRECTORY,
  parentID: SESSION,
  title: "Subagent",
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 5, updated: 6 },
}

type NativeRequest = { sessionID: string; directory: string; limit: number; before?: string }

const createLoader = (loadNativeMessages: (request: NativeRequest) => Promise<NativeMessagePage>) => {
  const childStores = new ChildStoreManager()
  const openCodeCalls: string[] = []
  // Native sessions must never reach OpenCode; any request is recorded and refused.
  const sdk = { getSessionMessages: async (sessionID: string) => {
    openCodeCalls.push(sessionID)
    throw new Error("OpenCode must not be asked for a native session")
  } }
  const loader = new SessionMessageLoader(
    childStores,
    { sdk, runtimeKey: "runtime-a" },
    undefined,
    (params) => loadNativeMessages(params),
  )
  return { childStores, loader, openCodeCalls }
}

describe("SessionMessageLoader with native sessions", () => {
  test("retains measured tokens when supplemental native metadata temporarily fails", async () => {
    let available = true
    const tokens = { total: 1000, input: 200, output: 50, reasoning: 0, cache: { read: 750, write: 0 } }
    const { childStores, loader } = createLoader(async () => ({
      records: [userRecord('ncl_u_prompt', 1), {
        info: {
          id: 'ncl_a_reply', sessionID: SESSION, role: 'assistant', time: { created: 2, completed: 3 },
          parentID: 'ncl_u_prompt', modelID: available ? 'opus' : '', providerID: 'claude-native', agent: 'build', mode: 'build',
          path: { cwd: DIRECTORY, root: DIRECTORY }, cost: 0,
          tokens: available ? tokens : undefined, contextWindow: available ? 200000 : undefined,
        },
        parts: [{ id: 'ncl_p_reply', sessionID: SESSION, messageID: 'ncl_a_reply', type: 'text', text: available ? 'Before' : 'Fresh text' }],
      }], cursor: null, complete: true, childSessions: [], metadataComplete: available,
    }))
    const target = { sessionID: SESSION, directory: DIRECTORY }
    await loader.ensure(target)
    available = false
    await loader.refreshTail(target, 100)
    const state = childStores.getChild(DIRECTORY)?.getState()
    expect(state?.message[SESSION]?.find((message) => message.id === 'ncl_a_reply')).toMatchObject({ tokens, contextWindow: 200000, modelID: 'opus' })
    expect(state?.part.ncl_a_reply?.[0]).toMatchObject({ text: 'Fresh text' })
    loader.dispose()
    childStores.disposeAll()
  })
  test("reads history from the native API, pages older with its cursor and holds linked subagent sessions", async () => {
    const requests: NativeRequest[] = []
    const { childStores, loader, openCodeCalls } = createLoader(async (request) => {
      requests.push(request)
      if (request.before === "ncl_u_2") {
        return { records: [userRecord("ncl_u_1", 1)], cursor: null, complete: true, childSessions: [] }
      }
      return { records: [userRecord("ncl_u_2", 2), userRecord("ncl_u_3", 3)], cursor: "ncl_u_2", complete: false, childSessions: [childSession] }
    })
    const target = { directory: DIRECTORY, sessionID: SESSION }

    const release = loader.retainSessionHistory(target)
    await loader.ensure(target, { reason: "navigation" })
    const store = childStores.getChild(DIRECTORY)
    expect(store?.getState().message[SESSION]?.map((message) => message.id)).toEqual(["ncl_u_2", "ncl_u_3"])
    expect(store?.getState().part["ncl_u_3"]?.[0]).toMatchObject({ type: "text", text: "ncl_u_3" })
    expect(store?.getState().session.map((session) => session.id)).toEqual([childSession.id])
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", complete: false })

    await loader.loadOlder(target)
    expect(store?.getState().message[SESSION]?.map((message) => message.id)).toEqual(["ncl_u_1", "ncl_u_2", "ncl_u_3"])
    expect(loader.getSnapshot(target)).toMatchObject({ complete: true })
    expect(requests.map((request) => request.before)).toEqual([undefined, "ncl_u_2"])
    expect(openCodeCalls).toEqual([])
    release()

    loader.dispose()
    childStores.disposeAll()
  })

  test("reports a native read failure without clearing what was loaded", async () => {
    let fail = false
    const { childStores, loader } = createLoader(async () => {
      if (fail) throw new NativeAgentsRequestError("Native session not found", 404, "NATIVE_SESSION_NOT_FOUND")
      return { records: [userRecord("ncl_u_1", 1)], cursor: null, complete: true, childSessions: [] }
    })
    const target = { directory: DIRECTORY, sessionID: SESSION }

    await loader.ensure(target)
    fail = true
    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("error")
    expect(childStores.getChild(DIRECTORY)?.getState().message[SESSION]?.map((message) => message.id)).toEqual(["ncl_u_1"])

    loader.dispose()
    childStores.disposeAll()
  })
})
