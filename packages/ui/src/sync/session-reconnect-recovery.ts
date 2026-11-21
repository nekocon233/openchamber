import type { StoreApi } from "zustand"
import type { Session } from "@/lib/opencode/model"
import type { SessionMaterializationReason } from "./event-reducer"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { retry } from "./retry"
import { stripSessionDiffSnapshots } from "./sanitize"
import { getSessionRemovalRevision, wasSessionRemovedSince } from "./session-event-freshness"
import { upsertSessionRecord } from "./session-records"
import { syncDebug } from "./debug"
import { readNativeSession } from "./native-directory-snapshots"
import { isNativeSessionId } from "@/lib/native-agents/ids"
import { opencodeClient } from "@/lib/opencode/client"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { applyGlobalSessionStatusEvents, buildActiveListReconcileEvents, watchGlobalSessionStatusWrites } from "./global-session-status"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import {
  type EventRoutingIndex,
  ingestDirectoryStateIntoRoutingIndex,
  setIndexedSessionDirectory,
  setIndexedSessionMessages,
} from "./event-routing-index"
import { resyncDirectorySessionStatuses, getActiveSessionCandidateIds, recoverInterruptedTurnAfterMessageLoad } from "./session-status-recovery"
import { resyncBlockingRequestsForDirectory } from "./blocking-request-recovery"
import { hasPromptInFlight } from "./prompts-in-flight"
import { isCatalogRuntimeCurrent } from "./sync-catalog-refresh"

const RECONNECT_MESSAGE_LIMIT = 30

export async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  reason: SessionMaterializationReason,
  isStale: () => boolean = () => false,
) {
  const isCurrent = () => !isStale()
  if (!isCurrent()) return
  const removalBaseline = getSessionRemovalRevision()
  const removals = trackRemovedSessionIds(store)
  try {
    const current = store.getState()
    const activeCandidateSessionIds = getActiveSessionCandidateIds(directory, current)
    const initialSessionById = new Map(current.session.map((session) => [session.id, session] as const))
    const knownSessionIds = current.session.map((session) => session.id)
    const statusCandidateSessionIds = Array.from(new Set([
      ...activeCandidateSessionIds,
      ...knownSessionIds,
    ]))
    if (statusCandidateSessionIds.length === 0) return true

    const statusSnapshot = await resyncDirectorySessionStatuses(
      directory,
      store,
      statusCandidateSessionIds,
      "authoritative",
      () => !isCurrent(),
    )
    if (!isCurrent()) return

    let succeeded = statusSnapshot !== null
    const snapshotActiveSessionIds = Object.entries(statusSnapshot?.statuses ?? {})
      .filter(([, status]) => status.type === "busy" || status.type === "retry")
      .map(([sessionId]) => sessionId)
    const currentSessionById = new Map(store.getState().session.map((session) => [session.id, session] as const))
    const candidateSessionIds = Array.from(new Set([
      ...activeCandidateSessionIds,
      ...snapshotActiveSessionIds,
    ])).filter((sessionId) => (
      !removals.removed.has(sessionId)
      && !wasSessionRemovedSince(sessionId, removalBaseline)
      && (
      !initialSessionById.has(sessionId)
      || currentSessionById.get(sessionId) === initialSessionById.get(sessionId)
      )
    ))
    if (candidateSessionIds.length === 0) return succeeded
    const baselineSessionById = new Map(
      store.getState().session.map((session) => [session.id, session] as const),
    )

    if (reason !== "stream-replayed") await Promise.all(candidateSessionIds.map(async (sessionId) => {
      syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
      const loader = getImperativeSessionMessageLoader()
      const [session] = await Promise.all([
        readRecoverySession(directory, sessionId),
        loader?.refreshTail({ directory, sessionID: sessionId }, RECONNECT_MESSAGE_LIMIT) ?? Promise.resolve(),
      ])
      if (!isCurrent()) return
      await recoverInterruptedTurnAfterMessageLoad(directory, store, sessionId, () => !isCurrent())
      if (!isCurrent()) return
      if (!session || loader?.getSnapshot({ directory, sessionID: sessionId }).status === "error") succeeded = false
      if (!session) return

      const nextSession = stripSessionDiffSnapshots(session)
      let applied = false
      store.setState((state: DirectoryStore) => {
        if (
          nextSession.time?.archived
          ||
          removals.removed.has(sessionId)
          || wasSessionRemovedSince(sessionId, removalBaseline)
        ) return state
        const sessionIndex = state.session.findIndex((item) => item.id === nextSession.id)
        const currentSession = sessionIndex >= 0 ? state.session[sessionIndex] : undefined
        if (currentSession !== baselineSessionById.get(sessionId)) return state
        const sessions = upsertSessionRecord(state.session, nextSession)
        let sessionTotal = state.sessionTotal

        if (sessions === state.session) {
          return state
        }
        applied = true
        if (!state.session.some((item) => item.id === nextSession.id) && !nextSession.parentID) sessionTotal += 1

        return {
          session: sessions,
          sessionTotal,
        }
      })
      if (!applied) return

      setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
      setIndexedSessionMessages(routingIndex, sessionId, directory, store.getState().message[sessionId] ?? [])
    }))
    if (!isCurrent()) return

    const requestsSucceeded = await resyncBlockingRequestsForDirectory(directory, store, candidateSessionIds, { isCurrent })
    if (!isCurrent()) return

    ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
    return succeeded && requestsSucceeded
  } finally {
    removals.unsubscribe()
  }
}

export async function reconcileActivityAfterGap(childStores: ChildStoreManager): Promise<void> {
  const runtime = { key: getRuntimeKey(), sdk: opencodeClient.getSdkClient() }
  const writes = watchGlobalSessionStatusWrites()
  try {
    const active = await opencodeClient.getActiveSessionStatuses()
    if (!active || !isCatalogRuntimeCurrent(runtime)) return
    const activeSessionIds = new Set(Object.keys(active))
    const events = buildActiveListReconcileEvents(activeSessionIds, {
      skip: (sessionId) => isNativeSessionId(sessionId) || writes.touched.has(sessionId) || hasPromptInFlight(sessionId),
      covers: (directory) => !isSpaceDirectory(directory),
      resolveDirectory: (sessionId) => {
        const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
        return session ? resolveGlobalSessionDirectory(session) : null
      },
    })
    for (const [directory, payloads] of events) applyGlobalSessionStatusEvents(directory, payloads)
    childStores.refreshStaleDirectoriesWithActiveSessions(activeSessionIds)
  } finally {
    writes.stop()
  }
}

async function readRecoverySession(directory: string, sessionId: string): Promise<Session | null> {
  if (isNativeSessionId(sessionId)) return readNativeSession(sessionId, directory).catch(() => null)
  return retry(() => opencodeClient.getSession(sessionId, directory)).catch(() => null)
}

function trackRemovedSessionIds(store: StoreApi<DirectoryStore>): {
  removed: Set<string>
  unsubscribe: () => void
} {
  const removed = new Set<string>()
  const unsubscribe = store.subscribe((state, previous) => {
    const currentIds = new Set(state.session.map((session) => session.id))
    for (const session of previous.session) {
      if (!currentIds.has(session.id)) removed.add(session.id)
    }
  })
  return { removed, unsubscribe }
}
