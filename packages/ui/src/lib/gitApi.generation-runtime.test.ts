import { beforeEach, describe, expect, mock, test } from "bun:test"

let runtimeKey = "runtime-a"
let runtimeGeneration = 1
let permissionChecks = 0
let promptCalls = 0

class TestRuntimeContextChangedError extends Error {
  constructor() {
    super("Runtime changed before generation fallback")
    this.name = "RuntimeContextChangedError"
  }
}

mock.module("./runtime-switch", () => ({
  getRuntimeEndpointGeneration: () => runtimeGeneration,
  getRuntimeKey: () => runtimeKey,
  RuntimeContextChangedError: TestRuntimeContextChangedError,
}))

mock.module("./runtime-fetch", () => ({
  runtimeFetch: async () => {
    runtimeGeneration += 1
    return new Response(null, { status: 404 })
  },
}))

mock.module("./magicPrompts", () => ({
  renderMagicPrompt: async (key: string) => key,
}))

mock.module("./opencode/client", () => ({
  opencodeClient: {
    withDirectory: async (_directory: string, callback: () => Promise<unknown>) => callback(),
    getApiClient: () => ({
      session: {
        prompt: async () => {
          promptCalls += 1
          return { data: null }
        },
      },
    }),
  },
}))

mock.module("@/sync/session-ui-store", () => ({
  ensurePendingDraftPermissionPolicy: async () => {
    permissionChecks += 1
  },
  materializeOpenDraftSession: async () => null,
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: "session-a",
      newSessionDraft: { open: false },
      getLastUserChoice: () => null,
    }),
  },
}))

mock.module("@/sync/selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionAgentSelection: () => null,
      getSessionModelSelection: () => ({ providerId: "provider-a", modelId: "model-a" }),
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentProviderId: "provider-a",
      currentModelId: "model-a",
      currentAgentName: "build",
      currentVariant: undefined,
    }),
  },
}))

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: () => null,
}))

const { generateCommitMessage } = await import(`./gitApi?generation-runtime-test=${Date.now()}`)

describe("git generation runtime ownership", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    runtimeGeneration = 1
    permissionChecks = 0
    promptCalls = 0
  })

  test("does not fall back into a session after the small-model request changes runtime", async () => {
    await expect(generateCommitMessage("/repo", [])).rejects.toThrow("Runtime changed before generation fallback")

    expect(permissionChecks).toBe(0)
    expect(promptCalls).toBe(0)
  })
})
