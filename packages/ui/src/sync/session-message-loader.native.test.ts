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

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition never became true")
}

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

  test("reports a loaded transcript without allocating one for an unopened session", async () => {
    const { childStores, loader } = createLoader(async () => ({
      records: [userRecord("ncl_u_1", 1)], cursor: null, complete: true, childSessions: [],
    }))
    const target = { directory: DIRECTORY, sessionID: SESSION }
    expect(loader.hasLoaded(target)).toBe(false)
    await loader.ensure(target)
    expect(loader.hasLoaded(target)).toBe(true)
    expect(loader.hasLoaded({ directory: DIRECTORY, sessionID: "ncl_22222222-2222-4222-8222-222222222222" })).toBe(false)
    loader.invalidateSession(target)
    expect(loader.hasLoaded(target)).toBe(false)

    loader.dispose()
    childStores.disposeAll()
  })

  test("refreshes a subscribed transcript immediately when history becomes stale", async () => {
    const requests: NativeRequest[] = []
    const { childStores, loader } = createLoader(async (request) => {
      requests.push(request)
      return { records: [userRecord("ncl_u_1", 1)], cursor: null, complete: true, childSessions: [] }
    })
    const target = { directory: DIRECTORY, sessionID: SESSION }
    await loader.ensure(target)

    let notified = 0
    const unsubscribe = loader.subscribe(target, () => { notified += 1 })
    loader.markHistoryStale()
    expect(notified).toBeGreaterThan(0)
    await waitFor(() => requests.length >= 2)
    expect(loader.revalidateIfStale(target)).toBe(false)

    const before = requests.length
    const unloaded = { directory: DIRECTORY, sessionID: "ncl_22222222-2222-4222-8222-222222222222" }
    expect(loader.revalidateIfStale(unloaded)).toBe(false)
    expect(requests).toHaveLength(before)

    unsubscribe()
    loader.dispose()
    childStores.disposeAll()
  })

  test("defers a stale transcript until its first subscriber attaches", async () => {
    const requests: NativeRequest[] = []
    const { childStores, loader } = createLoader(async (request) => {
      requests.push(request)
      return { records: [userRecord("ncl_u_1", 1)], cursor: null, complete: true, childSessions: [] }
    })
    const target = { directory: DIRECTORY, sessionID: SESSION }
    await loader.ensure(target)
    expect(requests).toHaveLength(1)

    loader.markHistoryStale()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toHaveLength(1)

    const unsubscribe = loader.subscribe(target, () => undefined)
    await waitFor(() => requests.length >= 2)

    unsubscribe()
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

describe('DeepSeek paged history revisions', () => {
  const id = `ndh_${'d'.repeat(64)}`;
  const target = { directory: DIRECTORY, sessionID: id };
  const record = (messageID: string, created: number): NativeMessagePage['records'][number] => ({
    info: { id: messageID, sessionID: id, role: 'user', time: { created }, agent: 'build', model: { providerID: 'deepseek-native', modelID: 'test' } },
    parts: [{ id: `${messageID}_p0`, sessionID: id, messageID, type: 'text', text: messageID }],
  });
  test('replaces discarded messages after a missed commit event, including a complete replacement page', async () => {
    let revision = 0;
    const { childStores, loader } = createLoader(async () => ({ historyRevision: revision,
      records: revision === 0 ? [record('kept', 1), record('discarded', 2)] : [record('kept', 1), record('replacement', 3)],
      cursor: null, complete: true, childSessions: [],
    }));
    await loader.ensure(target);
    revision = 1;
    await loader.refreshTail(target, 100);
    expect(childStores.getChild(DIRECTORY)?.getState().message[id].map((message) => message.id)).toEqual(['kept', 'replacement']);
    expect(childStores.getChild(DIRECTORY)?.getState().part.discarded).toBeUndefined();
    loader.dispose();
  });
  test('loads the latest branch when pagination discovers a fork instead of prepending it to the old tail', async () => {
    let revision = 0;
    const requests: NativeRequest[] = [];
    const { childStores, loader } = createLoader(async (request) => {
      requests.push(request);
      return {
        historyRevision: revision,
        records: request.before ? [record('older', 0)] : revision === 0
          ? [1, 2, 3, 4].map((value) => record(`old-${value}`, value))
          : [1, 2, 3, 4].map((value) => record(`new-${value}`, value + 10)),
        cursor: request.before ? null : `cursor-${revision}`, complete: Boolean(request.before), childSessions: [],
      };
    });
    const release = loader.retainSessionHistory(target);
    await loader.ensure(target);
    revision = 1;
    await loader.loadOlder(target);
    expect(childStores.getChild(DIRECTORY)?.getState().message[id].map((message) => message.id)).toEqual(['new-1', 'new-2', 'new-3', 'new-4']);
    expect(requests.at(-1)?.before).toBeUndefined();
    expect(loader.getSnapshot(target).cursor).toBe('cursor-1');
    release(); loader.dispose();
  });
  test('restarts a mixed initial window rather than joining pages from two branches', async () => {
    let calls = 0;
    const { childStores, loader } = createLoader(async () => {
      calls += 1;
      if (calls === 1) return { records: [record('old-tail', 2)], cursor: 'old-prefix', complete: false, childSessions: [], historyRevision: 0 };
      if (calls === 2) return { records: [record('new-prefix', 1)], cursor: null, complete: true, childSessions: [], historyRevision: 1 };
      return { records: [record('new-prefix', 1), record('new-tail', 3)], cursor: null, complete: true, childSessions: [], historyRevision: 1 };
    });
    await loader.ensure(target);
    expect(childStores.getChild(DIRECTORY)?.getState().message[id].map((message) => message.id)).toEqual(['new-prefix', 'new-tail']);
    loader.dispose();
  });
});
