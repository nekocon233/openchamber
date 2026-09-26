import { applyDirectoryEvent } from './event-reducer'
import { translateNativeEvent } from '@/lib/native-agents/events'
import { opencodeClient } from '@/lib/opencode/client';
import { projectNativeQuestion } from '@/lib/native-agents/forms';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativePromptRequest } from "@/lib/api/types"
import { CONTEXT_METADATA_KEY, type ContextPartMetadata } from "@/lib/messages/contextParts"
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { nativeMessagePageSchema } from "@/lib/native-agents/schemas"
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from "@/lib/native-agents/test-utils/runtime"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import type { QuestionRequest } from "@/types/question"
import { ChildStoreManager } from "./child-store"
import { isNativeLocalCommand, nativeCompactCommand, nativePromptParts, nativeSendMessageId } from "./native-send"
import {
  abortCurrentOperation,
  cancelForm,
  replyToForm,
  setActionRefs,
  setOptimisticRefs,
} from "./session-actions"
import { routeMessage, useSessionUIStore } from "./session-ui-store"

const originalGetSession = opencodeClient.getSession;
const DIRECTORY = "/work/project"
const SESSION = "ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188"
const CONTEXT_METADATA: ContextPartMetadata = {
  [CONTEXT_METADATA_KEY]: { kind: "linear-issue", identifier: "ENG-12", title: "Crash on start", url: "https://linear.app/x/issue/ENG-12" },
}

type OptimisticAddInput = Parameters<Parameters<typeof setOptimisticRefs>[0]>[0]

const question = (id: string, sessionID = SESSION): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Go" }] }],
})

const form = (id: string, sessionID = SESSION) => {
  const request = projectNativeQuestion(question(id, sessionID));
  if (!request) throw new Error('The fixture needs a question');
  return request;
};

let prompts: Array<{ sessionId: string; request: NativePromptRequest }> = []
// What the next prompt throws, and the history a later read returns.
let promptFailure: ((request: NativePromptRequest) => Error) | null = null
let nativeHistory: unknown[] = []
let aborts: string[] = []
let replies: Array<{ requestId: string; answers: string[][] }> = []
let rejectGone = false
let openCodeRequests: string[] = []
let optimisticAdds: OptimisticAddInput[] = []
let metadataPatches: Array<{ sessionId: string; metadata: unknown }> = []
let childStores = new ChildStoreManager()

beforeEach(() => {
  prompts = []
  promptFailure = null
  nativeHistory = []
  useSessionGoalArmStore.setState({ armed: false, objectiveOverride: null })
  aborts = []
  replies = []
  rejectGone = false
  openCodeRequests = []
  optimisticAdds = []
  metadataPatches = []
  childStores = new ChildStoreManager()
  childStores.ensureChild(DIRECTORY, { bootstrap: false })
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
    prompt: async (sessionId, request) => {
      prompts.push({ sessionId, request })
      if (promptFailure) throw promptFailure(request)
    },
    loadMessages: async () => nativeMessagePageSchema.parse({ records: nativeHistory, cursor: null, complete: true, childSessions: [] }),
    getSession: async (sessionId) => ({ id: sessionId, projectID: "", directory: DIRECTORY, title: "Work", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }),
    updateSession: async (sessionId, directory, patch) => {
      metadataPatches.push({ sessionId, metadata: patch.metadata })
      return { id: sessionId, projectID: "", directory, title: "Work", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 3 }, metadata: patch.metadata }
    },
    abort: async (sessionId) => {
      aborts.push(sessionId)
      return true
    },
    replyQuestion: async (requestId, answers) => {
      replies.push({ requestId, answers })
    },
    rejectQuestion: async () => {
      if (rejectGone) throw new NativeAgentsRequestError("No pending native question", 404, "NATIVE_QUESTION_NOT_FOUND")
    },
  })))
  // Native sessions must never reach OpenCode; any request is recorded and refused.
  opencodeClient.getSession = async (sessionId) => {
    openCodeRequests.push(sessionId)
    throw new Error('OpenCode must not be asked about a native session')
  }
  setActionRefs(childStores, () => DIRECTORY)
  setOptimisticRefs((input) => {
    optimisticAdds.push(input)
  }, () => {})
  useConfigStore.setState({ isConnected: true })
})

afterEach(() => {
  opencodeClient.getSession = originalGetSession;
  registerRuntimeAPIs(null)
  childStores.disposeAll()
})

describe("native prompt parts", () => {
  test("keep what the user wrote and attached, and leave OpenChamber's own context out", () => {
    const file = { type: "file" as const, mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" }
    expect(nativePromptParts("Fix it", [file], [
      { text: "Pinned notes", synthetic: true, systemContext: "session-knowledge" },
      { text: "Respond briefly", synthetic: true },
      { text: "Issue #12: crash on start", synthetic: true, metadata: CONTEXT_METADATA, files: [file] },
    ])).toEqual([
      { type: "text", text: "Fix it" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
      { type: "text", text: "Issue #12: crash on start" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
    ])
  })

  test("keep only undo, redo, timeline, btw and handoff-review as the composer's own commands", () => {
    expect(["undo", "redo", "timeline", "btw", "handoff-review"].every(isNativeLocalCommand)).toBe(true)
    expect(["summary", "debug", "explore", "review", "init", "compact"].some(isNativeLocalCommand)).toBe(false)
  })

  test("recognize /compact and its summary instructions, and nothing else", () => {
    expect(nativeCompactCommand("/compact")).toEqual({})
    expect(nativeCompactCommand("  /compact   keep the plan  ")).toEqual({ instructions: "keep the plan" })
    expect(nativeCompactCommand("/compact\nfocus on the tests")).toEqual({ instructions: "focus on the tests" })
    expect(nativeCompactCommand("/compaction")).toBeNull()
    expect(nativeCompactCommand("please /compact")).toBeNull()
  })

  test("use the caller's message id only when the CLI can record it", () => {
    const requested = "ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f"
    expect(nativeSendMessageId(SESSION, requested)).toBe(requested)
    expect(/^ncl_u_[0-9a-f-]{36}$/.test(nativeSendMessageId(SESSION, "msg_0198b4f3c001AbCdEfGhIjKlMn"))).toBe(true)
    expect(nativeSendMessageId(SESSION, undefined).startsWith("ncl_u_")).toBe(true)
    expect(() => nativeSendMessageId("ses_opencode", undefined)).toThrow("Not a native session")
  })
})

describe("routeMessage for native sessions", () => {
  test("sends slash commands as typed, with the optimistic message's id", async () => {
    const route = await routeMessage({
      sessionId: SESSION,
      directory: DIRECTORY,
      content: "/compact keep the plan",
      providerID: "claude-native",
      modelID: "opus",
      agent: "plan",
      variant: "high",
      additionalParts: [{ text: "Pinned notes", synthetic: true, systemContext: "session-knowledge" }],
    })

    expect(route).toBe("prompt")
    expect(prompts).toHaveLength(1)
    const [{ sessionId, request }] = prompts
    expect(sessionId).toBe(SESSION)
    const { messageID, ...sent } = request
    expect(messageID.startsWith("ncl_u_")).toBe(true)
    expect(sent).toEqual({
      directory: DIRECTORY,
      parts: [{ type: "text", text: "/compact keep the plan" }],
      model: { providerID: "claude-native", modelID: "opus" },
      variant: "high",
      agent: "plan",
    })
    expect(optimisticAdds.map((add) => add.message.id)).toEqual([messageID])
    expect(openCodeRequests).toEqual([])
  })

  test("a native text and attachment echo replace their optimistic parts", async () => {
    await routeMessage({ sessionId: SESSION, directory: DIRECTORY, content: "Look at this", providerID: "claude-native", modelID: "opus", files: [
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
    ] })
    const added = optimisticAdds[0]
    const store = childStores.getChild(DIRECTORY)
    if (!added || !store) throw new Error("Missing optimistic native message")
    const state = { ...store.getState(), message: { [SESSION]: [added.message] }, part: { [added.message.id]: added.parts } }
    const echoParts = [
      { id: `${added.message.id}_p0`, sessionID: SESSION, messageID: added.message.id, type: "text", text: "Look at this" },
      { id: `${added.message.id}_f0`, sessionID: SESSION, messageID: added.message.id, type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
    ]
    for (const part of echoParts) {
      const event = translateNativeEvent({ type: "message.part.updated", properties: { part } })
      if (!event) throw new Error("Invalid native echo fixture")
      applyDirectoryEvent(state, event)
    }
    expect(state.part[added.message.id]).toHaveLength(2)
    expect(state.part[added.message.id].map((part) => part.id)).toEqual(echoParts.map((part) => part.id))
  })

  test("sends a feature's instructions once, apart from what the user wrote", async () => {
    const boundary = { text: "You are in a btw session.", synthetic: true, systemContext: "feature-instructions" as const }
    await routeMessage({
      sessionId: SESSION,
      directory: DIRECTORY,
      content: "What is Kafka?",
      providerID: "claude-native",
      modelID: "opus",
      agent: "build",
      additionalParts: [boundary, boundary],
    })

    expect(prompts).toHaveLength(1)
    const [{ request }] = prompts
    expect(request.parts).toEqual([{ type: "text", text: "What is Kafka?" }])
    expect(request.instructions).toBe("You are in a btw session.")
  })

  test("runs any agent other than plan as the build agent", async () => {
    await routeMessage({ sessionId: SESSION, directory: DIRECTORY, content: "Go", providerID: "claude-native", modelID: "opus", agent: "review" })
    expect(prompts[0].request.agent).toBe("build")
  })

  test("refuses shell mode before anything is sent", async () => {
    await expect(routeMessage({
      sessionId: SESSION,
      directory: DIRECTORY,
      content: "ls",
      providerID: "claude-native",
      modelID: "opus",
      inputMode: "shell",
    })).rejects.toThrow("Shell mode is not available")
    expect(prompts).toEqual([])
    expect(optimisticAdds).toEqual([])
  })
})

describe("native send failures", () => {
  test("show a refusal the server explains at once instead of waiting to confirm the send", async () => {
    promptFailure = () => new NativeAgentsRequestError("The claude CLI was not found on this machine's PATH", 503, "NATIVE_CLI_MISSING")
    const failure = await routeMessage({ sessionId: SESSION, directory: DIRECTORY, content: "Go", providerID: "claude-native", modelID: "opus", agent: "build" })
      .then(() => null, (error: Error) => error)
    expect(failure).toMatchObject({ code: "NATIVE_CLI_MISSING", message: "The claude CLI was not found on this machine's PATH" })
    expect(openCodeRequests).toEqual([])
  })

  test("confirm a send whose answer was lost from the native history", async () => {
    promptFailure = (request) => {
      nativeHistory = [{
        info: { id: request.messageID, sessionID: SESSION, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "claude-native", modelID: "opus" } },
        parts: [{ id: `${request.messageID}_p0`, sessionID: SESSION, messageID: request.messageID, type: "text", text: "Go" }],
      }]
      return new TypeError("Failed to fetch")
    }
    await routeMessage({ sessionId: SESSION, directory: DIRECTORY, content: "Go", providerID: "claude-native", modelID: "opus", agent: "build" })
    expect(prompts).toHaveLength(1)
    expect(openCodeRequests).toEqual([])
  })

  test("start an armed goal on a native session, telling the CLI through instructions", async () => {
    useSessionGoalArmStore.getState().setArmed(true)

    await useSessionUIStore.getState().sendMessage("Ship the release", "claude-native", "opus", "build", [], undefined, undefined, undefined, "normal", { sessionId: SESSION, directory: DIRECTORY })

    expect(useSessionGoalArmStore.getState().armed).toBe(false)
    expect(prompts[0]?.request.parts).toEqual([{ type: "text", text: "Ship the release" }])
    expect(prompts[0]?.request.instructions).toContain("Goal mode is active for this session.")
    expect(metadataPatches).toHaveLength(1)
    expect(metadataPatches[0]).toMatchObject({ sessionId: SESSION, metadata: { openchamber: { goal: { status: "active", objective: "Ship the release" } } } })
    expect(openCodeRequests).toEqual([])
  })
})

describe("session actions for native sessions", () => {
  test("abort the running turn through the native API", async () => {
    await abortCurrentOperation(SESSION)
    expect(aborts).toEqual([SESSION])
    expect(openCodeRequests).toEqual([])
  })

  test("answer a question through the native API and clear it locally", async () => {
    const store = childStores.getChild(DIRECTORY)
    store?.setState({ form: { [SESSION]: [form("ncq_1")] } })
    await replyToForm(SESSION, "ncq_1", { "question-0": "Yes" })
    expect(replies).toEqual([{ requestId: "ncq_1", answers: [["Yes"]] }])
    expect(store?.getState().form[SESSION] ?? []).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("clear a question the CLI no longer waits on, and still report it", async () => {
    const store = childStores.getChild(DIRECTORY)
    store?.setState({ form: { [SESSION]: [form("ncq_2")] } })
    rejectGone = true
    const failure = await cancelForm(SESSION, "ncq_2").then(() => null, (error: Error) => error)
    expect(failure).toMatchObject({ code: "NATIVE_QUESTION_NOT_FOUND" })
    expect(store?.getState().form[SESSION] ?? []).toEqual([])
  })
})
