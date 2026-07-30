import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

const createRecord = (
  sessionID: string,
  id = "msg_1",
  role: "user" | "assistant" = "user",
  parentID?: string,
) => ({
  info: { id, sessionID, role, ...(parentID ? { parentID } : {}), time: { created: 1 } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "hello" }] as Part[],
})

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
}) => Promise<unknown>) => {
  const childStores = new ChildStoreManager()
  const sdk = { session: { messages } } as unknown as OpencodeClient
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
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
})
