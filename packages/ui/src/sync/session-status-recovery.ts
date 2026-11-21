import type { StoreApi } from "zustand"
import { interruptedTurnToolParts } from "./interrupted-turn-recovery"
import type { SessionStatus } from "@/lib/opencode/model"
import type { DirectoryStore } from "./child-store"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { selectHeldSessionStatuses } from "./directory-recovery-snapshots"
import { getReconnectCandidateSessionIds } from "./reconnect-recovery"
import { readDirectoryStatuses, type DirectoryStatusSnapshot } from "./native-directory-snapshots"
import { opencodeClient } from "@/lib/opencode/client"
import {
  applyGlobalSessionStatusSnapshot,
  getDirectoryOwnedSessionIds,
  getGlobalSessionStatusRevision,
  hasGlobalSessionStatusChangedSince,
  isGlobalSessionStatusOptimisticallyProtected,
} from "./global-session-status"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { SESSION_MATERIALIZATION_MESSAGE_LIMIT } from "./session-materialization-recovery"
import { getViewedSessionMaterializationTarget } from "./viewed-sessions"
import { hasPromptInFlight, withPromptsInFlight } from "./prompts-in-flight"

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

export const statusPollingDirectories = new Set<string>()

const pendingMessageCompletionPolls = new Map<string, ReturnType<typeof setTimeout>>()

export const MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750

const toSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => status

export function getActiveSessionCandidateIds(directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
}

export function getLiveSessionCandidateIds(state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state)
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>
>

type StatusSnapshotMode = "monotonic" | "authoritative"

export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
  baselineStatuses?: ReadonlyMap<string, SessionStatus | undefined>,
  baselineGlobalRevision = Number.POSITIVE_INFINITY,
): boolean {
  if (candidateSessionIds.length === 0) return false

  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    let nextInvalidated: Record<string, true> | undefined
    const draft = () => (next ??= { ...current })

    for (const sessionId of candidateSessionIds) {
      if (baselineStatuses && current[sessionId] !== baselineStatuses.get(sessionId)) continue
      if (hasGlobalSessionStatusChangedSince(sessionId, baselineGlobalRevision)) continue
      const incoming = toSessionStatus(snapshot[sessionId])
      if (mode === "authoritative" && state.sessionStatusInvalidated?.[sessionId]) {
        nextInvalidated ??= { ...state.sessionStatusInvalidated }
        delete nextInvalidated[sessionId]
        changed = true
      }

      if (incoming && incoming.type !== "idle") {
        const held = current[sessionId]
        if (incoming.type === "busy" && held?.type === "retry" && (held.next === undefined || held.next > Date.now())) continue
        if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        continue
      }

      if (mode === "monotonic" || hasPromptInFlight(sessionId)) continue
      if (isGlobalSessionStatusOptimisticallyProtected(sessionId)) continue

      const existing = current[sessionId]
      if (!existing || existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
    }

    if (!next && !nextInvalidated) return state
    const patch: Partial<DirectoryStore> = {}
    if (next) patch.session_status = next
    if (nextInvalidated) patch.sessionStatusInvalidated = nextInvalidated
    return patch
  })

  return changed
}

export async function resyncDirectorySessionStatuses(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
  isStale: () => boolean = () => false,
  signal?: AbortSignal,
): Promise<DirectoryStatusSnapshot | null> {
  if (isStale()) return null
  const invalidatedAtStart = store.getState().sessionStatusInvalidated
  const baselineRevision = getGlobalSessionStatusRevision()
  const currentStatuses = store.getState().session_status
  const baselineStatuses = new Map(
    candidateSessionIds.map((sessionId) => [sessionId, currentStatuses[sessionId]] as const),
  )
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(), SESSION_STATUS_REQUEST_TIMEOUT_MS)
  let snapshot: DirectoryStatusSnapshot | null
  try {
    snapshot = await readDirectoryStatuses(directory, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
  // null = fetch failed; preserve existing state. {} or populated = a snapshot
  // of active sessions — reconciled per `mode` (absence ≠ idle under monotonic).
  // Sessions the snapshot does not cover keep their state: their source failed.
  if (snapshot === null || signal?.aborted || isStale()) return null
  const currentInvalidated = store.getState().sessionStatusInvalidated
  const coveredSessionIds = candidateSessionIds.filter((id) => snapshot.covers(id)
    && (!currentInvalidated?.[id] || currentInvalidated === invalidatedAtStart))
  applySessionStatusSnapshot(
    store,
    snapshot.statuses,
    coveredSessionIds,
    mode,
    baselineStatuses,
    baselineRevision,
  )
  if (mode === "authoritative") {
    store.setState({ sessionStatusReady: true, nativeSessionStatusReady: snapshot.coversNativeSessions })
    const state = store.getState()
    applyGlobalSessionStatusSnapshot(
      directory,
      withPromptsInFlight(selectHeldSessionStatuses(snapshot.statuses, state.session), state.session_status),
      getDirectoryOwnedSessionIds(directory, state.session),
      baselineRevision,
      mode,
      snapshot.covers,
    )
    // An authoritative snapshot that settles sessions previously observed
    // busy/retry can leave their trailing assistant message and tool parts
    // unfinished (managed process died mid-turn, #2577): finalize them now.
    // The snapshot write above already lowered their status to explicit idle,
    // which is the gate the helper requires — a session the snapshot reports
    // busy stays untouched.
    for (const sessionId of coveredSessionIds) {
      applyInterruptedTurnReconciliation(store, sessionId)
    }
  }
  return snapshot
}

export function maybePollStatusAfterMessageCompletion(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
): void {
  if (!directory || directory === "global" || !sessionID) return
  const current = store.getState().session_status?.[sessionID]
  if (!current || current.type === "idle") return

  const pendingKey = `${directory}\u0000${sessionID}`
  if (pendingMessageCompletionPolls.has(pendingKey)) return

  const timer = setTimeout(() => {
    pendingMessageCompletionPolls.delete(pendingKey)
    const latest = store.getState().session_status?.[sessionID]
    if (!latest || latest.type === "idle") return
    if (statusPollingDirectories.has(directory)) return

    statusPollingDirectories.add(directory)
    void (async () => {
      try {
        const snapshot = await runBackgroundNetworkTask(() =>
          resyncDirectorySessionStatuses(directory, store, [sessionID], "monotonic"), "active-session")
        if (!snapshot?.covers(sessionID)) return
        if (needsSnapshotAfterStatusPoll(store.getState(), sessionID, snapshot.statuses[sessionID])) {
          await runBackgroundNetworkTask(() =>
            resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative"), "active-session")
        }
      } catch {
        // Best-effort — the watchdog poll retries on its own cadence.
      } finally {
        statusPollingDirectories.delete(directory)
      }
    })()
  }, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS)

  pendingMessageCompletionPolls.set(pendingKey, timer)
}

export function needsSnapshotAfterStatusPoll(
  state: DirectoryStore,
  sessionId: string,
  snapshotEntry: DirectorySessionStatusSnapshot[string] | undefined,
): boolean {
  const incoming = toSessionStatus(snapshotEntry)
  if (incoming && incoming.type !== "idle") return false
  if (hasPromptInFlight(sessionId)) return false
  const currentStatus = state.session_status?.[sessionId]
  return Boolean(currentStatus && currentStatus.type !== "idle")
}

const SESSION_STATUS_REQUEST_TIMEOUT_MS = 4_000

function hasUnfinishedAssistantTurn(state: DirectoryStore, sessionID: string): boolean {
  const messages = state.message[sessionID] ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return false
    if (message.role !== "assistant") continue
    return message.time.completed === undefined
  }
  return false
}

function applyInterruptedTurnReconciliation(store: StoreApi<DirectoryStore>, sessionID: string): void {
  const interrupted = interruptedTurnToolParts(store.getState(), sessionID)
  if (!interrupted) return

  const interruptedParts = interrupted.parts
  if (!interruptedParts) {
    store.setState((state) => ({
      message: { ...state.message, [sessionID]: interrupted.messages },
    }))
    return
  }

  store.setState((state) => ({
    message: { ...state.message, [sessionID]: interrupted.messages },
    part: { ...state.part, [interrupted.messageID]: interruptedParts },
  }))
}

export async function recoverInterruptedTurnAfterMessageLoad(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  isStale?: () => boolean,
): Promise<void> {
  if (isStale?.()) return
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const initial = store.getState()
  if (!hasUnfinishedAssistantTurn(initial, sessionID)) return
  if ((initial.form?.[sessionID] ?? []).length > 0) return
  if ((initial.permission?.[sessionID] ?? []).length > 0) return

  if (!initial.session_status?.[sessionID]) {
    const snapshot = await readDirectoryStatuses(directory)
    if (snapshot === null || !snapshot.covers(sessionID) || isStale?.()
      || getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== sdk) return

    // Do not overwrite a live status event that arrived while the snapshot was
    // in flight. The snapshot only fills the previously unknown state.
    if (!store.getState().session_status?.[sessionID]) {
      applySessionStatusSnapshot(store, snapshot.statuses, [sessionID], "authoritative")
      applyGlobalSessionStatusSnapshot(
        directory,
        snapshot.statuses,
        [sessionID],
        Number.POSITIVE_INFINITY,
        "authoritative",
        snapshot.covers,
      )
    }
  }

  // The messages were read before the status. A turn that finished between
  // the two reads leaves an open assistant message beside an idle status,
  // which is exactly what an interrupted turn looks like, while the completion
  // event may still sit in the pipeline's flush frame. Re-read the tail once
  // under the settled status before judging the turn.
  if (
    store.getState().session_status?.[sessionID]?.type === "idle"
    && hasUnfinishedAssistantTurn(store.getState(), sessionID)
  ) {
    const loader = getImperativeSessionMessageLoader()
    if (loader) {
      await loader.refreshTail({ directory, sessionID }, SESSION_MATERIALIZATION_MESSAGE_LIMIT)
      if (isStale?.() || getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== sdk) return
    }
  }

  applyInterruptedTurnReconciliation(store, sessionID)
}
