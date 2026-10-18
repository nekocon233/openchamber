import { afterEach, expect, test } from "bun:test"

import type { NativeMessagePage } from "@/lib/api/types"
import { ChildStoreManager } from "./child-store"
import { refreshNativeHistoryOnIdle } from "./native-idle-refresh"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "./session-message-loader"

const SESSION = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const CODEX = "ncx_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const DIRECTORY = "/work/project"

type NativeRequest = { sessionID: string; directory: string; limit: number; before?: string }

const page = (sessionID: string): NativeMessagePage => {
  const id = `${sessionID}_u_1`
  return {
    records: [{
      info: {
        id,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: sessionID.startsWith("ncx_") ? "codex-native" : "claude-native", modelID: "opus" },
      },
      parts: [{ id: `${id}_p0`, sessionID, messageID: id, type: "text", text: id, time: { start: 1, end: 1 } }],
    }],
    cursor: null,
    complete: true,
    childSessions: [],
  }
}

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition never became true")
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

test("refreshes loaded Claude and Codex sessions when their turn settles", async () => {
  const requests: NativeRequest[] = []
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(
    childStores,
    { sdk: { getSessionMessages: async () => { throw new Error("OpenCode must not be asked for a native session") } }, runtimeKey: "runtime-a" },
    undefined,
    async (request) => {
      requests.push(request)
      return page(request.sessionID)
    },
  )
  setImperativeSessionMessageLoader(loader)
  cleanup = () => {
    setImperativeSessionMessageLoader(null)
    loader.dispose()
    childStores.disposeAll()
  }

  await loader.ensure({ directory: DIRECTORY, sessionID: SESSION })
  expect(requests).toHaveLength(1)

  refreshNativeHistoryOnIdle(SESSION, DIRECTORY)
  await waitFor(() => requests.length === 2)
  expect(requests[1]).toMatchObject({ sessionID: SESSION, directory: DIRECTORY, limit: 30 })

  await loader.ensure({ directory: DIRECTORY, sessionID: CODEX })
  expect(requests).toHaveLength(3)
  refreshNativeHistoryOnIdle(CODEX, DIRECTORY)
  await waitFor(() => requests.length === 4)
  expect(requests[3]).toMatchObject({ sessionID: CODEX, directory: DIRECTORY, limit: 30 })

  refreshNativeHistoryOnIdle(`ncl_22222222-2222-4222-8222-222222222222`, DIRECTORY)
  refreshNativeHistoryOnIdle("ses_1", DIRECTORY)
  loader.invalidateSession({ directory: DIRECTORY, sessionID: SESSION })
  refreshNativeHistoryOnIdle(SESSION, DIRECTORY)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(requests).toHaveLength(4)
})
