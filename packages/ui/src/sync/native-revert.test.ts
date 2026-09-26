import { opencodeClient } from '@/lib/opencode/client';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Message, type Part, type Session } from "@/lib/opencode/model"

import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativeRevertResult } from "@/lib/api/types"
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from "@/lib/native-agents/test-utils/runtime"
import { useConfigStore } from "@/stores/useConfigStore"
import { ChildStoreManager } from "./child-store"
import { useInputStore } from "./input-store"
import { forkFromMessage, revertToMessage, setActionRefs, clearStagedRevert } from "./session-actions"
import { useSessionUIStore } from "./session-ui-store"

const originalGetSession = opencodeClient.getSession;
const DIRECTORY = "/work/project"
const SESSION = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const FORK = "ncl_77777777-7777-4777-8777-777777777777"
const PROMPT_1 = "ncl_u_11111111-2f1f-4c3a-9d8e-0a7b6c5d4e3f"
const PROMPT_2 = "ncl_u_22222222-2f1f-4c3a-9d8e-0a7b6c5d4e3f"

const nativeSession = (id: string, revert?: { messageID: string }): Session => {
  const session: Session = { id, projectID: "", directory: DIRECTORY, title: "Work", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }
  if (revert) session.revert = revert
  return session
}

const userMessage = (id: string, created: number): Message => ({
  id,
  sessionID: SESSION,
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "claude-native", modelID: "opus" },
})

const textPart = (messageID: string, text: string): Part => ({ id: `${messageID}_p0`, sessionID: SESSION, messageID, type: "text", text })

let calls: Array<[string, ...Array<string | null>]> = []
let revertResult: NativeRevertResult | NativeAgentsRequestError = { session: nativeSession(SESSION), filesRestored: 0, conversationOnly: false }
let openCodeRequests: string[] = []
let childStores = new ChildStoreManager()

const store = () => {
  const child = childStores.getChild(DIRECTORY)
  if (!child) throw new Error("the test directory has no child store")
  return child
}

const sessionInStore = (id: string) => store().getState().session.find((session) => session.id === id)

// Two prompts, the session busy with the second.
const seedConversation = (revert?: { messageID: string }) => {
  store().setState({
    session: [nativeSession(SESSION, revert)],
    session_status: { [SESSION]: { type: "busy" } },
    message: { [SESSION]: [userMessage(PROMPT_1, 10), userMessage(PROMPT_2, 20)] },
    part: { [PROMPT_1]: [textPart(PROMPT_1, "first prompt")], [PROMPT_2]: [textPart(PROMPT_2, "second prompt")] },
  })
}

beforeEach(() => {
  calls = []
  revertResult = { session: nativeSession(SESSION, { messageID: PROMPT_2 }), filesRestored: 0, conversationOnly: true }
  openCodeRequests = []
  childStores = new ChildStoreManager()
  childStores.ensureChild(DIRECTORY, { bootstrap: false })
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
    revert: async (sessionId, messageId, directory) => {
      calls.push(["revert", sessionId, messageId, directory])
      if (revertResult instanceof NativeAgentsRequestError) throw revertResult
      return revertResult
    },
    unrevert: async (sessionId, directory) => {
      calls.push(["unrevert", sessionId, directory])
      return nativeSession(SESSION)
    },
    fork: async (sessionId, messageId, directory) => {
      calls.push(["fork", sessionId, messageId, directory])
      return nativeSession(FORK)
    },
  })))
  // Native sessions must never reach OpenCode; any request is recorded and refused.
  opencodeClient.getSession = async (sessionId) => {
    openCodeRequests.push(sessionId)
    throw new Error('OpenCode must not be asked about a native session')
  }
  setActionRefs(childStores, () => DIRECTORY)
  useConfigStore.setState({ isConnected: true })
  useInputStore.setState({ pendingInputText: "draft", pendingInputMode: "replace", attachedFiles: [] })
})

afterEach(() => {
  opencodeClient.getSession = originalGetSession;
  registerRuntimeAPIs(null)
  childStores.disposeAll()
})

describe("native session history actions", () => {
  test("revert through the server, which stops the turn, and keep the marker it answers with", async () => {
    seedConversation()

    expect(await revertToMessage(SESSION, PROMPT_2)).toEqual({ conversationOnly: true })

    expect(calls).toEqual([["revert", SESSION, PROMPT_2, DIRECTORY]])
    expect(sessionInStore(SESSION)?.revert).toEqual({ messageID: PROMPT_2 })
    expect(useInputStore.getState().pendingInputText).toBe("second prompt")
    expect(openCodeRequests).toEqual([])
  })

  test("roll the marker and the composer back when the CLI refuses the revert point", async () => {
    seedConversation()
    revertResult = new NativeAgentsRequestError("Claude Code cannot revert the first message of a session", 409, "NATIVE_REVERT_FIRST_MESSAGE")

    const failure = await revertToMessage(SESSION, PROMPT_1).then(() => null, (error: Error) => error)

    expect(failure).toMatchObject({ code: "NATIVE_REVERT_FIRST_MESSAGE" })
    expect(sessionInStore(SESSION)?.revert).toBeUndefined()
    expect(useInputStore.getState().pendingInputText).toBe("draft")
  })

  test("unrevert through the server and show the messages again", async () => {
    seedConversation({ messageID: PROMPT_2 })

    await clearStagedRevert(SESSION)

    expect(calls).toEqual([["unrevert", SESSION, DIRECTORY]])
    expect(sessionInStore(SESSION)?.revert).toBeUndefined()
    expect(store().getState().message[SESSION]?.map((message) => message.id)).toEqual([PROMPT_1, PROMPT_2])
    expect(openCodeRequests).toEqual([])
  })

  test("fork through the server and open the fork", async () => {
    seedConversation()

    await forkFromMessage(SESSION, PROMPT_2)

    expect(calls).toEqual([["fork", SESSION, PROMPT_2, DIRECTORY]])
    expect(sessionInStore(FORK)).toBeDefined()
    expect(useSessionUIStore.getState().currentSessionId).toBe(FORK)
    expect(openCodeRequests).toEqual([])
  })
})
