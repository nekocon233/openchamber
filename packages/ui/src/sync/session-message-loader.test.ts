import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Part, SessionMessage } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import {
  createFirstVisibleSessionPerformanceTracker,
  startSessionLoadPerformanceEvent,
} from "./session-load-performance"

const createRecord = (
  sessionID: string,
  id = "msg_1",
  role: "user" | "assistant" = "user",
  parentID?: string,
) => ({
  info: { id, sessionID, role, ...(parentID ? { parentID } : {}), time: { created: 1 } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "hello" }] as Part[],
})

const createNextRecord = (id: string, created: number): SessionMessage => ({
  id,
  type: "user",
  text: id,
  time: { created },
} as SessionMessage)

const createNextAssistantRecord = (id: string, created: number): SessionMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model-a", providerID: "provider-a" },
  content: [{ type: "text", id: `part_${id}`, text: id }],
  time: { created, completed: created + 1 },
} as SessionMessage)

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const response = (data: ReturnType<typeof createRecord>[], cursor?: string) => ({
  data,
  response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : null } },
})

const createLoader = (messages: (input: {
  sessionID: string
  directory?: string
  limit?: number
  before?: string
}) => Promise<unknown>, loadSessionNextMessages: (params: {
  sessionID: string
  directory?: string | null
  limit?: number
  cursor?: string
}) => Promise<{ messages: SessionMessage[]; cursor?: string }> = async () => ({ messages: [] })) => {
  const childStores = new ChildStoreManager()
  const sdk = { session: { messages } } as unknown as OpencodeClient
  const loader = new SessionMessageLoader(
    childStores,
    { sdk, runtimeKey: "runtime-a" },
    loadSessionNextMessages,
  )
  return { childStores, loader }
}

describe("SessionMessageLoader", () => {
  test("deduplicates navigation and reactive loading for the same target", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return pending.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const navigation = loader.ensure(target, { reason: "navigation" })
    const reactive = loader.ensure(target, { reason: "reactive" })
    expect(calls).toBe(1)

    pending.resolve(response([createRecord(target.sessionID)]))
    await Promise.all([navigation, reactive])

    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs at most one forced load after an in-flight initial load", async () => {
    const initial = deferred<ReturnType<typeof response>>()
    const forced = deferred<ReturnType<typeof response>>()
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return calls === 1 ? initial.promise : forced.promise
    })
    const target = { directory: "/repo", sessionID: "session-forced" }

    const loading = loader.ensure(target, { reason: "reactive" })
    const firstForce = loader.ensure(target, { force: true, reason: "reactive" })
    const duplicateForce = loader.ensure(target, { force: true, reason: "reactive" })
    expect(firstForce).toBe(duplicateForce)
    expect(calls).toBe(1)

    initial.resolve(response([createRecord(target.sessionID, "msg_1")]))
    await loading
    await Promise.resolve()
    expect(calls).toBe(2)

    forced.resolve(response([createRecord(target.sessionID, "msg_2")]))
    await Promise.all([firstForce, duplicateForce])
    expect(calls).toBe(2)
    loader.dispose()
    childStores.disposeAll()
  })

  test("leaves older history loading to explicit viewport demand", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      return before
        ? response([createRecord(sessionID, "msg_older")])
        : response([createRecord(sessionID, "msg_latest")], "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { reason: "prefetch" })
    await Promise.resolve()

    expect(calls).toEqual([{ limit: 50, before: undefined }])
    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")

    await loader.loadOlder(target)

    expect(calls).toEqual([
      { limit: 50, before: undefined },
      { limit: 100, before: "older-cursor" },
    ])
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_latest", "msg_older"].sort())
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs a queued forced load after the in-flight load fails", async () => {
    const forced = deferred<ReturnType<typeof response>>()
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1
        ? { error: { message: "rejected" }, response: { status: 400 } }
        : forced.promise.then(() => response([createRecord(sessionID)]))
    })
    const target = { directory: "/repo", sessionID: "session-retry" }

    const loading = loader.ensure(target, { reason: "reactive" })
    const forcing = loader.ensure(target, { force: true, reason: "reactive" })
    await loading
    await Promise.resolve()
    expect(calls).toBe(2)

    forced.resolve(response([]))
    await forcing
    expect(loader.getSnapshot(target).status).toBe("ready")
    loader.dispose()
    childStores.disposeAll()
  })

  test("loads every history page for an explicit complete-history request", async () => {
    const calls: Array<{ before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (!before) return response([createRecord(sessionID, "msg_latest")], "cursor-2")
      if (before === "cursor-2") return response([createRecord(sessionID, "msg_middle")], "cursor-1")
      return response([createRecord(sessionID, "msg_oldest")])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadComplete(target)

    expect(calls).toEqual([
      { before: undefined },
      { before: "cursor-2" },
      { before: "cursor-1" },
    ])
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("reactivates after disposal with a new authority epoch", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const initialAuthorityEpoch = loader.getAuthorityEpoch()

    loader.dispose()
    const disposedAuthorityEpoch = loader.getAuthorityEpoch()
    expect(disposedAuthorityEpoch).toBeGreaterThan(initialAuthorityEpoch)
    childStores.disposeAll()
    const unconfigure = childStores.configure({})
    loader.activate()
    expect(loader.getAuthorityEpoch()).toBe(disposedAuthorityEpoch)
    await loader.ensure(target, { reason: "navigation" })

    expect(calls).toBe(1)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    unconfigure()
    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when its initial load fails", async () => {
    const { childStores, loader } = createLoader(async () => ({
      error: { message: "rejected" },
      response: { status: 400 },
    }))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): rejected")

    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when an older page fails", async () => {
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => before
      ? { error: { message: "older rejected" }, response: { status: 400 } }
      : response([createRecord(sessionID)], "older-cursor"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): older rejected")

    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")
    loader.dispose()
    childStores.disposeAll()
  })

  test("fetches authoritative coverage when renderable messages have no loader metadata", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached").info] },
    })

    await loader.loadComplete(target)

    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).complete).toBe(true)
    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects repeated pagination cursors instead of looping forever", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls += 1
      if (!before) return response([createRecord(sessionID, "latest")], "cursor-a")
      if (before === "cursor-a") return response([createRecord(sessionID, "middle")], "cursor-b")
      return response([createRecord(sessionID, "older")], "cursor-a")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("Session history pagination made no progress")

    expect(calls).toBe(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs a requested tail refresh after an older in-flight load", async () => {
    const initial = deferred<ReturnType<typeof response>>()
    const refresh = deferred<ReturnType<typeof response>>()
    let calls = 0
    const limits: number[] = []
    const { childStores, loader } = createLoader(async ({ limit }) => {
      calls += 1
      limits.push(limit ?? 0)
      return calls === 1 ? initial.promise : refresh.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target, { reason: "navigation" })
    const refreshing = loader.refreshTail(target, 30)
    const duplicateRefresh = loader.refreshTail(target, 80)
    expect(calls).toBe(1)
    expect(duplicateRefresh).toBe(refreshing)

    initial.resolve(response([createRecord(target.sessionID, "msg_1")]))
    await loading
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(limits).toEqual([50, 80])

    refresh.resolve(response([createRecord(target.sessionID, "msg_2")]))
    await Promise.all([refreshing, duplicateRefresh])

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_1", "msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("queues initial history behind an unresolved reconnect tail refresh", async () => {
    const tail = deferred<ReturnType<typeof response>>()
    const initial = deferred<ReturnType<typeof response>>()
    const requests: Array<{ limit?: number; before?: string }> = []
    const target = { directory: "/repo", sessionID: "session-a" }
    const user = createRecord(target.sessionID, "msg_1")
    const assistant = createRecord(target.sessionID, "msg_2", "assistant", user.info.id)
    const { childStores, loader } = createLoader(async (input) => {
      requests.push({ limit: input.limit, before: input.before })
      return requests.length === 1 ? tail.promise : initial.promise
    })

    const refreshing = loader.refreshTail(target, 30)
    const ensuring = loader.ensure(target, { reason: "navigation" })
    expect(requests).toEqual([{ limit: 30, before: undefined }])

    tail.resolve(response([assistant], "older-cursor"))
    await refreshing
    await Promise.resolve()
    expect(loader.getSnapshot(target).resolved).toBe(false)
    expect(requests).toEqual([
      { limit: 30, before: undefined },
      { limit: 50, before: undefined },
    ])

    initial.resolve(response([user, assistant]))
    await ensuring

    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_1", "msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not treat realtime-only materialization as resolved history", async () => {
    let calls = 0
    const target = { directory: "/repo", sessionID: "session-a" }
    const historical = createRecord(target.sessionID, "msg_1")
    const realtime = createRecord(target.sessionID, "msg_2")
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return response([historical])
    })
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({
      message: { [target.sessionID]: [realtime.info] },
      part: { [realtime.info.id]: realtime.parts },
    })

    await loader.ensure(target, { reason: "navigation" })

    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(store.getState().message[target.sessionID]?.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("preserves complete history coverage across a tail refresh", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1
        ? response([createRecord(sessionID, "msg_1")])
        : response([createRecord(sessionID, "msg_2")], "stale-tail-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)

    await loader.refreshTail(target, 2)

    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not deduplicate identical session IDs across directories", async () => {
    const calls: string[] = []
    const { childStores, loader } = createLoader(async ({ directory, sessionID }) => {
      calls.push(directory ?? "")
      return response([createRecord(sessionID)])
    })

    await Promise.all([
      loader.ensure({ directory: "/repo-a", sessionID: "shared" }),
      loader.ensure({ directory: "/repo-b", sessionID: "shared" }),
    ])

    expect(calls.sort()).toEqual(["/repo-a", "/repo-b"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("loads older history with the selected directory's cursor for duplicate session IDs", async () => {
    const providerDirectory = "/repo/provider"
    const selectedDirectory = "/repo/selected-worktree"
    const sessionID = "shared"
    const calls: Array<{ directory?: string; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ directory, before }) => {
      calls.push({ directory, before })
      return before
        ? response([createRecord(sessionID, `older-${directory}`)])
        : response([createRecord(sessionID, `latest-${directory}`)], `${directory}-cursor`)
    })

    await Promise.all([
      loader.ensure({ directory: providerDirectory, sessionID }),
      loader.ensure({ directory: selectedDirectory, sessionID }),
    ])
    calls.length = 0

    await loader.loadOlder({ directory: selectedDirectory, sessionID })

    expect(calls).toEqual([{
      directory: selectedDirectory,
      before: `${selectedDirectory}-cursor`,
    }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("exposes a retryable error without clearing an existing snapshot", async () => {
    let fail = true
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      if (fail) return { error: { message: "rejected" }, response: { status: 400 } }
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({ message: { [target.sessionID]: [{ id: "cached", sessionID: target.sessionID, role: "user", time: { created: 0 } } as Message] } })

    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("error")
    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(400)
    expect(store.getState().message[target.sessionID]?.[0]?.id).toBe("cached")

    fail = false
    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("ready")
    loader.dispose()
    childStores.disposeAll()
  })

  test("commits successful legacy records while exposing a retryable V2 supplement failure", async () => {
    const supplementError = new Error("V2 messages unavailable")
    const { childStores, loader } = createLoader(
      async ({ sessionID }) => response([createRecord(sessionID, "fresh-legacy")]),
      async () => {
        throw supplementError
      },
    )
    const target = { directory: "/repo", sessionID: "session-v2-failure" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({
      message: {
        [target.sessionID]: [{
          id: "cached",
          sessionID: target.sessionID,
          role: "user",
          time: { created: 0 },
        } as Message],
      },
    })

    await loader.ensure(target, { force: true })

    expect(loader.getSnapshot(target).status).toBe("error")
    expect(loader.getSnapshot(target).error).toBe(supplementError)
    expect(store.getState().message[target.sessionID]?.map((message) => message.id)).toEqual(["cached", "fresh-legacy"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("keeps an initial boundary expansion retryable when one source fails", async () => {
    const supplementError = new Error("V2 expansion unavailable")
    const target = { directory: "/repo", sessionID: "session-v2-expansion-failure" }
    const assistant = createRecord(target.sessionID, "msg_2", "assistant")
    let nextCalls = 0
    const { childStores, loader } = createLoader(
      async () => response([assistant], "legacy-older"),
      async () => {
        nextCalls += 1
        if (nextCalls === 1) return { messages: [] }
        throw supplementError
      },
    )

    await loader.ensure(target, { force: true })

    const snapshot = loader.getSnapshot(target)
    expect(snapshot.status).toBe("error")
    expect(snapshot.resolved).toBe(false)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.cursor).toBe(undefined)
    expect(snapshot.error).toBe(supplementError)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("advances legacy and V2 cursors independently until both histories are complete", async () => {
    const legacyRequests: Array<string | undefined> = []
    const nextRequests: Array<string | undefined> = []
    const target = { directory: "/repo", sessionID: "session-dual-history" }
    const { childStores, loader } = createLoader(
      async ({ before }) => {
        legacyRequests.push(before)
        return before
          ? response([createRecord(target.sessionID, "msg_1")])
          : response([createRecord(target.sessionID, "msg_3")], "legacy-older")
      },
      async ({ cursor }) => {
        nextRequests.push(cursor)
        return cursor
          ? { messages: [createNextRecord("msg_2", 2)] }
          : { messages: [createNextRecord("msg_4", 4)], cursor: "v2-older" }
      },
    )

    await loader.ensure(target, { reason: "navigation" })
    while (!loader.getSnapshot(target).complete) {
      await loader.loadOlder(target)
    }

    expect(legacyRequests).toEqual([undefined, "legacy-older"])
    expect(nextRequests).toEqual([undefined, "v2-older"])
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("links an assistant at a V2 page boundary after its older user message loads", async () => {
    const target = { directory: "/repo", sessionID: "session-v2-boundary" }
    const nextRequests: Array<string | undefined> = []
    const { childStores, loader } = createLoader(
      async () => response([]),
      async ({ cursor }) => {
        nextRequests.push(cursor)
        return cursor
          ? { messages: [createNextRecord("msg_1", 1)] }
          : { messages: [createNextAssistantRecord("msg_2", 2)], cursor: "v2-older" }
      },
    )

    await loader.ensure(target, { reason: "navigation" })
    while (!loader.getSnapshot(target).complete) {
      await loader.loadOlder(target)
    }

    const messages = childStores.getChild(target.directory)?.getState().message[target.sessionID]
    const assistant = messages?.find((message) => message.id === "msg_2")
    expect(nextRequests).toEqual([undefined, undefined, undefined, "v2-older"])
    expect(assistant?.role).toBe("assistant")
    if (assistant?.role !== "assistant") throw new Error("expected assistant")
    expect(assistant.parentID).toBe("msg_1")
    loader.dispose()
    childStores.disposeAll()
  })

  test("expands a mobile initial page when a leading assistant belongs to an older user", async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __OPENCHAMBER_SURFACE__: "mobile" } as Window & typeof globalThis,
    })

    const target = { directory: "/repo", sessionID: "session-mobile-boundary" }
    const nextRequests: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(
      async () => response([]),
      async ({ limit, cursor }) => {
        nextRequests.push({ limit, cursor })
        return limit === 30
          ? {
              messages: [
                createNextAssistantRecord("msg_2", 2),
                createNextRecord("msg_3", 3),
                createNextAssistantRecord("msg_4", 4),
              ],
              cursor: "v2-older",
            }
          : {
              messages: [
                createNextRecord("msg_1", 1),
                createNextAssistantRecord("msg_2", 2),
                createNextRecord("msg_3", 3),
                createNextAssistantRecord("msg_4", 4),
              ],
            }
      },
    )

    try {
      await loader.ensure(target, { reason: "navigation" })

      const messages = childStores.getChild(target.directory)?.getState().message[target.sessionID]
      const leadingAssistant = messages?.find((message) => message.id === "msg_2")
      expect(nextRequests).toEqual([
        { limit: 30, cursor: undefined },
        { limit: 50, cursor: undefined },
      ])
      expect(leadingAssistant?.role).toBe("assistant")
      if (leadingAssistant?.role !== "assistant") throw new Error("expected assistant")
      expect(leadingAssistant.parentID).toBe("msg_1")
      expect(loader.getSnapshot(target).complete).toBe(true)
    } finally {
      loader.dispose()
      childStores.disposeAll()
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("propagates a zero response status on SDK errors", async () => {
    const { childStores, loader } = createLoader(async () => ({
      error: { message: "network rejected" },
      response: { status: 0 },
    }))
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { force: true })

    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(0)
    loader.dispose()
    childStores.disposeAll()
  })

  test("prevents an evicted in-flight request from repopulating the store", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async () => pending.promise)
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target)
    loader.invalidateSession(target)
    pending.resolve(response([createRecord(target.sessionID)]))
    await loading

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBe(undefined)
    expect(loader.getSnapshot(target).status).toBe("idle")
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not retarget delayed retries after the loader runtime changes", async () => {
    const childStores = new ChildStoreManager()
    let oldLegacyCalls = 0
    let newLegacyCalls = 0
    let nextCalls = 0
    const newSdk = {
      session: {
        messages: async () => {
          newLegacyCalls += 1
          return response([])
        },
      },
    } as unknown as OpencodeClient
    const oldSdk = {
      session: {
        messages: async () => {
          oldLegacyCalls += 1
          loader.configure({ sdk: newSdk, runtimeKey: "runtime-b" })
          return { error: { message: "unavailable" }, response: { status: 503 } }
        },
      },
    } as unknown as OpencodeClient
    const loader = new SessionMessageLoader(
      childStores,
      { sdk: oldSdk, runtimeKey: "runtime-a" },
      async () => {
        nextCalls += 1
        return { messages: [] }
      },
    )
    const target = { directory: "/repo", sessionID: "session-runtime-switch" }

    await loader.ensure(target, { force: true })

    expect(oldLegacyCalls).toBe(1)
    expect(newLegacyCalls).toBe(0)
    expect(nextCalls).toBe(0)
    expect(loader.getSnapshot(target).status).toBe("idle")
    loader.dispose()
    childStores.disposeAll()
  })

  test("treats an empty successful response as resolved authoritative state", async () => {
    const { childStores, loader } = createLoader(async () => response([]))
    const target = { directory: "/repo", sessionID: "empty" }

    await loader.ensure(target)

    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries a missing message payload instead of treating it as an empty snapshot", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1 ? {} : response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)

    expect(calls).toBe(2)
    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("reports retries and every downloaded initial expansion record", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const diagnosticWindow = {
      location: { search: "" },
      localStorage: {
        getItem: (key: string) => key === "openchamber_session_load_perf" ? "1" : null,
      },
    } as unknown as Window
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })

    const target = { directory: "/repo", sessionID: "session-a" }
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      if (calls === 1) return {}
      if (calls === 2) {
        const assistant = createRecord(target.sessionID, "msg_assistant")
        assistant.info = { ...assistant.info, role: "assistant" } as Message
        return response([assistant], "older")
      }
      return response([createRecord(target.sessionID, "msg_user")])
    })

    try {
      await loader.ensure(target)

      const events = diagnosticWindow.__openchamberSessionLoadPerformance?.events ?? []
      const initialEvent = events.find((event) => event.operation === "session-messages.initial")
      const pageEvents = events.filter((event) => event.operation === "session-messages.page")
      expect(calls).toBe(3)
      expect(pageEvents.map((event) => event.requestLimit)).toEqual([50, 100])
      expect(pageEvents.map((event) => event.cursorPresent)).toEqual([false, false])
      expect(pageEvents.map((event) => event.recordCount)).toEqual([1, 1])
      expect(initialEvent?.outcome).toBe("complete")
      expect(initialEvent?.retryCount).toBe(1)
      expect(initialEvent?.recordCount).toBe(2)
      expect("runtimeKey" in initialEvent!).toBe(false)
      expect("directory" in initialEvent!).toBe(false)
      expect("sessionID" in initialEvent!).toBe(false)
    } finally {
      loader.dispose()
      childStores.disposeAll()
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})

describe("session load performance diagnostics", () => {
  test("rejects unknown raw labels and preserves approved input counts", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const diagnosticWindow = {
      localStorage: {
        getItem: (key: string) => key === "openchamber_session_load_perf" ? "1" : null,
      },
    } as unknown as Window
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })

    try {
      const finishUnknown = startSessionLoadPerformanceEvent({
        operation: "secret-operation",
        caller: "secret-caller",
        recordCount: 999,
      })
      finishUnknown("complete")
      const finishVisible = startSessionLoadPerformanceEvent({
        operation: "session-messages.visible",
        caller: "selected-session",
        recordCount: 30,
      })
      finishVisible("complete")

      expect(diagnosticWindow.__openchamberSessionLoadPerformance?.events).toHaveLength(1)
      const event = diagnosticWindow.__openchamberSessionLoadPerformance?.events[0]
      expect(event?.operation).toBe("session-messages.visible")
      expect(event?.caller).toBe("selected-session")
      expect(event?.recordCount).toBe(30)
      expect(JSON.stringify(diagnosticWindow.__openchamberSessionLoadPerformance)).not.toContain("secret")
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("does not schedule visibility work while diagnostics are disabled", () => {
    let requestedFrames = 0
    let visibleMarks = 0
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => false,
      requestFrame: () => {
        requestedFrames += 1
        return 1
      },
      cancelFrame: () => undefined,
      markVisible: () => {
        visibleMarks += 1
      },
    })

    tracker.schedule("session-a", 10)

    expect(requestedFrames).toBe(0)
    expect(visibleMarks).toBe(0)
  })

  test("reschedules an identity when its pending visibility frame was canceled", () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const marks: string[] = []
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => true,
      requestFrame: (callback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      },
      cancelFrame: (frame) => {
        frames.delete(frame)
      },
      markVisible: () => marks.push("visible"),
      startEvent: () => () => undefined,
    })

    const cancelFirstA = tracker.schedule("session-a", 10)
    cancelFirstA()
    const cancelB = tracker.schedule("session-b", 10)
    cancelB()
    tracker.schedule("session-a", 10)
    frames.get(3)?.(0)

    expect(marks).toEqual(["visible"])
  })

  test("does not remeasure a completed identity after another session", () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const marks: string[] = []
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => true,
      requestFrame: (callback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      },
      cancelFrame: (frame) => {
        frames.delete(frame)
      },
      markVisible: () => marks.push("visible"),
      startEvent: () => () => undefined,
    })

    tracker.schedule("session-a", 10)
    frames.get(1)?.(0)
    tracker.schedule("session-b", 10)
    frames.get(2)?.(0)
    tracker.schedule("session-a", 10)

    expect(nextFrame).toBe(2)
    expect(marks).toEqual(["visible", "visible"])
  })
})
