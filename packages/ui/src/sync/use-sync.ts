import type { State } from "./types"
import { useCallback, useMemo } from "react"
import type { Message, Part } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { Binary } from "./binary"
import { upsertSessionRecord } from "./session-records"
import { retry } from "./retry"
import {
  useChildStoreManager,
  useDirectoryStore,
  useSessionMessageLoader,
  useSyncDirectory,
  useSyncRuntime,
  resyncBlockingRequestsForDirectory,
  buildSessionMessageRecordsSnapshot,
  recoverInterruptedTurnAfterMessageLoad,
} from "./sync-context"
import { stripSessionDiffSnapshots } from "./sanitize"
import { getSessionMaterializationStatus } from "./materialization"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { isNativeSessionId } from "@/lib/native-agents/ids"
import { readNativeSession } from "./native-directory-snapshots"
import type { SessionMessageLoader } from "./session-message-loader"

// Shared across useSync() hook instances. Chat, model controls, and sidebar can
// all request the same session during startup; coalesce them into one HTTP load.
type SyncSessionInflight = {
  owner: SessionMessageLoader
  authorityEpoch: number
  promise: Promise<void>
  force: boolean
  forcedFollowUp: Promise<void> | null
}
const syncSessionInflightByKey = new Map<string, SyncSessionInflight>()

// Per-session generation counter. When a newer syncSession request starts for
// the same session, older in-flight requests become stale and must not write
// to the store. This prevents rapid session switches (e.g. 1→2→3 in the
// sidebar) from having each completed fetch fight for focus.
const syncSessionGenerationByKey = new Map<string, number>()

export function shouldReuseSyncSessionInflight(
  existing: Pick<SyncSessionInflight, "owner" | "authorityEpoch"> | undefined,
  owner: SessionMessageLoader,
  authorityEpoch: number,
): boolean {
  return Boolean(existing && existing.owner === owner && existing.authorityEpoch === authorityEpoch)
}

export function queueForcedSyncSessionFollowUp(
  existing: Pick<SyncSessionInflight, "promise" | "force" | "forcedFollowUp">,
  isCurrent: () => boolean,
  run: () => Promise<void>,
): Promise<void> {
  if (existing.force) return existing.promise
  if (existing.forcedFollowUp) return existing.forcedFollowUp
  const followUp = existing.promise.then(() => {
    if (!isCurrent()) return
    return run()
  })
  existing.forcedFollowUp = followUp
  return followUp
}

const isUserMessage = (message: Message): boolean => message.role === "user"

export function hasUserMessage(messages: Message[] | undefined): boolean {
  return Boolean(messages?.some(isUserMessage))
}

export function shouldFetchSessionForRenderableSync(input: {
  hasSession: boolean
  shouldLoadMessages: boolean
  force?: boolean
}): boolean {
  return Boolean(input.force) || !input.hasSession || input.shouldLoadMessages
}

export function canCommitSessionDetailLoad(
  state: Pick<State, "sessionEventRevision" | "sessionDeletedRevision">,
  sessionID: string,
  baselineRevision: number,
): boolean {
  return (state.sessionEventRevision?.[sessionID] ?? 0) <= baselineRevision
    && (state.sessionDeletedRevision?.[sessionID] ?? 0) <= baselineRevision
}

// ---------------------------------------------------------------------------
// useSync — message loading, pagination, optimistic updates
// ---------------------------------------------------------------------------

function useSessionCacheTouch() {
  const { messageLoader, runtimeKey } = useSyncRuntime()
  return useCallback((sessionID: string, directory: string) => {
    if (getRuntimeKey() !== runtimeKey) return
    messageLoader.touchSessionCache({ directory, sessionID })
  }, [messageLoader, runtimeKey])
}

export function useSync() {
  const directory = useSyncDirectory()
  const store = useDirectoryStore()
  const childStores = useChildStoreManager()
  const messageLoader = useSessionMessageLoader()
  const runtimeKey = getRuntimeKey()
  const touch = useSessionCacheTouch()

  const recoverPendingQuestions = useCallback(
    async (sessionID: string, directoryOverride?: string): Promise<boolean> => {
      const targetDirectory = directoryOverride || directory
      if (!sessionID || !targetDirectory || getRuntimeKey() !== runtimeKey) return false
      const targetStore = childStores.ensureChild(targetDirectory, {
        priority: "selected",
        reason: "selected-session",
      })
      await resyncBlockingRequestsForDirectory(targetDirectory, targetStore, [sessionID], {
        includePermissions: false,
      })
      if (getRuntimeKey() !== runtimeKey) return false
      return (targetStore.getState().form[sessionID]?.length ?? 0) > 0
    },
    [childStores, directory, runtimeKey],
  )

  const keyFor = useCallback(
    (sessionID: string, directoryOverride = directory) => `${runtimeKey}\n${directoryOverride}\n${sessionID}`,
    [directory, runtimeKey],
  )

  // Sync a session (load if not cached)
  const syncSession = useCallback(
    async function syncSession(
      sessionID: string,
      force?: boolean,
      directoryOverride?: string,
    ): Promise<void> {
      if (getRuntimeKey() !== runtimeKey) return
      const targetDirectory = directoryOverride || directory
      touch(sessionID, targetDirectory)
      const key = keyFor(sessionID, targetDirectory)
      const authorityEpoch = messageLoader.getAuthorityEpoch()

      // Dedup inflight requests
      const existing = syncSessionInflightByKey.get(key)
      if (existing && shouldReuseSyncSessionInflight(existing, messageLoader, authorityEpoch)) {
        if (!force) return existing.promise
        return queueForcedSyncSessionFollowUp(
          existing,
          () => getRuntimeKey() === runtimeKey && messageLoader.getAuthorityEpoch() === authorityEpoch,
          () => syncSession(sessionID, true, targetDirectory),
        )
      }

      // This is a new request. Bump generation so any older request that
      // might still be finishing (e.g. from a previous component lifecycle)
      // knows it is stale and should not write to the store.
      const generation = (syncSessionGenerationByKey.get(key) ?? 0) + 1
      syncSessionGenerationByKey.set(key, generation)

      const targetStore = targetDirectory === directory
        ? store
        : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const isStale = () => getRuntimeKey() !== runtimeKey
        || messageLoader.getAuthorityEpoch() !== authorityEpoch
        || syncSessionGenerationByKey.get(key) !== generation
        || childStores.children.get(targetDirectory) !== targetStore
      const current = targetStore.getState()
      const baselineSessionRevision = current.sessionRevision ?? 0
      const materialization = getSessionMaterializationStatus(current, sessionID)
      // Reconnect recovery can materialize a renderable recent tail without
      // establishing the user-message boundary needed for visible history.
      const historyResolved = messageLoader.getSnapshot({ directory: targetDirectory, sessionID }).resolved
      const cachedReady = materialization.hasMessages && materialization.renderable && historyResolved
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cachedReady && hasSession && !force) {
        await recoverInterruptedTurnAfterMessageLoad(targetDirectory, targetStore, sessionID, isStale)
        return
      }
      const shouldLoadMessages = Boolean(!cachedReady || force)
      const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
      const promise = (async () => {
        await Promise.all([
          shouldFetchSession
            ? (async () => {
                try {
                  const session = isNativeSessionId(sessionID)
                    ? await readNativeSession(sessionID, targetDirectory)
                    : await retry(() => opencodeClient.getSession(sessionID, targetDirectory))
                  if (!isStale()) {
                    const nextSession = stripSessionDiffSnapshots(session)
                    const s = targetStore.getState()
                    if (
                      nextSession.time?.archived
                      || !canCommitSessionDetailLoad(s, sessionID, baselineSessionRevision)
                    ) {
                      return
                    }
                    const sessions = upsertSessionRecord(s.session, nextSession)
                    if (
                      sessions !== s.session
                      &&
                      !isStale()
                      && canCommitSessionDetailLoad(targetStore.getState(), sessionID, baselineSessionRevision)
                    ) {
                      targetStore.setState({ session: sessions })
                    }
                  }
                } catch (e) {
                  console.error("[sync] failed to fetch session", sessionID, e)
                }
              })()
            : Promise.resolve(),
          shouldLoadMessages
            ? (async () => {
                await messageLoader.ensure(
                  { directory: targetDirectory, sessionID },
                  { force, reason: "reactive" },
                )
                if (!isStale()) {
                  await recoverInterruptedTurnAfterMessageLoad(targetDirectory, targetStore, sessionID, isStale)
                }
              })()
            : Promise.resolve(),
        ])
      })()

      const inflight: SyncSessionInflight = {
        owner: messageLoader,
        authorityEpoch,
        promise,
        force: Boolean(force),
        forcedFollowUp: null,
      }
      syncSessionInflightByKey.set(key, inflight)
      const clearInflightRequest = () => {
        if (syncSessionInflightByKey.get(key) !== inflight) return
        syncSessionInflightByKey.delete(key)
        if (syncSessionGenerationByKey.get(key) === generation) {
          syncSessionGenerationByKey.delete(key)
        }
      }
      void promise.then(clearInflightRequest, clearInflightRequest)
      return promise
    },
    [childStores, directory, keyFor, messageLoader, runtimeKey, store, touch],
  )

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      touch(sessionID, targetDirectory)
      await messageLoader.loadOlder({ directory: targetDirectory, sessionID })
    },
    [messageLoader, touch],
  )

  const prefetchSession = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      if (getRuntimeKey() !== runtimeKey) return
      await messageLoader.prefetch({ directory: targetDirectory, sessionID })
    },
    [messageLoader, runtimeKey],
  )

  const hasMore = useCallback(
    (sessionID: string, directoryOverride?: string) => {
      const state = messageLoader.getSnapshot({ directory: directoryOverride || directory, sessionID })
      return !state.complete && Boolean(state.cursor)
    },
    [directory, messageLoader],
  )

  const isLoading = useCallback(
    (sessionID: string, directoryOverride?: string) => messageLoader
      .getSnapshot({ directory: directoryOverride || directory, sessionID }).status === "loading",
    [directory, messageLoader],
  )

  // True only when a fetch has positively confirmed the history is fully
  // loaded (no next cursor). Distinct from !hasMore(), which is also true for
  // sessions whose meta simply hasn't been populated yet.
  const isComplete = useCallback(
    (sessionID: string, directoryOverride?: string) => messageLoader
      .getSnapshot({ directory: directoryOverride || directory, sessionID }).complete,
    [directory, messageLoader],
  )

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; directory?: string | null; message: Message; parts: Part[] }) => {
      messageLoader.optimisticAdd({
        directory: input.directory || directory,
        sessionID: input.sessionID,
        message: input.message,
        parts: input.parts,
      })
    },
    [directory, messageLoader],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      messageLoader.optimisticRemove({
        directory: input.directory || directory,
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
    },
    [directory, messageLoader],
  )

  const optimisticConfirm = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      messageLoader.optimisticConfirm({
        directory: input.directory || directory,
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
    },
    [directory, messageLoader],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      prefetchSession,
      loadMore,
      hasMore,
      isLoading,
      isComplete,
      recoverPendingQuestions,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
        confirm: optimisticConfirm,
      },
    }),
    [syncSession, prefetchSession, loadMore, hasMore, isLoading, isComplete, recoverPendingQuestions, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}

export function usePrefetchSessionMessages() {
  const { messageLoader, runtimeKey } = useSyncRuntime()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return
    await messageLoader.prefetch({ directory, sessionID })
  }, [messageLoader, runtimeKey])
}

export function useSessionMessageRecordsForExport() {
  const { childStores, messageLoader, runtimeKey } = useSyncRuntime()
  const touch = useSessionCacheTouch()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return null
    const store = childStores.ensureChild(directory, { bootstrap: false })
    touch(sessionID, directory)
    const target = { directory, sessionID }
    const release = messageLoader.retainSessionHistory(target)
    try {
      await messageLoader.loadComplete(target)
      if (getRuntimeKey() !== runtimeKey) return null
      return buildSessionMessageRecordsSnapshot(store.getState(), sessionID).list
    } finally {
      release()
    }
  }, [childStores, messageLoader, runtimeKey, touch])
}
