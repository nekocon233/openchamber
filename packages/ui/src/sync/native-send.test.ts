import { applyDirectoryEvent } from './event-reducer'
import { translateNativeEvent } from '@/lib/native-agents/events'
import { opencodeClient } from '@/lib/opencode/client';
import { projectNativeQuestion } from '@/lib/native-agents/forms';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativePromptRequest, NativePlanExecutionChoice } from "@/lib/api/types"
import { useSelectionStore } from './selection-store';
import { CONTEXT_METADATA_KEY, type ContextPartMetadata } from "@/lib/messages/contextParts"
import { NativeAgentsRequestError } from "@/lib/native-agents/errors"
import { nativeMessagePageSchema, nativeSessionSchema, nativeStatusSnapshotSchema } from "@/lib/native-agents/schemas"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch'
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from "@/lib/native-agents/test-utils/runtime"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import type { QuestionRequest } from "@/types/question"
import { ChildStoreManager } from "./child-store"
import { isNativeLocalCommand, nativeCompactCommand, nativePromptParts, nativeSendMessageId, sendNativePrompt } from "./native-send"
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
let replies: Array<{ requestId: string; answers: string[][]; execution?: NativePlanExecutionChoice }> = []
let replyFailure: Error | null = null
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
  replyFailure = null
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
    replyQuestion: async (requestId, answers, execution) => {
      const reply: (typeof replies)[number] = { requestId, answers }
      if (execution) reply.execution = execution
      replies.push(reply)
      if (replyFailure) throw replyFailure
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

describe('manual Antigravity queued sends', () => {
  const sessionId = 'ncv_f1033b7a-88c5-4b77-bbec-6d63ec3a1188'
  const sourceSessionID = 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188'
  const busy = new NativeAgentsRequestError('The native session is still running a turn', 409, 'NATIVE_SESSION_BUSY')
  const request: NativePromptRequest = {
    directory: DIRECTORY, messageID: 'msg_captured_queue_identity', agent: 'plan', variant: 'high', preserveSelection: true,
    model: { providerID: 'antigravity-native', modelID: 'gemini-test' },
    parts: [{ type: 'text', text: 'Captured follow-up' }, { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,YQ==', filename: 'context.txt' }],
    subagentModel: null,
  }
  const session = (switchReady: boolean, backend = 'antigravity', preparing = false) => nativeSessionSchema.parse({
    id: sessionId, projectID: '', directory: DIRECTORY, title: 'Force send', time: { created: 1, updated: 2 },
    metadata: { openchamber: { native: { kind: 'unified', backend, sourceSessionID, preparing, switchReady,
      revision: 1, recordRevision: 1, historyRevision: 0 } } },
  })

  test('waits for confirmed interruption before sending the same captured payload and identity', async () => {
    const calls: string[] = []
    const sent: NativePromptRequest[] = []
    let markEntered!: () => void
    let releaseStop!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve })
    let reads = 0
    const api = createTestNativeAgentsAPI({
      prompt: async (_id, payload) => { calls.push('prompt'); sent.push(payload); if (sent.length === 1) throw busy },
      getSession: async () => { calls.push('read'); return session(++reads > 1) },
      abort: async (_id, options) => {
        expect(options).toEqual({ expectedSourceSessionId: sourceSessionID })
        calls.push('abort'); markEntered(); await stopped; return true
      },
    })
    const sending = sendNativePrompt(api, sessionId, request, true)
    await entered
    expect(calls).toEqual(['prompt', 'read', 'abort'])
    releaseStop()
    await sending
    expect(calls).toEqual(['prompt', 'read', 'abort', 'read', 'prompt'])
    expect(sent).toEqual([request, request])
    expect(sent[1]).toBe(sent[0])
  })

  test('keeps an already accepted send and ordinary queue delivery free of interruptions', async () => {
    const accepted = createTestNativeAgentsAPI({ prompt: async () => {} })
    await sendNativePrompt(accepted, sessionId, request, true)
    const automatic = createTestNativeAgentsAPI({ prompt: async () => { throw busy } })
    await expect(sendNativePrompt(automatic, sessionId, request)).rejects.toThrow(busy.message)
  })

  test('never interrupts after an ambiguous delivery failure', async () => {
    const unknown = new NativeAgentsRequestError('Delivery is unconfirmed', 502, 'NATIVE_PROMPT_OUTCOME_UNKNOWN')
    const api = createTestNativeAgentsAPI({ prompt: async () => { throw unknown } })
    await expect(sendNativePrompt(api, sessionId, request, true)).rejects.toThrow(unknown.message)
  })

  test('uses the executing backend and refuses an unknown or preparing source', async () => {
    for (const current of [session(false, 'codex'), session(false, 'antigravity', true),
      { ...session(false), metadata: {} }]) {
      const api = createTestNativeAgentsAPI({ prompt: async () => { throw busy }, getSession: async () => current })
      await expect(sendNativePrompt(api, sessionId, request, true)).rejects.toThrow(busy.message)
    }
  })

  test('a failed read or stop never dispatches the replacement', async () => {
    for (const failureAt of ['read', 'abort', 'settlement']) {
      const failure = new Error(`Failed ${failureAt}`)
      let promptCount = 0
      let reads = 0
      const api = createTestNativeAgentsAPI({
        prompt: async () => { promptCount++; throw busy },
        getSession: async () => {
          if (failureAt === 'read' || ++reads > 1 && failureAt === 'settlement') throw failure
          return session(false)
        },
        abort: async () => { if (failureAt === 'abort') throw failure; return true },
      })
      await expect(sendNativePrompt(api, sessionId, request, true)).rejects.toThrow(failure.message)
      expect(promptCount).toBe(1)
    }
  })

  test('a source that remains busy or changes ownership blocks replacement delivery', async () => {
    for (const after of [session(false), { ...session(true), metadata: { openchamber: { native: {
      kind: 'unified', backend: 'antigravity', sourceSessionID: 'nag_other', preparing: false, switchReady: true,
      revision: 2, recordRevision: 2, historyRevision: 0,
    } } } }]) {
      let reads = 0
      const api = createTestNativeAgentsAPI({ prompt: async () => { throw busy },
        getSession: async () => ++reads === 1 ? session(false) : after, abort: async () => true })
      await expect(sendNativePrompt(api, sessionId, request, true)).rejects.toThrow(busy.message)
    }
  })

  test('standalone AGY sends also require authoritative idle after interruption', async () => {
    for (const remainsBusy of [false, true]) {
      let promptCount = 0
      const api = createTestNativeAgentsAPI({
        prompt: async () => { if (++promptCount === 1) throw busy },
        getSession: async () => ({ ...session(false), id: sourceSessionID, metadata: {} }),
        abort: async () => false,
        statuses: async () => nativeStatusSnapshotSchema.parse(remainsBusy ? { [sourceSessionID]: { type: 'busy' } } : {}),
      })
      const sending = sendNativePrompt(api, sourceSessionID, request, true)
      if (remainsBusy) await expect(sending).rejects.toThrow(busy.message)
      else await sending
      expect(promptCount).toBe(remainsBusy ? 1 : 2)
    }
  })

  test('a runtime switch during a read or stop prevents further writes', async () => {
    const previousFetch = globalThis.fetch
    const apiBaseUrl = getRuntimeApiBaseUrl()
    const runtimeKey = getRuntimeKey()
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: () => {} })
    try {
      for (const switchAt of ['read', 'abort', 'settlement']) {
        let promptCount = 0
        let abortCount = 0
        let reads = 0
        const changeRuntime = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://force-send.invalid', runtimeKey: `switched-${switchAt}` })
        const api = createTestNativeAgentsAPI({
          prompt: async () => { promptCount++; throw busy },
          getSession: async () => { reads++; if (switchAt === 'read' || reads > 1 && switchAt === 'settlement') changeRuntime(); return session(reads > 1) },
          abort: async () => { abortCount++; if (switchAt === 'abort') changeRuntime(); return true },
        })
        await expect(sendNativePrompt(api, sessionId, request, true)).rejects.toThrow('Runtime changed')
        expect(promptCount).toBe(1)
        expect(abortCount).toBe(switchAt === 'read' ? 0 : 1)
        switchRuntimeEndpoint({ apiBaseUrl, runtimeKey })
      }
    } finally {
      switchRuntimeEndpoint({ apiBaseUrl, runtimeKey })
      globalThis.fetch = previousFetch
    }
  })
})

describe("routeMessage for native sessions", () => {
  test('only explicit manual delivery enables the AGY interruption flow', async () => {
    const calls: string[] = []
    let sends = 0
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
      prompt: async () => { calls.push('prompt'); if (++sends === 1) throw new NativeAgentsRequestError('Busy', 409, 'NATIVE_SESSION_BUSY') },
      getSession: async (id) => nativeSessionSchema.parse({ id, projectID: '', directory: DIRECTORY, title: 'AGY', time: { created: 1, updated: 2 } }),
      abort: async () => { calls.push('abort'); return true }, statuses: async () => ({}),
    })))
    await routeMessage({ sessionId: 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188', directory: DIRECTORY,
      content: 'Force this follow-up', providerID: 'antigravity-native', modelID: 'gemini-test', agent: 'build', interruptAntigravity: true })
    expect(calls).toEqual(['prompt', 'abort', 'prompt'])
    expect(optimisticAdds).toHaveLength(1)
  })
  test('forwards a queued native subagent snapshot without replacing an explicit CLI default', async () => {
    const subagentModel: NonNullable<NativePromptRequest['subagentModel']> = { model: { providerID: 'codex-native', modelID: 'gpt-test' }, variant: 'max' };
    await routeMessage({ sessionId: SESSION, directory: DIRECTORY, content: 'Queued task', providerID: 'claude-native', modelID: 'opus', agent: 'build', subagentModel });
    await routeMessage({ sessionId: SESSION, directory: DIRECTORY, content: 'CLI default', providerID: 'claude-native', modelID: 'opus', agent: 'build', subagentModel: null });
    expect(prompts[0].request.subagentModel).toEqual(subagentModel);
    expect(prompts[1].request.subagentModel).toBeNull();
  });
  test('an unsupported Antigravity agent cannot silently become build', async () => {
    await expect(routeMessage({
      sessionId: 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
      directory: DIRECTORY,
      content: 'Inspect only',
      providerID: 'antigravity-native',
      modelID: 'gemini-3.8-flash-medium',
      agent: 'Plan - Gemini',
    })).rejects.toBeInstanceOf(NativeAgentsRequestError)
    expect(prompts).toHaveLength(0)
    expect(openCodeRequests).toEqual([])
  })

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

  test("Antigravity preserves the chosen plan mode with a nag message id", async () => {
    const sessionId = 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188'
    const route = await routeMessage({
      sessionId,
      directory: DIRECTORY,
      content: 'Fix the tests',
      providerID: 'antigravity-native',
      modelID: 'gemini-3-pro',
      agent: 'plan',
    })
    expect(route).toBe('prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].request.agent).toBe('plan')
    expect(prompts[0].request.messageID.startsWith('nag_u_')).toBe(true)
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
  test('applies an execution model only after approval is accepted and keeps other composers unchanged', async () => {
    const store = childStores.getChild(DIRECTORY)
    store?.setState({ form: { [SESSION]: [form('ncq_model')] } })
    useSessionUIStore.setState({ currentSessionId: null })
    const selection = useSelectionStore.getState()
    selection.saveSessionModelSelection(SESSION, 'claude-native', 'opus')
    selection.saveSessionAgentSelection(SESSION, 'plan')
    const configBefore = useConfigStore.getState().currentModelId
    const execution = { model: { providerID: 'claude-native', modelID: 'sonnet' }, variant: 'max' }
    replyFailure = new NativeAgentsRequestError('offline', 503, 'NATIVE_CLI_MISSING')
    await expect(replyToForm(SESSION, 'ncq_model', { 'question-0': 'build' }, execution)).rejects.toThrow('offline')
    expect(useSelectionStore.getState().getSessionModelSelection(SESSION)?.modelId).toBe('opus')
    replyFailure = null
    await replyToForm(SESSION, 'ncq_model', { 'question-0': 'build' }, execution)
    expect(replies.at(-1)?.execution).toEqual(execution)
    expect(useSelectionStore.getState().getSessionModelSelection(SESSION)).toEqual({ providerId: 'claude-native', modelId: 'sonnet' })
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBe('build')
    expect(useSelectionStore.getState().getAgentModelVariantForSession(SESSION, 'build', 'claude-native', 'sonnet')).toBe('max')
    expect(useConfigStore.getState().currentModelId).toBe(configBefore)
    expect(openCodeRequests).toEqual([])
  })

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

  test("keep an Antigravity plan question after failed delivery so the same answer can be retried", async () => {
    const sessionID = 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188'
    const request = projectNativeQuestion({
      id: 'ncq_agy_plan', sessionID, kind: 'antigravity-plan-exit',
      questions: [{ header: 'Plan', question: 'Review the plan', options: [
        { label: 'build', description: '' }, { label: 'plan', description: '' },
      ] }],
    })
    if (!request) throw new Error('Missing Antigravity plan form')
    const store = childStores.getChild(DIRECTORY)
    store?.setState({ form: { [sessionID]: [request] } })
    replyFailure = new NativeAgentsRequestError('Failed to start the next turn', 503, 'NATIVE_CLI_MISSING')
    await expect(replyToForm(sessionID, request.id, { 'question-0': 'build' })).rejects.toThrow('Failed to start the next turn')
    expect(store?.getState().form[sessionID]).toEqual([request])
    expect(prompts).toEqual([])
    replyFailure = null
    await replyToForm(sessionID, request.id, { 'question-0': 'build' })
    expect(store?.getState().form[sessionID] ?? []).toEqual([])
    expect(replies).toEqual([
      { requestId: request.id, answers: [['build']] }, { requestId: request.id, answers: [['build']] },
    ])
    expect(openCodeRequests).toEqual([])
  })
})
