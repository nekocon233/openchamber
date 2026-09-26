/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import type { FilePart, FormRequest, JsonValue, Message, Metadata, ModelRef, Part, Session, TextPart, UserMessage } from "@/lib/opencode/model"
import { partIds } from "@/lib/opencode/model"
import { Binary } from "./binary"
import { useSessionUIStore } from "./session-ui-store"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { opencodeClient } from "@/lib/opencode/client"
import { mergeSessionDirectoryMetadata, resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { registerSessionDirectory } from "./sync-refs"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { recordSendFailure } from "./send-failure-log"
import { getStaleRunningToolMessageID, materializeSessionSnapshots } from './materialization';
import { draftFromContextPayload, readContextPart, type ContextCarrierPart } from "@/lib/messages/contextParts"
import { useInlineCommentDraftStore, type InlineCommentDraftTarget } from "@/stores/useInlineCommentDraftStore"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  type SessionMetadataRecord,
} from "@/lib/sessionReviewMetadata"
import { withContextObligatoryMessage, type ContextObligatoryMessage } from "@/lib/contextObligatoryMessages"
import { setGlobalSessionStatus } from "./global-session-status"
import { clearPersistedSessionNavigation } from "./session-navigation"
import {
  getRuntimeEndpointGeneration,
  getRuntimeKey,
  RuntimeContextChangedError,
} from "@/lib/runtime-switch"
import { createOpenCodeIdentifier } from "@/lib/opencode/identifier"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { requestSessionArchiveBatch, requestSessionMetadataUpdate, requestSessionUnarchiveBatch } from './session-archive-batch';
import type { SessionArchiveStamp } from './session-archive-batch';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { getBtwOriginalSessionID, getBtwSessionID, isBtwSession, withoutBtwSessionLink } from '@/lib/sessionBtwMetadata';
import { withLinkedIssue } from '@/lib/linkedIssues';
import type { LinkedIssue } from '@/lib/linkedIssues';
import { registerBulkArchiveEchoes, releaseBulkArchiveEchoes } from "./bulk-archive-echo"
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { getErrorStatus, isAmbiguousSendFailure } from "./send-failure-classification"
import { promoteRestoredSessionOrdering } from './session-ordering';
import { normalizePath } from "@/lib/pathNormalization"
import { mergeMessages } from "./optimistic"
import { messagesBefore, messagesFrom } from "./message-ordering"
import { deleteChatDirectory } from "@/lib/chatDirectories"
import { createChatDraftIdentity } from "@/lib/chatDraftPersistence"
import { cancelSessionTitleGeneration } from "./session-title-generation"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { NativeCompactRequest, NativePromptRequest } from "@/lib/api/types"
import { NativeAgentsRequestError, NativeAgentsUnsupportedError } from "@/lib/native-agents/errors"
import { isNativeSessionId, type NativeBackend } from "@/lib/native-agents/ids"
import { nativeAgentOf } from "./native-send"
import { nativeQuestionAnswers } from "@/lib/native-agents/forms"

export { isAmbiguousSendFailure } from "./send-failure-classification"
import { recordSessionActionFailure } from "./session-action-failures"
import { applyForkInheritance } from "@/lib/sessionForkInheritance"
import { getSessionGoal } from "@/lib/sessionGoalMetadata"
import { fetchGoalObjectiveContent, writeGoalObjectiveFile } from "@/lib/goalObjectiveFiles"

const MESSAGE_REFETCH_LIMIT = 100
const SEND_CONFIRMATION_REFETCH_LIMIT = 30
// A relay-tunnel send fails when the tunnel drops, and the confirming refetch
// then has to travel over that same tunnel to answer "did my message land?".
// Two attempts 150ms apart always answered "no" on a remote connection, so an
// accepted prompt looked like a failed one and got re-sent — two AI responses
// for one user message. Wait for the connection to actually come back (an
// authoritative signal, not a blind sleep), then retry with backoff. A healthy
// connection skips the wait and answers on the first attempt.
const SEND_CONFIRMATION_REFETCH_ATTEMPTS = 3
const SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS = 250
const SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS = 3000
const SEND_CONFIRMATION_RECONNECT_POLL_MS = 100
// When a failed send's confirmation refetch cannot even reach the server
// (e.g. the backend is stalled), rolling the optimistic message back would
// let the user re-send a prompt the engine may already be answering. Keep the
// message in place and re-check on a timer instead; only a definitive
// "message absent" or the total wait cap rolls it back.
const UNCONFIRMED_SEND_FIRST_CHECK_MS = 10_000
const UNCONFIRMED_SEND_CHECK_BACKOFF_MS = 10_000
const UNCONFIRMED_SEND_MAX_WAIT_MS = 3 * 60_000
// Reference set by SyncProvider — allows actions to access the stores
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
let _actionGeneration = 0
// Optional ref into the sync layer's session-tail materialization queue. Used
// to reconcile a trailing running tool part after a blocking request is
// confirmed stale server-side (see recoverStaleBlockingRequest).
let _enqueueSessionMaterialization: ((directory: string, sessionID: string, messageID: string) => void) | null = null
type OptimisticAddInput = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveInput = { sessionID: string; directory?: string | null; messageID: string }
type OptimisticConfirmInput = OptimisticRemoveInput

let _optimisticAdd: ((input: OptimisticAddInput) => void) | null = null
let _optimisticRemove: ((input: OptimisticRemoveInput) => void) | null = null
let _optimisticConfirm: ((input: OptimisticConfirmInput) => void) | null = null

export type UnconfirmedSendRollback = {
  runtimeKey: string
  sessionId: string
  messageId: string
  directory: string | null
  content: string
}

export class UnconfirmedSendError extends Error {
  readonly sessionId: string
  readonly messageId: string
  readonly directory: string | null

  constructor(sessionId: string, messageId: string, directory: string | null) {
    super("The message may still have been accepted; its send outcome could not be confirmed.")
    this.name = "UnconfirmedSendError"
    this.sessionId = sessionId
    this.messageId = messageId
    this.directory = directory
  }
}

export function isUnconfirmedSendError(error: unknown): error is UnconfirmedSendError {
  return error instanceof UnconfirmedSendError
}

export type UnconfirmedSendEntry = {
  runtimeKey: string
  sessionId: string
  messageId: string
  directory: string | null
  content: string
  startedAt: number
  attempts: number
}

const unconfirmedSendTimers = new Map<string, ReturnType<typeof setTimeout>>()
const unconfirmedSendRollbackListeners = new Set<(rollback: UnconfirmedSendRollback) => void>()

const unconfirmedSendKey = (sessionId: string, messageId: string) => `${sessionId}\u0000${messageId}`

export function onUnconfirmedSendRollback(listener: (rollback: UnconfirmedSendRollback) => void): () => void {
  unconfirmedSendRollbackListeners.add(listener)
  return () => {
    unconfirmedSendRollbackListeners.delete(listener)
  }
}

// Drops every pending delayed confirmation and rollback listener. Runtime
// switches dispose the stores these entries belong to, and tests need a
// deterministic boundary between runs.
export function resetUnconfirmedSendState(): void {
  for (const timer of unconfirmedSendTimers.values()) clearTimeout(timer)
  unconfirmedSendTimers.clear()
  unconfirmedSendRollbackListeners.clear()
}

/**
 * Revision patch for one or more sessions changing in the same store write.
 *
 * A batch bumps the revision once, because it is one state change: consumers
 * compare revisions to decide whether their view of the list is stale, and a
 * batch leaves them stale exactly once rather than once per session.
 */
function sessionsMutationPatch(
  state: ReturnType<DirectoryStoreApi["getState"]>,
  sessionIds: Iterable<string>,
  deleted: boolean,
) {
  const revision = (state.sessionRevision ?? 0) + 1
  const sessionEventRevision = { ...(state.sessionEventRevision ?? {}) }
  const sessionDeletedRevision = { ...(state.sessionDeletedRevision ?? {}) }
  for (const sessionId of sessionIds) {
    if (deleted) {
      sessionDeletedRevision[sessionId] = revision
      delete sessionEventRevision[sessionId]
    } else {
      sessionEventRevision[sessionId] = revision
      delete sessionDeletedRevision[sessionId]
    }
  }
  return {
    sessionListSource: "live" as const,
    sessionRevision: revision,
    sessionEventRevision,
    sessionDeletedRevision,
  }
}

function sessionMutationPatch(
  state: ReturnType<DirectoryStoreApi["getState"]>,
  sessionId: string,
  deleted: boolean,
) {
  return sessionsMutationPatch(state, [sessionId], deleted)
}

function invalidateSessionLoads(sessionId: string, directories: Iterable<string | null | undefined>): void {
  const loader = getImperativeSessionMessageLoader()
  if (!loader) return
  for (const directory of new Set(directories)) {
    if (directory) loader.invalidateSession({ directory, sessionID: sessionId })
  }
}

// Resolve through globalThis so test fake-timer implementations that replace
// the global function can intercept it (a bare `setTimeout` reference can be
// bound to the builtin by the runtime and bypass the replacement).
const wait = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))

export function setActionRefs(
  childStores: ChildStoreManager,
  getDirectory: () => string,
  enqueueSessionMaterialization?: (directory: string, sessionID: string, messageID: string) => void,
) {
  const runtimeRefsChanged = _childStores !== childStores
  _childStores = childStores
  _getDirectory = getDirectory
  if (runtimeRefsChanged) _actionGeneration += 1
  _enqueueSessionMaterialization = enqueueSessionMaterialization ?? null
}

export function setOptimisticRefs(
  add: (input: OptimisticAddInput) => void,
  remove: (input: OptimisticRemoveInput) => void,
  confirm?: (input: OptimisticConfirmInput) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
  _optimisticConfirm = confirm ?? null
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function dirStoreForDirectory(directory: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  if (!directory) throw new Error("No directory")
  return _childStores.ensureChild(directory)
}

function dirStoreForSession(sessionId: string): { store: DirectoryStoreApi; directory?: string } {
  const directory = getSessionDirectory(sessionId)
  if (directory) {
    return { store: dirStoreForDirectory(directory), directory }
  }
  return { store: dirStore(), directory: dir() }
}

/**
 * Provider/model of the session's last assistant message — the authoritative
 * "session provider" for utility calls (notes distillation etc.), independent
 * of what the composer picker currently points at.
 */
export function getSessionLastAssistantModel(sessionId: string): { providerID: string; modelID: string } | null {
  try {
    const { store } = dirStoreForSession(sessionId)
    const messages = store.getState().message[sessionId]
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]
      if (info?.role === "assistant" && info.providerID && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
    return null
  } catch {
    return null
  }
}

function updateLiveSession(session: Session, directory?: string): boolean {
  const stores = _childStores
  if (!stores) return false

  const candidates = directory
    ? [[directory, stores.getChild(directory)] as const]
    : stores.children

  for (const [, store] of candidates) {
    if (!store) continue
    const current = store.getState().session
    const index = current.findIndex((item) => item.id === session.id)
    if (index === -1) continue

    const next = [...current]
    next[index] = mergeSessionDirectoryMetadata(session, current[index])
    store.setState({ session: next })
    return true
  }

  return false
}

function mirrorSessionIntoLiveStores(session: Session, directory?: string): void {
  if (directory && updateLiveSession(session, directory)) {
    return
  }
  updateLiveSession(session)
}

function moveRecordEntries<T>(
  source: Record<string, T>,
  destination: Record<string, T>,
  keys: Iterable<string>,
): { source: Record<string, T>; destination: Record<string, T> } {
  let nextSource = source
  let nextDestination = destination

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    if (nextSource === source) nextSource = { ...source }
    if (nextDestination === destination) nextDestination = { ...destination }
    nextDestination[key] = source[key]
    delete nextSource[key]
  }

  return { source: nextSource, destination: nextDestination }
}

function reconcileSessionMove(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
): Session {
  const stores = _childStores
  const sourceStore = stores?.getChild(sourceDirectory)
  const destinationStore = stores?.ensureChild(destinationDirectory, { bootstrap: false })
  const sourceState = sourceStore?.getState()
  const destinationState = destinationStore?.getState()
  const liveSession = sourceState?.session.find((candidate) => candidate.id === session.id)
  const movedSession: Session = {
    ...mergeSessionDirectoryMetadata(session, liveSession),
    directory: destinationDirectory,
  }

  if (!destinationStore || !destinationState || sourceStore === destinationStore) {
    return movedSession
  }

  const destinationSessionIndex = destinationState.session.findIndex((candidate) => candidate.id === session.id)
  const destinationSessions = [...destinationState.session]
  if (destinationSessionIndex === -1) destinationSessions.push(movedSession)
  else destinationSessions[destinationSessionIndex] = movedSession

  if (!sourceStore || !sourceState) {
    destinationStore.setState({
      session: destinationSessions,
      sessionTotal: destinationSessionIndex === -1
        ? destinationState.sessionTotal + 1
        : destinationState.sessionTotal,
    })
    return movedSession
  }

  const sourceContainsSession = sourceState.session.some((candidate) => candidate.id === session.id)
  const status = moveRecordEntries(sourceState.session_status, destinationState.session_status, [session.id])
  const permissions = moveRecordEntries(sourceState.permission, destinationState.permission, [session.id])
  const forms = moveRecordEntries(sourceState.form, destinationState.form, [session.id])
  const messages = moveRecordEntries(sourceState.message, destinationState.message, [session.id])
  const messageIds = sourceState.message[session.id]?.map((message) => message.id) ?? []
  const parts = moveRecordEntries(sourceState.part, destinationState.part, messageIds)

  sourceStore.setState({
    session: sourceState.session.filter((candidate) => candidate.id !== session.id),
    sessionTotal: sourceContainsSession ? Math.max(0, sourceState.sessionTotal - 1) : sourceState.sessionTotal,
    session_status: status.source,
    permission: permissions.source,
    form: forms.source,
    message: messages.source,
    part: parts.source,
    ...sessionMutationPatch(sourceState, session.id, true),
  })
  destinationStore.setState({
    session: destinationSessions,
    sessionTotal: destinationSessionIndex === -1
      ? destinationState.sessionTotal + 1
      : destinationState.sessionTotal,
    session_status: status.destination,
    permission: permissions.destination,
    form: forms.destination,
    message: messages.destination,
    part: parts.destination,
    ...sessionMutationPatch(destinationState, session.id, false),
  })

  return movedSession
}

export async function moveSessionToDirectory(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
  expectedRuntimeKey?: string,
): Promise<void> {
  await opencodeClient.moveSession(session.id, destinationDirectory)

  // If the runtime changed during the move request, the server move
  // already happened, but we must not publish stale local state to the UI/stores.
  if (isStaleRuntime(expectedRuntimeKey)) return

  invalidateSessionLoads(session.id, [sourceDirectory, destinationDirectory])

  const moved = reconcileSessionMove(session, sourceDirectory, destinationDirectory)

  registerSessionDirectory(session.id, destinationDirectory)
  useGlobalSessionsStore.getState().upsertSession(moved)
  useSessionUIStore.getState().setSessionDirectory(session.id, destinationDirectory)
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

// Wait briefly for the pipeline to re-establish connection before failing a
// send. Transient reconnects (heartbeat race, WS→SSE fallback, brief network
// blip) otherwise surface as a hard "Connection lost" toast even though the
// pipeline recovers within a second. While waiting, run bounded health probes
// inside the same grace window so stale disconnected state can recover quickly.
// A relayed round trip crosses the relay twice (client -> relay -> host and
// back), so a healthy but distant host can easily need more than 500 ms.
const CONNECTION_GRACE_MS = 2000
const CONNECTION_PROBE_MS = 500
const RELAY_CONNECTION_GRACE_MS = 3000
const RELAY_CONNECTION_PROBE_MS = 3000
export async function waitForConnectionOrThrow(): Promise<void> {
  const relayed = isRelayModeActive()
  const deadline = Date.now() + (relayed ? RELAY_CONNECTION_GRACE_MS : CONNECTION_GRACE_MS)
  const probeMs = relayed ? RELAY_CONNECTION_PROBE_MS : CONNECTION_PROBE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(probeMs, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

type SessionListSnapshot = {
  directory: string
}

type DirectoryStoreApi = ReturnType<ChildStoreManager["ensureChild"]>

type SessionActionRuntimeContext = {
  runtimeKey: string
  actionGeneration: number
  runtimeGeneration: number
  childStores: ChildStoreManager | null
  client: ReturnType<typeof opencodeClient.getSdkClient>
}

class SessionActionRuntimeChangedError extends Error {
  constructor() {
    super("Session operation cancelled because the runtime changed")
    this.name = "SessionActionRuntimeChangedError"
  }
}

export function captureSessionActionRuntime(): SessionActionRuntimeContext {
  return {
    runtimeKey: getRuntimeKey(),
    actionGeneration: _actionGeneration,
    runtimeGeneration: getRuntimeEndpointGeneration(),
    childStores: _childStores,
    client: opencodeClient.getSdkClient(),
  }
}

function isSessionActionRuntimeCurrent(context: SessionActionRuntimeContext): boolean {
  return getRuntimeKey() === context.runtimeKey
    && _actionGeneration === context.actionGeneration
    && getRuntimeEndpointGeneration() === context.runtimeGeneration
    && _childStores === context.childStores
    && opencodeClient.getSdkClient() === context.client
}

function assertSessionActionRuntimeCurrent(context: SessionActionRuntimeContext): void {
  if (!isSessionActionRuntimeCurrent(context)) throw new SessionActionRuntimeChangedError()
}

/**
 * True when a caller captured a runtime key before an asynchronous mutation and
 * that runtime is no longer the active one. Callers pass `undefined` when they
 * do not participate in runtime-scoped guarding, which keeps the previous
 * unguarded behavior.
 */
function isStaleRuntime(expectedRuntimeKey: string | undefined): boolean {
  return expectedRuntimeKey !== undefined && getRuntimeKey() !== expectedRuntimeKey
}

type DescendantSession = {
  session: Session
  directory: string
}

/** "unknown" means no live source covers this session right now, so no caller
 *  may treat it as idle on this answer. "idle" requires positive coverage. */
export type SessionLiveActivity = "unknown" | "idle" | "active"

/**
 * A session's live status can live in a different child store than the one that
 * wins the directory dedup, so any store reporting a non-idle status counts.
 * Read at the moment of use: a descendant can start working after the subtree
 * snapshot was taken.
 *
 * Absence of a non-idle status is not proof of idleness. Child stores are
 * evicted for background directories, and the global status index keeps only
 * non-idle entries, so "no report" and "idle" are different answers: report
 * "idle" only after a live idle event or successful status snapshot covers
 * the session's own directory. A loaded session list is not status authority.
 */
export function getSessionLiveActivity(sessionId: string): SessionLiveActivity {
  const stores = _childStores

  if (stores) {
    for (const [, store] of stores.children) {
      const status = store.getState().session_status?.[sessionId]
      if (status && status.type !== "idle") return "active"
    }
  }

  // Cross-directory live index: populated by global events and authoritative
  // per-directory status snapshots, and it survives child-store eviction.
  if (useGlobalSessionStatusStore.getState().statusById.has(sessionId)) return "active"

  if (!stores) return "unknown"
  return hasAuthoritativeIdleCoverage(sessionId, stores) ? "idle" : "unknown"
}

function hasAuthoritativeIdleCoverage(sessionId: string, stores: ChildStoreManager): boolean {
  const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
    ?? resolveKnownSessionDirectory(sessionId)
    ?? findSessionDirectoryInChildStores(sessionId)
  if (!directory) return false
  const state = stores.getChild(directory)?.getState()
  return (state?.sessionStatusReady === true && !state.sessionStatusInvalidated?.[sessionId])
    || state?.session_status[sessionId]?.type === "idle"
}

function resolveKnownSessionDirectory(sessionId: string): string | null {
  const globalSession = getGlobalSessionSnapshot(sessionId)
  return globalSession ? resolveGlobalSessionDirectory(globalSession) : null
}

export function isSessionBusyNow(sessionId: string): boolean {
  return getSessionLiveActivity(sessionId) === "active"
}

async function abortDescendantIfBusy(sessionId: string, directory: string): Promise<void> {
  if (!isSessionBusyNow(sessionId)) return
  try {
    await opencodeClient.abortSession(sessionId, directory)
  } catch {
    // ignore abort errors
  }
}

function getDescendantSessions(rootId: string): DescendantSession[] {
  const stores = _childStores
  if (!stores) return []

  const sessionsById = new Map<string, DescendantSession>()
  for (const [storeDirectory, store] of stores.children) {
    const state = store.getState()
    for (const session of state.session) {
      const directory = session.directory || storeDirectory
      const current = sessionsById.get(session.id)
      if (!current || session.directory) sessionsById.set(session.id, { session, directory })
    }
  }

  const subtreeIds = computeSubtreeIds(
    [...sessionsById.values()].map(({ session }) => session),
    rootId,
  )
  subtreeIds.delete(rootId)
  return [...subtreeIds]
    .map((id) => sessionsById.get(id))
    .filter((entry): entry is DescendantSession => !!entry)
}

function firstUserMessageAtOrAfter(messages: Message[], cutoff: number): Message | null {
  let target: Message | null = null
  for (const message of messages) {
    if (message.role !== "user" || message.time.created < cutoff) continue
    if (!target || message.time.created < target.time.created) target = message
  }
  return target
}

async function fetchSessionMessages(sessionId: string, directory?: string | null): Promise<Message[]> {
  const page = await opencodeClient.getSessionMessages(sessionId, undefined, directory)
  return page.items.map(({ info }) => info)
}

async function cascadeRevertToDescendants(rootId: string, cutoff: number): Promise<void> {
  for (const { session, directory } of getDescendantSessions(rootId)) {
    try {
      // A running descendant would keep writing messages past the revert
      // boundary, so stop it first for the same reason the parent is aborted.
      await abortDescendantIfBusy(session.id, directory)
      const messages = await fetchSessionMessages(session.id, directory)
      // Equal timestamps belong to the reverted side of the boundary. Keeping
      // them would rely on unrelated message IDs to decide chronology.
      const target = firstUserMessageAtOrAfter(messages, cutoff)
      if (!target) continue
      await opencodeClient.stageRevert(session.id, target.id, { directory })
      mirrorSessionIntoLiveStores(await opencodeClient.getSession(session.id, directory), directory)
    } catch (error) {
      console.error(`[session-actions] Failed to cascade revert to descendant ${session.id}:`, error)
    }
  }
}

/**
 * Finalizes a staged revert: the hidden messages are deleted for good, in the
 * session and in every descendant that was staged alongside it.
 */
export async function commitStagedRevert(sessionId: string): Promise<void> {
  if (isNativeSessionId(sessionId)) throw new Error("Native reverts are committed with the next prompt")
  const { directory } = dirStoreForSession(sessionId)
  for (const descendant of getDescendantSessions(sessionId)) {
    if (!descendant.session.revert) continue
    try {
      await opencodeClient.commitRevert(descendant.session.id, descendant.directory)
      mirrorSessionIntoLiveStores(await opencodeClient.getSession(descendant.session.id, descendant.directory), descendant.directory)
    } catch (error) {
      console.error(`[session-actions] Failed to commit revert in descendant ${descendant.session.id}:`, error)
    }
  }
  await opencodeClient.commitRevert(sessionId, directory)
  mirrorSessionIntoLiveStores(await opencodeClient.getSession(sessionId, directory), directory)
  await refetchSessionMessages(sessionId)
  if (directory) sessionEvents.requestGitRefresh({ directory })
}

/** Cancels a staged revert: the hidden messages come back, in descendants too. */
export async function clearStagedRevert(sessionId: string): Promise<void> {
  const { directory } = dirStoreForSession(sessionId)
  if (isNativeSessionId(sessionId)) {
    const session = await requireNativeAgents().unrevert(sessionId, requireNativeDirectory(directory))
    mirrorSessionIntoLiveStores(session, directory)
    useGlobalSessionsStore.getState().upsertSession(session)
    if (directory) sessionEvents.requestGitRefresh({ directory })
    return
  }
  for (const descendant of getDescendantSessions(sessionId)) {
    if (!descendant.session.revert) continue
    try {
      await opencodeClient.clearRevert(descendant.session.id, descendant.directory)
      mirrorSessionIntoLiveStores(await opencodeClient.getSession(descendant.session.id, descendant.directory), descendant.directory)
    } catch (error) {
      console.error(`[session-actions] Failed to clear revert in descendant ${descendant.session.id}:`, error)
    }
  }
  await opencodeClient.clearRevert(sessionId, directory)
  mirrorSessionIntoLiveStores(await opencodeClient.getSession(sessionId, directory), directory)
}

function getGlobalSessionSnapshot(sessionId: string): Session | null {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

function findLiveSession(sessionId: string): Session | null {
  if (!_childStores) return null
  for (const store of _childStores.children.values()) {
    const session = store.getState().session.find((item) => item.id === sessionId)
    if (session) return session
  }
  return null
}

/**
 * The archive routes answer with stamps, not session records, so the stamp is
 * applied to the session the global store already holds. A session it does not
 * hold is left alone rather than inserted as a record without its fields.
 */
function withArchivedAt(sessionId: string, archivedAt: number | null): Session | null {
  const known = getGlobalSessionSnapshot(sessionId) ?? findLiveSession(sessionId)
  if (!known) return null
  const time = { ...known.time }
  if (archivedAt === null) delete time.archived
  else time.archived = archivedAt
  return { ...known, time }
}

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

function getSessionDirectory(sessionId: string): string | undefined {
  // The global record carries the directory the server filed the session
  // under, so it wins. Directory stores come second: a project root's store
  // also indexes status, permissions and questions for sessions that live in
  // that project's worktrees, so a lookup there can name the root for a
  // worktree session and the server then answers 404/500 for the mutation.
  const globalSession = getGlobalSessionSnapshot(sessionId)
  const globalDirectory = globalSession ? resolveGlobalSessionDirectory(globalSession) ?? undefined : undefined
  return globalDirectory
    || findSessionDirectoryInChildStores(sessionId)
    || useSessionUIStore.getState().getDirectoryForSession(sessionId)
    || dir()
}

function findSessionDirectoryInChildStores(sessionId: string): string | null {
  const stores = _childStores
  if (!stores || !sessionId) return null

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.form ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

/** Directory of the instance that owns `sessionId`, for a reply request. */
function getSessionReplyDirectory(sessionId?: string): string | undefined {
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null
  return directory ?? dir()
}

function restoreFilePartsToInput(fileParts: readonly FilePart[]): void {
  useInputStore.getState().clearAttachedFiles()
  for (const filePart of fileParts) {
    if (!filePart.url) continue
    useInputStore.getState().addRestoredAttachment({
      url: filePart.url,
      mimeType: filePart.mime,
      filename: filePart.filename ?? "attachment",
    })
  }
}

/**
 * The context a user message was sent with.
 *
 * OpenCode 2.x admits attached context as synthetic messages inserted right
 * before the prompt, so the carriers are the contiguous run of synthetic
 * messages preceding the target — not parts of the message itself.
 */
function contextCarriersForMessage(messages: readonly Message[], messageID: string): ContextCarrierPart[] {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index < 0) return []
  const carriers: ContextCarrierPart[] = []
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (candidate.role !== "synthetic") break
    carriers.unshift({ metadata: candidate.metadata })
  }
  return carriers
}

/**
 * Where a revert or fork of a user message cuts the transcript: at the first
 * of its context carriers, so the carriers leave together with the message.
 * Cutting at the message itself would leave them in place, and the next prompt
 * would be sent with the reverted context attached a second time.
 */
function transcriptCutForMessage(messages: readonly Message[], messageID: string): string {
  const index = messages.findIndex((message) => message.id === messageID)
  let first = index
  while (first > 0 && messages[first - 1].role === "synthetic") first -= 1
  return first >= 0 ? messages[first].id : messageID
}

/**
 * Put a message's attached context (review comments, quotes, terminal
 * selections, annotations) back on the composer chips.
 *
 * Context rides out as synthetic messages carrying structured metadata, so a
 * reverted or forked message can be rebuilt into the drafts it came from.
 * Without this the context is simply gone: the message is pulled back into the
 * composer with its text and files, but the comments attached to it are not.
 *
 * The target's existing drafts are replaced, matching how text and file
 * attachments are restored — the composer ends up as the message was sent.
 */
function restoreContextPartsToInput(
  parts: readonly ContextCarrierPart[],
  target: InlineCommentDraftTarget,
): void {
  const store = useInlineCommentDraftStore.getState()
  store.clearDrafts(target)
  for (const part of parts) {
    const payload = readContextPart(part)
    if (!payload) continue
    const draft = draftFromContextPayload(payload)
    if (draft) store.addDraft(target, draft)
  }
}

/**
 * Server-confirmed directory that owns a session, from the session record
 * (`directory`, then `project.worktree`). Mirrors the authoritative source in
 * session-directory-resolution: holding a session in a child store proves
 * containment, not ownership — a project's session list legitimately includes
 * the sessions of its worktrees so the sidebar can group them — so reading
 * ownership from the containing store reports the parent for a session that
 * lives in a worktree, and every fetch is then addressed to a directory that
 * does not own it.
 */
function resolveSessionOwnedDirectory(session: Session): string | null {
  const record = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  const raw = typeof record.directory === "string" && record.directory.trim().length > 0
    ? record.directory
    : typeof record.project?.worktree === "string" && record.project.worktree.trim().length > 0
      ? record.project.worktree
      : null
  return raw ? normalizePath(raw) : null
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "form",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.form
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string; sessionID?: string }> | undefined>) {
      const request = requests?.find((candidate) => candidate.id === requestId)
      if (!request) continue

      // Ownership beats containment. The request belongs to one specific
      // session, and the reply must reach the instance that actually tracks
      // it — the directory the session record's server-confirmed `directory`
      // names. The containing store's key only proves containment: a project
      // store holds its worktree sessions too, and a reply addressed to the
      // parent instance makes the server answer FormNotFoundError while the
      // form stays pending in the worktree instance, leaving the session
      // stuck on the running form tool. Fall back to the store
      // key only when the session record carries no directory.
      const requestSessionID = typeof request.sessionID === "string" && request.sessionID.length > 0
        ? request.sessionID
        : sessionId
      const sessionRecord = requestSessionID
        ? state.session.find((s) => s.id === requestSessionID)
        : undefined
      const ownedDirectory = sessionRecord ? resolveSessionOwnedDirectory(sessionRecord) : null
      if (ownedDirectory) return ownedDirectory
      return directory
    }
  }

  const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  return findSessionDirectoryInChildStores(sessionId)
}

export function isFormRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Form(?:\.)?NotFoundError|Form request not found/i.test(message)
}

/**
 * Reconcile the trailing assistant tool part after a blocking request turned
 * out to be stale server-side (reply/reject answered with not-found). The
 * local request is removed (the server no longer tracks it), but the
 * form/permission tool part can remain `running` with the session busy —
 * the UI would stay on "waiting for input" with no recovery until the user
 * stops the run. Enqueue the sync layer's settled-running-tool tail
 * materialization so the part converges to the server's actual state.
 */
function recoverStaleBlockingRequest(sessionId: string): void {
  const stores = _childStores
  const enqueue = _enqueueSessionMaterialization
  if (!stores || !enqueue || !sessionId) return

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      !state.session.some((session) => session.id === sessionId)
      && !Object.prototype.hasOwnProperty.call(state.message, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.form ?? {}, sessionId)
    ) {
      continue
    }
    const messageID = getStaleRunningToolMessageID(state, sessionId)
    if (messageID) {
      enqueue(directory, sessionId, messageID)
    }
    return
  }
}

function removeFormRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().form ?? {}
    let nextForm: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextForm ??= { ...current }
      if (nextRequests.length > 0) {
        nextForm[candidateSessionId] = nextRequests
      } else {
        delete nextForm[candidateSessionId]
      }
      removed = true
    }

    if (nextForm) {
      store.setState({ form: nextForm })
    }
  }

  return removed
}

function isPermissionRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Permission(?:\.)?NotFoundError|Permission request not found/i.test(message)
}

function removePermissionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().permission ?? {}
    let nextPermission: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextPermission ??= { ...current }
      if (nextRequests.length > 0) {
        nextPermission[candidateSessionId] = nextRequests
      } else {
        delete nextPermission[candidateSessionId]
      }
      removed = true
    }

    if (nextPermission) {
      store.setState({ permission: nextPermission })
    }
  }

  return removed
}

/**
 * Directory the reply must be addressed to. Ownership beats containment, so
 * the request's own session record wins over the store that happens to hold it.
 */
function getRequestReplyDirectory(
  type: "permission" | "form",
  sessionId: string,
  requestId: string,
): string | undefined {
  return resolveDirectoryForBlockingRequest(type, sessionId, requestId)
    ?? getSessionReplyDirectory(sessionId)
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

// A native CLI session is created by the OpenChamber server in the CLI's own
// store; OpenCode never sees it.
const requireNativeAgents = () => {
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents
  if (!nativeAgents?.supported) throw new NativeAgentsUnsupportedError()
  return nativeAgents
}

// Native sessions are driven through the OpenChamber server, which needs the
// session's directory to find its CLI transcript.
const requireNativeDirectory = (directory: string | null | undefined): string => {
  if (!directory) throw new Error("A native session needs a directory")
  return directory
}

const NATIVE_QUESTION_GONE = "NATIVE_QUESTION_NOT_FOUND"

/** A new session in a CLI's own store; the server announces it. */
export async function createNativeSession(backend: NativeBackend, directory: string | null, title: string | undefined): Promise<Session> {
  const nativeAgents = requireNativeAgents()
  const nativeDirectory = requireNativeDirectory(directory)
  return nativeAgents.createSession(title === undefined ? { backend, directory: nativeDirectory } : { backend, directory: nativeDirectory, title })
}

/** Hands a prompt to a native session's CLI; the turn streams in as events. */
export function promptNativeSession(sessionId: string, request: NativePromptRequest): Promise<void> {
  return requireNativeAgents().prompt(sessionId, request)
}

// Rename, archive and restore reach a native session's CLI through the
// OpenChamber server; OpenCode sessions keep their own update route.
async function renameSessionRemotely(sessionId: string, directory: string | null | undefined, title: string): Promise<Session> {
  if (isNativeSessionId(sessionId)) {
    return requireNativeAgents().updateSession(sessionId, requireNativeDirectory(directory), { title })
  }
  await opencodeClient.renameSession(sessionId, title, directory)
  return opencodeClient.getSession(sessionId, directory)
}

// A native session is deleted from its CLI's store. A missing one answers 404,
// which the callers treat as already deleted, as for OpenCode.
async function deleteSessionRemotely(sessionId: string, directory: string | null | undefined): Promise<boolean> {
  if (!isNativeSessionId(sessionId)) return opencodeClient.deleteSession(sessionId, directory)
  await requireNativeAgents().deleteSession(sessionId, requireNativeDirectory(directory))
  return true
}

/**
 * The model and agent a session starts on.
 *
 * v2 keeps the selection on the session, and a switch after creation is
 * recorded in the transcript as its own message. Callers that already know
 * what the first turn will run on pass it here, so the session is created on
 * that selection and the first prompt needs no switch at all.
 */
export type SessionCreateSelection = { model?: ModelRef; agent?: string }

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  metadata?: Metadata,
  selectionTransition?: "submitted-draft",
  selection?: SessionCreateSelection,
  navigation: "open" | "preserve" = "open",
  nativeBackend: NativeBackend | null = null,
): Promise<Session | null> {
  const runtimeContext = captureSessionActionRuntime()
  const runtimeClient = opencodeClient.getSdkClient()
  try {
    assertSessionActionRuntimeCurrent(runtimeContext)
    // Capture the effective directory used for session creation so we can fall
    // back to it when the server response omits the `directory` field.
    // Without this, setCurrentSession would fall through to a stale
    // opencodeClient.getDirectory() value and group the session under the
    // wrong project (closes #1637, #2270).
    const effectiveDirectory = directoryOverride ?? dir()
    const session = nativeBackend
      ? await createNativeSession(nativeBackend, effectiveDirectory ?? null, title)
      : await opencodeClient.createSession({ title, metadata, model: selection?.model, agent: selection?.agent }, effectiveDirectory)
    assertSessionActionRuntimeCurrent(runtimeContext)

    if (getRuntimeKey() !== runtimeContext.runtimeKey || opencodeClient.getSdkClient() !== runtimeClient) return null
    const sessionDirectory = session.directory || effectiveDirectory || null
    // Pre-populate routing index so SSE events arriving before session.created
    // can be routed to the correct child store
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
      const store = _childStores?.ensureChild(sessionDirectory, { bootstrap: false })
      if (store) {
        const current = store.getState().session
        const existing = Binary.search(current, session.id, (candidate) => candidate.id)
        // An event may have published newer metadata before the create response.
        if (!existing.found) {
          store.setState({ session: [...current.slice(0, existing.index), session, ...current.slice(existing.index)] })
        }
      }
      getImperativeSessionMessageLoader()?.initializeCreatedSession({ directory: sessionDirectory, sessionID: session.id })
    }
    if (navigation === "open") useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory, selectionTransition)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

/**
 * Read a session, apply `updater` to its metadata, and persist the result.
 *
 * The captured runtime key, endpoint generation, action generation, and child
 * store owner are checked before and after each remote step. A change throws
 * instead of publishing the old runtime's metadata into the new one.
 */
const isMetadataRecord = (value: JsonValue | undefined): value is Metadata =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)

/**
 * The JSON Merge Patch (RFC 7386) that turns `current` into `next`: changed
 * keys carry their new value, removed keys carry `null`, and nested records
 * recurse so a sibling key another feature owns is left untouched.
 */
function buildMetadataMergePatch(current: Metadata, next: Metadata): Metadata {
  const patch: Metadata = {}
  for (const key of Object.keys(current)) {
    if (!(key in next)) patch[key] = null
  }
  for (const [key, value] of Object.entries(next)) {
    const previous = current[key]
    if (isMetadataRecord(value) && isMetadataRecord(previous)) {
      const nested = buildMetadataMergePatch(previous, value)
      if (Object.keys(nested).length > 0) patch[key] = nested
      continue
    }
    if (JSON.stringify(previous) !== JSON.stringify(value)) patch[key] = value
  }
  return patch
}

export async function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  expectedRuntime: SessionActionRuntimeContext | { runtimeKey: string } = captureSessionActionRuntime(),
): Promise<Session> {
  const runtimeContext = "actionGeneration" in expectedRuntime
    ? expectedRuntime
    : { ...captureSessionActionRuntime(), runtimeKey: expectedRuntime.runtimeKey }
  assertSessionActionRuntimeCurrent(runtimeContext)
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  const native = isNativeSessionId(sessionId)
  const current = native
    ? await requireNativeAgents().getSession(sessionId, requireNativeDirectory(targetDirectory))
    : await opencodeClient.getSession(sessionId, targetDirectory)
  assertSessionActionRuntimeCurrent(runtimeContext)
  const currentMetadata = getSessionMetadata(current)
  const nextMetadata = updater(currentMetadata)
  let updated: Session
  if (native) {
    updated = await requireNativeAgents().updateSession(sessionId, requireNativeDirectory(targetDirectory), { metadata: nextMetadata })
  } else {
    const result = await requestSessionMetadataUpdate(sessionId, buildMetadataMergePatch(currentMetadata, nextMetadata), targetDirectory)
    if (result.outcome !== "updated") throw new Error(`session metadata update failed: ${result.reason}`)
    updated = { ...current, metadata: result.metadata }
  }
  assertSessionActionRuntimeCurrent(runtimeContext)
  useGlobalSessionsStore.getState().upsertSession(updated)
  const sessionDirectory = updated.directory || targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  mirrorSessionIntoLiveStores(updated, sessionDirectory ?? undefined)
  return updated
}

export async function setLinkedIssue(
  sessionId: string,
  directory: string | null | undefined,
  issue: LinkedIssue,
  linked: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withLinkedIssue(metadata, issue, linked))
}

export async function setContextObligatoryMessage(
  sessionId: string,
  directory: string | null | undefined,
  message: ContextObligatoryMessage,
  pinned: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withContextObligatoryMessage(metadata, message, pinned))
}

async function cleanupReviewMetadataBeforeDelete(
  sessionId: string,
  directory: string | null | undefined,
  runtimeContext: SessionActionRuntimeContext,
): Promise<void> {
  let session: Session
  try {
    assertSessionActionRuntimeCurrent(runtimeContext)
    // A native session keeps its review and btw links on the OpenChamber server.
    const sessionDirectory = directory ?? getSessionDirectory(sessionId)
    session = isNativeSessionId(sessionId)
      ? await requireNativeAgents().getSession(sessionId, requireNativeDirectory(sessionDirectory))
      : await opencodeClient.getSession(sessionId, sessionDirectory)
    assertSessionActionRuntimeCurrent(runtimeContext)
  } catch (error) {
    if (error instanceof SessionActionRuntimeChangedError) throw error
    return
  }

  const unlinkParent = async (originalSessionID: string, unlink: (metadata: SessionMetadataRecord) => SessionMetadataRecord) => {
    try {
      await patchSessionMetadata(
        originalSessionID,
        directory ?? getSessionDirectory(originalSessionID),
        unlink,
        runtimeContext,
      )
    } catch (error) {
      if (error instanceof SessionActionRuntimeChangedError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) return
      console.warn("[session-actions] linked-session metadata cleanup failed before delete", error)
    }
  }

  if (isReviewSession(session)) {
    const originalSessionID = getOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutReviewSessionLink(metadata, sessionId))
    return
  }

  if (isBtwSession(session)) {
    const originalSessionID = getBtwOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutBtwSessionLink(metadata, sessionId))
    return
  }

  // Deleting or archiving a session that has an active btw fork also removes
  // the fork: it is a temporary session that only exists for its parent's
  // panel. Best-effort — a failed fork delete must not block the parent's
  // operation; the orphaned fork stays visible in the sidebar.
  const btwSessionID = getBtwSessionID(session)
  if (btwSessionID) {
    try {
      assertSessionActionRuntimeCurrent(runtimeContext)
      await deleteSession(btwSessionID, { expectedRuntimeKey: runtimeContext.runtimeKey })
      assertSessionActionRuntimeCurrent(runtimeContext)
    } catch (error) {
      if (error instanceof SessionActionRuntimeChangedError) throw error
      console.warn("[session-actions] failed to delete btw fork before parent delete", error)
    }
  }
}

/** Remove a server-confirmed session from every live child store that has it. */
function removeSessionFromLiveStores(sessionId: string, preferredDirectory?: string, archive = false): SessionListSnapshot[] {
  if (!_childStores) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []
  const normalizedPreferredDirectory = preferredDirectory ? normalizePath(preferredDirectory) : null

  if (normalizedPreferredDirectory) {
    const preferredStore = _childStores.getChild(normalizedPreferredDirectory)
    if (preferredStore) {
      candidates.push([normalizedPreferredDirectory, preferredStore])
      visited.add(normalizedPreferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    const containsSession = current.session.some((session) => session.id === sessionId)
    if (!containsSession && directory !== normalizedPreferredDirectory) continue
    snapshots.push({ directory })
    const patch: Partial<ReturnType<DirectoryStoreApi["getState"]>> = {
      session: current.session.filter((session) => session.id !== sessionId),
      ...sessionMutationPatch(current, sessionId, true),
    }
    if (archive) {
      patch.session_status = { ...current.session_status }
      delete patch.session_status[sessionId]
      patch.sessionStatusInvalidated = { ...current.sessionStatusInvalidated, [sessionId]: true }
    }
    store.setState(patch)
  }

  return snapshots
}

/**
 * Remove a batch of server-confirmed sessions from every live child store.
 *
 * Each affected store is written once for the whole batch. Removing the
 * sessions one at a time notified every subscriber — and therefore re-rendered
 * the sidebar — once per session, which is what made archiving a worktree's
 * sessions block the main thread for seconds.
 */
function removeSessionsFromLiveStores(sessionIds: Iterable<string>, preferredDirectory?: string, archive = false): SessionListSnapshot[] {
  const ids = new Set(sessionIds)
  if (!_childStores || ids.size === 0) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []

  if (preferredDirectory) {
    const preferredStore = _childStores.children.get(preferredDirectory)
    if (preferredStore) {
      candidates.push([preferredDirectory, preferredStore])
      visited.add(preferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    const removed = current.session.filter((session) => ids.has(session.id)).map((session) => session.id)
    if (removed.length === 0) continue

    snapshots.push({ directory })
    const patch: Partial<ReturnType<DirectoryStoreApi["getState"]>> = {
      session: current.session.filter((session) => !ids.has(session.id)),
      ...sessionsMutationPatch(current, removed, true),
    }
    if (archive) {
      patch.session_status = { ...current.session_status }
      patch.sessionStatusInvalidated = { ...current.sessionStatusInvalidated }
      for (const id of removed) {
        delete patch.session_status[id]
        patch.sessionStatusInvalidated[id] = true
      }
    }
    store.setState(patch)
  }

  return snapshots
}

function cleanupSessionWorktreeMetadata(sessionId: string): void {
  useSessionUIStore.getState().setWorktreeMetadata(sessionId, null)
}

function cleanupSessionNavigation(
  sessionId: string,
  runtimeContext: SessionActionRuntimeContext,
  clearWorktreeMetadata = false,
): void {
  clearPersistedSessionNavigation(sessionId, runtimeContext.runtimeKey)
  if (!isSessionActionRuntimeCurrent(runtimeContext)) return
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
  if (clearWorktreeMetadata) {
    cleanupSessionWorktreeMetadata(sessionId)
  }
}

function finalizeConfirmedSessionDeletion(
  sessionId: string,
  sessionDirectory: string | undefined,
  runtimeContext: SessionActionRuntimeContext,
): void {
  if (!isSessionActionRuntimeCurrent(runtimeContext)) return
  const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory)
  for (const store of _childStores?.children.values() ?? []) {
    const invalidated = store.getState().sessionStatusInvalidated
    if (!invalidated?.[sessionId]) continue
    const next = { ...invalidated }
    delete next[sessionId]
    store.setState({ sessionStatusInvalidated: next })
  }
  invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
  useGlobalSessionsStore.getState().removeSessions([sessionId])
  cleanupSessionNavigation(sessionId, runtimeContext, true)
  useMessageQueueStore.getState().dropSession(sessionId, {
    runtimeKey: runtimeContext.runtimeKey,
    generation: runtimeContext.runtimeGeneration,
  })
  if (sessionDirectory) {
    cleanupPersistedSessionState({
      runtimeKey: runtimeContext.runtimeKey,
      directory: sessionDirectory,
      sessionId,
    })
  }
}

type ChatDirectoryCleanupPlan = {
  directory: string | undefined
  /** Only a root session owns its managed chat directory. */
  rootDeleted: boolean
  /** The deleted session and the descendants the server cascade-deletes with it. */
  cascadeIds: ReadonlySet<string>
}

function planChatDirectoryCleanup(sessionId: string, snapshot: Session | null, directory: string | undefined): ChatDirectoryCleanupPlan {
  const global = useGlobalSessionsStore.getState()
  return {
    directory,
    rootDeleted: Boolean(snapshot && snapshot.parentID == null),
    cascadeIds: computeSubtreeIds([...global.activeSessions, ...global.archivedSessions], sessionId),
  }
}

/**
 * A managed chat directory is shared by every fork, side thread, and subagent
 * of the chat that created it, and OpenCode fails every prompt in a session
 * whose directory is gone. The directory is therefore removed only once no
 * known session outside the deleted subtree still resolves to it. An unloaded
 * global cache cannot prove that, so it keeps the directory: a leaked scratch
 * directory is recoverable, a stranded session is not.
 */
function isChatDirectoryStillReferenced(directory: string, excludedIds: ReadonlySet<string>): boolean {
  const global = useGlobalSessionsStore.getState()
  if (!global.hasLoaded) return true
  const normalized = normalizePath(directory)
  return [...global.activeSessions, ...global.archivedSessions].some((session) => (
    !excludedIds.has(session.id) && resolveGlobalSessionDirectory(session) === normalized
  ))
}

async function cleanupDeletedChatDirectory(
  plan: ChatDirectoryCleanupPlan,
  runtimeContext: SessionActionRuntimeContext,
): Promise<void> {
  if (!plan.directory || !plan.rootDeleted) return
  if (isChatDirectoryStillReferenced(plan.directory, plan.cascadeIds)) return
  try {
    assertSessionActionRuntimeCurrent(runtimeContext)
    await deleteChatDirectory(plan.directory, runtimeContext.runtimeKey)
  } catch (error) {
    console.warn("[session-actions] deleted chat directory cleanup failed", error)
  }
}

export type DeleteSessionOptions = {
  /**
   * Runtime key the deletion is scoped to. Defaults to the active runtime when
   * the action starts; callers may supply a key captured earlier when
   * confirmation spans a runtime switch.
   */
  expectedRuntimeKey?: string
}

/**
 * Delete one session.
 *
 * The runtime is rechecked before the request and again before any store is
 * reconciled, so a response produced by the previous runtime cannot mutate the
 * current runtime's state. Session IDs are not unique across runtimes, so
 * committing a stale deletion could otherwise evict an unrelated session and
 * erase its persisted queue, todos, drafts, folders, and pins.
 *
 * A `404` is treated as an already-completed deletion, but only when it is
 * still authoritative for the captured runtime. After a runtime change the
 * `404` describes either the previous runtime or a runtime this session never
 * belonged to; neither justifies committing cleanup here, so the action reports
 * failure and leaves reconciliation to the next authoritative load.
 */
export async function deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<boolean> {
  const runtimeContext = captureSessionActionRuntime()
  if (options?.expectedRuntimeKey && options.expectedRuntimeKey !== runtimeContext.runtimeKey) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  let remoteMutationStarted = false
  const chatDirectoryCleanup = planChatDirectoryCleanup(sessionId, getGlobalSessionSnapshot(sessionId), sessionDirectory)
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, runtimeContext)
    assertSessionActionRuntimeCurrent(runtimeContext)
    remoteMutationStarted = true
    const deleted = await deleteSessionRemotely(sessionId, sessionDirectory)
    if (!isSessionActionRuntimeCurrent(runtimeContext)) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, sessionDirectory, runtimeContext)
    await cleanupDeletedChatDirectory(chatDirectoryCleanup, runtimeContext)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSession failed", error)
    recordSessionActionFailure(sessionId, toError(error))
    // The server cascade-deletes child sessions when the parent is removed.
    // Subsequent delete attempts for those children return 404; treat as
    // success since the session was already deleted by the cascade.
    if (remoteMutationStarted && (error as { status?: number })?.status === 404) {
      if (!isSessionActionRuntimeCurrent(runtimeContext)) return false
      finalizeConfirmedSessionDeletion(sessionId, sessionDirectory, runtimeContext)
      await cleanupDeletedChatDirectory(chatDirectoryCleanup, runtimeContext)
      return true
    }
    return false
  }
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(
  sessionId: string,
  directory: string,
  expectedRuntimeKey?: string,
): Promise<boolean> {
  const runtimeContext = captureSessionActionRuntime()
  if (expectedRuntimeKey && expectedRuntimeKey !== runtimeContext.runtimeKey) return false
  if (!runtimeContext.childStores) return false
  let remoteMutationStarted = false
  const chatDirectoryCleanup = planChatDirectoryCleanup(sessionId, getGlobalSessionSnapshot(sessionId), directory)
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, directory, runtimeContext)
    assertSessionActionRuntimeCurrent(runtimeContext)
    remoteMutationStarted = true
    const deleted = await deleteSessionRemotely(sessionId, directory)
    if (!isSessionActionRuntimeCurrent(runtimeContext)) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, directory, runtimeContext)
    await cleanupDeletedChatDirectory(chatDirectoryCleanup, runtimeContext)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSessionInDirectory failed", error)
    if (remoteMutationStarted && (error as { status?: number })?.status === 404) {
      if (!isSessionActionRuntimeCurrent(runtimeContext)) return false
      finalizeConfirmedSessionDeletion(sessionId, directory, runtimeContext)
      await cleanupDeletedChatDirectory(chatDirectoryCleanup, runtimeContext)
      return true
    }
    return false
  }
}

export type DeleteSessionsOptions = {
  expectedRuntimeKey?: string
}

/** Delete sessions sequentially while preserving truthful partial results. */
export async function deleteSessions(
  ids: string[],
  options?: DeleteSessionsOptions,
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  const deletedIds: string[] = []
  const failedIds: string[] = []
  const runtimeContext = captureSessionActionRuntime()
  if (options?.expectedRuntimeKey && options.expectedRuntimeKey !== runtimeContext.runtimeKey) {
    return { deletedIds, failedIds: [...ids] }
  }

  for (const [index, id] of ids.entries()) {
    if (!isSessionActionRuntimeCurrent(runtimeContext)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await deleteSession(id, { expectedRuntimeKey: runtimeContext.runtimeKey })) deletedIds.push(id)
    else failedIds.push(id)
  }

  return { deletedIds, failedIds }
}

export async function archiveSession(
  sessionId: string,
  directoryOverride?: string,
  expectedRuntimeKey?: string,
): Promise<boolean> {
  const runtimeContext = captureSessionActionRuntime()
  if (expectedRuntimeKey && expectedRuntimeKey !== runtimeContext.runtimeKey) return false
  const sessionDirectory = directoryOverride ?? getSessionDirectory(sessionId)
  const archivedAt = Date.now()
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, runtimeContext)
    assertSessionActionRuntimeCurrent(runtimeContext)
    let archived: Session | null
    if (isNativeSessionId(sessionId)) {
      archived = await requireNativeAgents().updateSession(sessionId, requireNativeDirectory(sessionDirectory), { archived: true })
    } else {
      if (!sessionDirectory) throw new Error("archive failed: session directory is unknown")
      const result = await requestSessionArchiveBatch(sessionDirectory, [sessionId], archivedAt)
      assertSessionActionRuntimeCurrent(runtimeContext)
      if (result.outcome !== "archived") throw new Error(`archive failed: ${result.reason}`)
      const stamp = result.archived.find((entry) => entry.id === sessionId)
      if (!stamp) throw new Error("archive failed: server did not return the archived session")
      archived = withArchivedAt(sessionId, stamp.archivedAt)
    }
    assertSessionActionRuntimeCurrent(runtimeContext)
    const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory, true)
    invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
    if (archived) useGlobalSessionsStore.getState().upsertSession(archived)
    cleanupSessionNavigation(sessionId, runtimeContext)
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    recordSessionActionFailure(sessionId, toError(error))
    return false
  }
}

export type ArchiveSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Archive several sessions, preserving partial results.
 *
 * Sessions that carry no review or btw link are archived by their directory's
 * server in one request, and the whole answer is reconciled with a single store
 * write. The remainder — review sessions, btw forks, sessions with an active
 * btw fork, and any session this client does not hold — keep the per-session
 * path, because unlinking a partner is UI-owned work that reads and rewrites
 * another session's metadata.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When
 * `expectedRuntimeKey` is supplied and the runtime changes mid-batch, the
 * already-confirmed sessions stay in `archivedIds` and every ID that was not
 * confirmed on the captured runtime is reported in `failedIds`, so callers keep
 * showing the existing partial-failure feedback instead of silently dropping
 * work.
 */
export async function archiveSessions(
  ids: string[],
  options?: ArchiveSessionsOptions,
): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  const archivedIds: string[] = []
  const failedIds: string[] = []
  const runtimeContext = captureSessionActionRuntime()
  if (options?.expectedRuntimeKey && options.expectedRuntimeKey !== runtimeContext.runtimeKey) {
    return { archivedIds, failedIds: [...ids] }
  }
  if (ids.length === 0) return { archivedIds, failedIds }

  const plan = planArchiveBatches(ids)

  for (const [directory, batchIds] of plan.batchesByDirectory) {
    if (!isSessionActionRuntimeCurrent(runtimeContext)) {
      failedIds.push(...batchIds)
      continue
    }

    const archivedAt = Date.now()
    registerBulkArchiveEchoes(
      runtimeContext.runtimeKey,
      batchIds.map((id) => ({ id, archivedAt })),
    )
    const result = await requestSessionArchiveBatch(directory, batchIds, archivedAt)
    if (!isSessionActionRuntimeCurrent(runtimeContext)) {
      failedIds.push(...batchIds)
      continue
    }

    if (result.outcome === "archived") {
      releaseBulkArchiveEchoes(runtimeContext.runtimeKey, batchIds)
      registerBulkArchiveEchoes(
        runtimeContext.runtimeKey,
        result.archived,
      )
      commitArchivedSessions(result.archived, directory)
      archivedIds.push(...result.archived.map((entry) => entry.id))
      failedIds.push(...result.failedIds)
      continue
    }

    // The runtime does not serve the batch route, or its answer could not be
    // trusted. Archiving each session individually is slower but reaches the
    // same state, and re-archiving a session the server already archived writes
    // the same field again.
    console.warn("[session-actions] archive batch unavailable, archiving one by one", result.reason)
    releaseBulkArchiveEchoes(runtimeContext.runtimeKey, batchIds)
    plan.individualIds.push(...batchIds)
  }

  for (const [index, id] of plan.individualIds.entries()) {
    if (!isSessionActionRuntimeCurrent(runtimeContext)) {
      failedIds.push(...plan.individualIds.slice(index))
      break
    }
    if (await archiveSession(id, undefined, runtimeContext.runtimeKey)) archivedIds.push(id)
    else failedIds.push(id)
  }

  return { archivedIds, failedIds }
}

/**
 * A session whose archive also has to rewrite another session's metadata.
 *
 * Review sessions and btw forks point at a parent that must be unlinked, and a
 * parent with an active btw fork has to delete that fork. Those are
 * read-modify-write pairs on a second session, so they stay on the per-session
 * path instead of the server batch.
 */
function hasLinkedSessionCleanup(session: Session): boolean {
  return isReviewSession(session) || isBtwSession(session) || Boolean(getBtwSessionID(session))
}

/**
 * Split the requested IDs into per-directory server batches and the sessions
 * that must be archived individually.
 *
 * Link classification reads this client's session records rather than
 * refetching each session: those records are kept current by the same
 * `session.updated` events that publish a link created anywhere else, so a
 * fetch per session would buy no authority the store does not already have.
 * A session this client does not hold is classified as individual, which
 * restores the per-session fetch for exactly the cases where the store has
 * nothing to say.
 */
function planArchiveBatches(ids: string[]) {
  const global = useGlobalSessionsStore.getState()
  const knownSessions = new Map<string, Session>()
  for (const session of [...global.activeSessions, ...global.archivedSessions]) {
    knownSessions.set(session.id, session)
  }
  for (const store of _childStores?.children.values() ?? []) {
    for (const session of store.getState().session) knownSessions.set(session.id, session)
  }

  const batchesByDirectory = new Map<string, string[]>()
  const individualIds: string[] = []

  for (const id of ids) {
    const session = knownSessions.get(id)
    const directory = session
      ? resolveGlobalSessionDirectory(session) ?? getSessionDirectory(id)
      : undefined
    // The batch route archives OpenCode sessions; native ones go one by one.
    if (!session || !directory || hasLinkedSessionCleanup(session) || isNativeSessionId(id)) {
      individualIds.push(id)
      continue
    }
    const batch = batchesByDirectory.get(directory)
    if (batch) batch.push(id)
    else batchesByDirectory.set(directory, [id])
  }

  return { batchesByDirectory, individualIds }
}

/**
 * Reconcile a server-confirmed archive batch with one write per store.
 *
 * This mirrors what `archiveSession` does for a single session — drop it from
 * the live directory stores, invalidate its cached messages, move it to the
 * archived bucket, and clear it if it was open — with the per-session store
 * notifications collapsed into one.
 */
function commitArchivedSessions(stamps: SessionArchiveStamp[], directory: string): void {
  if (stamps.length === 0) return

  const ids = stamps.map((stamp) => stamp.id)
  const archived = stamps.flatMap((stamp) => withArchivedAt(stamp.id, stamp.archivedAt) ?? [])
  const snapshots = removeSessionsFromLiveStores(ids, directory, true)
  const directories = [...snapshots.map((snapshot) => snapshot.directory), directory]
  for (const id of ids) invalidateSessionLoads(id, directories)

  useGlobalSessionsStore.getState().upsertSessions(archived)

  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId && ids.includes(ui.currentSessionId)) ui.setCurrentSession(null)
}

/**
 * Restore one archived session back to the active list.
 *
 * Same contract as `archiveSession`: waits for server confirmation before
 * reconciling stores, and rejects stale runtimes so a response produced by a
 * previous runtime cannot mutate the current runtime's state. Archive state is
 * OpenChamber's own (OpenCode has no route for it), so this goes to the
 * OpenChamber unarchive route rather than the OpenCode client.
 */
export async function unarchiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  const runtimeContext = captureSessionActionRuntime()
  if (expectedRuntimeKey !== runtimeContext.runtimeKey) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  try {
    let restored: Session | null
    if (isNativeSessionId(sessionId)) {
      restored = await requireNativeAgents().updateSession(sessionId, requireNativeDirectory(sessionDirectory), { archived: false })
    } else {
      const result = await requestSessionUnarchiveBatch([sessionId], sessionDirectory)
      assertSessionActionRuntimeCurrent(runtimeContext)
      if (result.outcome !== "restored") throw new Error(`unarchive failed: ${result.reason}`)
      if (!result.restored.includes(sessionId)) throw new Error("unarchive failed: server did not return the restored session")
      restored = withArchivedAt(sessionId, null)
    }
    assertSessionActionRuntimeCurrent(runtimeContext)
    if (restored) useGlobalSessionsStore.getState().upsertSession(restored)
    if (sessionDirectory) registerSessionDirectory(sessionId, sessionDirectory)
    promoteRestoredSessionOrdering(sessionId)
    // Archive discarded this session's status. An older directory snapshot
    // cannot certify it idle after restore; only a fresh live read can.
    const store = sessionDirectory ? _childStores?.getChild(sessionDirectory) : undefined
    if (store) {
      const before = store.getState()
      // The restore already committed. A rejected status read is unknown, not
      // an action failure or a reason to mark this session idle.
      const statuses = await (isNativeSessionId(sessionId)
        ? requireNativeAgents().statuses(requireNativeDirectory(sessionDirectory))
        : opencodeClient.getActiveSessionStatuses(sessionDirectory)).catch(() => null)
      if (!isStaleRuntime(expectedRuntimeKey) && statuses !== null) {
        store.setState((current) => {
          if (current.sessionStatusInvalidated !== before.sessionStatusInvalidated
            || current.session_status[sessionId] !== before.session_status[sessionId]) return current
          const invalidated = { ...current.sessionStatusInvalidated }
          delete invalidated[sessionId]
          return {
            session_status: { ...current.session_status, [sessionId]: statuses[sessionId] ?? { type: "idle" } },
            sessionStatusInvalidated: invalidated,
          }
        })
      }
    }
    return true
  } catch (error) {
    console.error("[session-actions] unarchiveSession failed", error)
    recordSessionActionFailure(sessionId, toError(error))
    return false
  }
}

export type UnarchiveSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Restore several archived sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When
 * `expectedRuntimeKey` is supplied and the runtime changes mid-batch, the
 * already-confirmed sessions stay in `restoredIds` and every ID that was not
 * confirmed on the captured runtime is reported in `failedIds`, so callers keep
 * showing truthful partial-failure feedback.
 */
export async function unarchiveSessions(
  ids: string[],
  options?: UnarchiveSessionsOptions,
): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  const restoredIds: string[] = []
  const failedIds: string[] = []
  const runtimeContext = captureSessionActionRuntime()
  if (options?.expectedRuntimeKey && options.expectedRuntimeKey !== runtimeContext.runtimeKey) {
    return { restoredIds, failedIds: [...ids] }
  }

  for (const [index, id] of ids.entries()) {
    if (!isSessionActionRuntimeCurrent(runtimeContext)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await unarchiveSession(id, runtimeContext.runtimeKey)) restoredIds.push(id)
    else failedIds.push(id)
  }

  return { restoredIds, failedIds }
}

export async function updateSessionTitle(
  sessionId: string,
  title: string,
  options?: { directory?: string | null; expectedRuntimeKey?: string; signal?: AbortSignal },
): Promise<void> {
  const runtimeContext = captureSessionActionRuntime()
  if (options?.expectedRuntimeKey && options.expectedRuntimeKey !== runtimeContext.runtimeKey) throw new Error("runtime changed")
  if (options?.signal) options.signal.throwIfAborted()
  else cancelSessionTitleGeneration(sessionId)
  const sessionDirectory = options?.directory ?? getSessionDirectory(sessionId)
  const session = await renameSessionRemotely(sessionId, sessionDirectory, title)
  assertSessionActionRuntimeCurrent(runtimeContext)
  options?.signal?.throwIfAborted()
  useGlobalSessionsStore.getState().upsertSession(session)
  mirrorSessionIntoLiveStores(session, sessionDirectory)
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 */
export async function optimisticSend(input: {
  providerID?: string
  modelID?: string
  agent?: string
  runtimeKey?: string
  sessionId: string
  content: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  messageId?: string
  appendSubmissions?: () => void
  onOptimisticInsert?: () => void
  onMessageID?: (messageID: string) => void
  beforeOptimisticInsert?: () => void | Promise<void>
  expectedRuntime?: { runtimeKey: string; generation: number }
  /** The actual API call — receives the optimistic messageID so the server can use the same ID */
  send: (messageID: string) => Promise<void>
}): Promise<void> {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new Error("Optimistic refs not set — is useSync() mounted?")
  }
  const optimisticAdd = _optimisticAdd
  const optimisticRemove = _optimisticRemove
  const optimisticConfirm = _optimisticConfirm

  const assertExpectedRuntime = () => {
    if (
      input.expectedRuntime
      && (
        getRuntimeKey() !== input.expectedRuntime.runtimeKey
        || getRuntimeEndpointGeneration() !== input.expectedRuntime.generation
      )
    ) throw new RuntimeContextChangedError()
  }
  const assertCapturedRuntime = () => {
    if (input.runtimeKey && input.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }
  assertExpectedRuntime()
  assertCapturedRuntime()
  if (!isNativeSessionId(input.sessionId)) await waitForConnectionOrThrow()
  assertExpectedRuntime()
  assertCapturedRuntime()
  await input.beforeOptimisticInsert?.()
  assertExpectedRuntime()
  assertCapturedRuntime()
  input.appendSubmissions?.()

  const targetDirectory = input.directory ?? dir()
  const store = targetDirectory ? dirStoreForDirectory(targetDirectory) : dirStore()
  const stateBeforeSend = store.getState()
  const sessionBeforeSend = stateBeforeSend.session?.find((session) => session.id === input.sessionId)
  const revertMessageID = sessionBeforeSend?.revert?.messageID
  const messagesBeforeSend = stateBeforeSend.message[input.sessionId] ?? []
  const revertedMessages = messagesFrom(messagesBeforeSend, revertMessageID)
  const revertedParts = new Map(
    revertedMessages.map((message) => [message.id, stateBeforeSend.part[message.id] ?? []] as const),
  )

  if (revertMessageID) {
    const session = stateBeforeSend.session.map((candidate) => (
      candidate.id === input.sessionId ? { ...candidate, revert: undefined } as Session : candidate
    ))
    const message = {
      ...stateBeforeSend.message,
      [input.sessionId]: messagesBefore(messagesBeforeSend, revertMessageID),
    }
    const part = { ...stateBeforeSend.part }
    for (const revertedMessage of revertedMessages) delete part[revertedMessage.id]
    store.setState({ session, message, part })

    // A server-backed user message can still remain in the loader's optimistic
    // shadow until a page fetch confirms it. Forget the reverted branch there
    // too, or the next tail refresh will merge those deleted messages back in.
    for (const revertedMessage of revertedMessages) {
      _optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID: revertedMessage.id,
      })
    }
  }

  const messageID = input.messageId ?? createOpenCodeIdentifier("msg")
  input.onMessageID?.(messageID)

  // Each source must echo the optimistic part IDs. Native projectors use
  // `_pN` / `_fN`; OpenCode uses the wire projection's `partIds`.
  const native = isNativeSessionId(input.sessionId)
  const optimisticParts: Part[] = [
    { id: native ? `${messageID}_p0` : partIds.userText(messageID), sessionID: input.sessionId, messageID, type: "text", text: input.content },
  ]
  if (input.files) {
    input.files.forEach((file, index) => {
      optimisticParts.push({
        id: native ? `${messageID}_f${index}` : partIds.userFile(messageID, index),
        sessionID: input.sessionId,
        messageID,
        type: "file",
        mime: file.mime,
        url: file.url,
        filename: file.filename,
      })
    })
  }

  // A user message carries no model or agent in the v2 domain model: the turn's
  // provider and agent belong to the assistant message the server produces.
  const optimisticMessage: UserMessage = {
    id: messageID,
    role: "user",
    sessionID: input.sessionId,
    // A user message never completes a turn; only assistant messages carry
    // `time.completed`, and readers treat its presence as "turn finished".
    time: { created: Date.now() },
  }
  if (isNativeSessionId(input.sessionId)) {
    optimisticMessage.agent = input.agent
    if (input.providerID && input.modelID) optimisticMessage.model = { providerID: input.providerID, modelID: input.modelID }
  }

  // Insert into store + register in shadow Map (for mergeOptimisticPage cleanup)
  optimisticAdd({
    sessionID: input.sessionId,
    directory: targetDirectory,
    message: optimisticMessage,
    parts: optimisticParts,
  })
  input.onOptimisticInsert?.()

  // Set busy status
  const current = store.getState()
  store.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
  })
  setGlobalSessionStatus(input.sessionId, targetDirectory, "busy", { optimistic: true })

  try {
    assertExpectedRuntime()
    assertCapturedRuntime()
    await input.send(messageID)
  } catch (error) {
    assertExpectedRuntime()
    const status = getErrorStatus(error)
    const capturedRuntimeCurrent = !input.runtimeKey || input.runtimeKey === getRuntimeKey()
    const ambiguousFailure = capturedRuntimeCurrent && isAmbiguousSendFailure(error)
    const confirmation = ambiguousFailure
      ? await fetchRecentSendConfirmationRecords(
        input.sessionId,
        messageID,
        targetDirectory,
        assertExpectedRuntime,
      )
      : null
    assertExpectedRuntime()

    if (confirmation?.outcome === "confirmed") {
      materializeConfirmedSendRecords(store, input.sessionId, messageID, confirmation.records)
      optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID,
      })
      return
    }

    if (confirmation?.outcome === "unknown") {
      // The server could not be reached to confirm the send. The message may
      // already be accepted; rolling it back now lets the composer re-send a
      // prompt the engine is already answering. Keep the optimistic message in
      // place and resolve the outcome on a timer instead.
      recordSendFailure({
        sessionId: input.sessionId,
        messageId: messageID,
        directory: targetDirectory ?? null,
        status,
        ambiguous: true,
        confirmationChecked: true,
        reason: error instanceof Error ? error.message : String(error),
      })
      scheduleUnconfirmedSendResolution({
        runtimeKey: input.runtimeKey ?? getRuntimeKey(),
        sessionId: input.sessionId,
        messageId: messageID,
        directory: targetDirectory ?? null,
        content: input.content,
        startedAt: Date.now(),
        attempts: 0,
      })
      throw new UnconfirmedSendError(input.sessionId, messageID, targetDirectory ?? null)
    }

    // The rollback below makes the user's message disappear with no other
    // trace, and the composer intentionally stays silent for transport-level
    // failures. Record the failure so the About dialog's diagnostics report can
    // answer "it disappeared and nothing happened" with an actual cause.
    // `reason` is truncated by the recorder: a rejected send echoes the
    // provider/OpenCode response body, which this log has no reason to keep.
    const failureRecord = {
      sessionId: input.sessionId,
      messageId: messageID,
      directory: targetDirectory ?? null,
      status,
      ambiguous: ambiguousFailure,
      confirmationChecked: ambiguousFailure,
      reason: error instanceof Error ? error.message : String(error),
    }
    recordSendFailure(failureRecord)
    console.warn("[session-actions] prompt send rejected; rolling back optimistic message", failureRecord)

    // Rollback via optimistic infrastructure
    optimisticRemove({
      sessionID: input.sessionId,
      directory: targetDirectory,
      messageID,
    })
    const rollbackState = store.getState()
    let session = rollbackState.session
    let message = rollbackState.message
    let part = rollbackState.part

    if (revertMessageID) {
      session = rollbackState.session.map((candidate) => (
        candidate.id === input.sessionId ? { ...candidate, revert: sessionBeforeSend?.revert } as Session : candidate
      ))
      message = {
        ...rollbackState.message,
        [input.sessionId]: mergeMessages(rollbackState.message[input.sessionId] ?? [], revertedMessages),
      }
      part = { ...rollbackState.part }
      for (const [revertedMessageID, parts] of revertedParts) {
        part[revertedMessageID] = parts
      }
    }

    store.setState({
      session,
      message,
      part,
      session_status: {
        ...rollbackState.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    setGlobalSessionStatus(input.sessionId, targetDirectory, "idle")
    throw error
  }
}

type SendConfirmationOutcome =
  | { outcome: "confirmed"; records: Array<{ info: Message; parts: Part[] }> }
  | { outcome: "not-found" }
  | { outcome: "unknown" }

// The newest messages of a session, to look for a send whose answer was lost.
// A native session's history comes from the OpenChamber server; OpenCode
// refuses its id, which would leave every ambiguous native send unconfirmed.
async function readSendConfirmationRecords(
  sessionId: string,
  directory?: string | null,
): Promise<Array<{ info: Message; parts: Part[] }>> {
  if (isNativeSessionId(sessionId)) {
    const page = await requireNativeAgents().loadMessages(sessionId, requireNativeDirectory(directory), {
      limit: SEND_CONFIRMATION_REFETCH_LIMIT,
    })
    return page.records
  }
  const page = await opencodeClient.getSessionMessages(sessionId, { limit: SEND_CONFIRMATION_REFETCH_LIMIT }, directory)
  return page.items.filter((record) => Boolean(record.info.id))
}

async function fetchRecentSendConfirmationRecords(
  sessionId: string,
  messageID: string,
  directory?: string | null,
  assertExpectedRuntime?: () => void,
): Promise<SendConfirmationOutcome> {
  // Bounded: a connection that never returns must still let the send fail
  // rather than hang the composer.
  const reconnectDeadline = Date.now() + SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS
  while (!useConfigStore.getState().isConnected && Date.now() < reconnectDeadline) {
    await wait(SEND_CONFIRMATION_RECONNECT_POLL_MS)
  }

  // A refetch that fails is not evidence the message is absent — it is no
  // evidence at all. Only a successful query may answer "not found"; queries
  // that all fail must surface as "unknown" so the caller can keep the
  // optimistic message instead of rolling back a possibly-accepted prompt.
  let anyQuerySucceeded = false
  for (let attempt = 0; attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS * 2 ** (attempt - 1))
    assertExpectedRuntime?.()
    try {
      const records = await readSendConfirmationRecords(sessionId, directory)
      anyQuerySucceeded = true
      if (records.some((record) => record.info.id === messageID)) {
        assertExpectedRuntime?.()
        return { outcome: "confirmed", records }
      }
    } catch {
      // Confirmation is best-effort; a failed query keeps the outcome unknown.
    }
    assertExpectedRuntime?.()
  }
  return anyQuerySucceeded ? { outcome: "not-found" } : { outcome: "unknown" }
}

function scheduleUnconfirmedSendResolution(entry: UnconfirmedSendEntry): void {
  const key = unconfirmedSendKey(entry.sessionId, entry.messageId)
  if (unconfirmedSendTimers.has(key)) return
  const backoffDelay = entry.attempts === 0
    ? UNCONFIRMED_SEND_FIRST_CHECK_MS
    : UNCONFIRMED_SEND_CHECK_BACKOFF_MS * 2 ** Math.min(entry.attempts - 1, 4)
  // Never let a backoff step overshoot the total wait cap by much: the final
  // resolution must run at (or very near) the cap so the user is not left
  // waiting for the next full backoff interval.
  const remainingBudget = Math.max(UNCONFIRMED_SEND_MAX_WAIT_MS - (Date.now() - entry.startedAt), 0)
  const delay = Math.min(backoffDelay, remainingBudget)
  const timer = setTimeout(() => {
    unconfirmedSendTimers.delete(key)
    void resolveUnconfirmedSend(entry)
  }, delay)
  unconfirmedSendTimers.set(key, timer)
}

async function resolveUnconfirmedSend(entry: UnconfirmedSendEntry): Promise<void> {
  // A runtime switch disposes the old runtime's stores and optimistic state;
  // never mutate state under a runtime that no longer owns this entry.
  if (entry.runtimeKey !== getRuntimeKey()) return

  let confirmation: SendConfirmationOutcome = { outcome: "unknown" }
  try {
    confirmation = await fetchRecentSendConfirmationRecords(entry.sessionId, entry.messageId, entry.directory)
  } catch {
    confirmation = { outcome: "unknown" }
  }

  if (entry.runtimeKey !== getRuntimeKey()) return

  if (confirmation.outcome === "confirmed") {
    const store = entry.directory ? dirStoreForDirectory(entry.directory) : dirStore()
    materializeConfirmedSendRecords(store, entry.sessionId, entry.messageId, confirmation.records)
    _optimisticConfirm?.({
      sessionID: entry.sessionId,
      directory: entry.directory,
      messageID: entry.messageId,
    })
    return
  }

  if (confirmation.outcome === "not-found") {
    rollbackUnconfirmedSend(entry)
    return
  }

  // Still unreachable: keep the optimistic message and try again later until
  // the total wait cap forces a rollback so the user is not blocked forever.
  if (Date.now() - entry.startedAt >= UNCONFIRMED_SEND_MAX_WAIT_MS) {
    rollbackUnconfirmedSend(entry)
    return
  }
  scheduleUnconfirmedSendResolution({ ...entry, attempts: entry.attempts + 1 })
}

// Exported so reconnect paths can resolve a pending send immediately instead
// of waiting for the next timer step, and so tests can drive the resolver
// directly without depending on cross-module fake timers.
export function resolveUnconfirmedSendNow(entry: UnconfirmedSendEntry): void {
  void resolveUnconfirmedSend(entry)
}

function rollbackUnconfirmedSend(entry: UnconfirmedSendEntry): void {
  const store = entry.directory ? dirStoreForDirectory(entry.directory) : dirStore()

  // The loader's optimisticRemove clears the shadow AND the visible store
  // message; it is safe when the message is already gone (e.g. the runtime
  // disposed the store), so a late rollback can never clobber authoritative
  // state.
  _optimisticRemove?.({
    sessionID: entry.sessionId,
    directory: entry.directory,
    messageID: entry.messageId,
  })
  store.setState({
    session_status: {
      ...store.getState().session_status,
      [entry.sessionId]: { type: "idle" as const },
    },
  })
  setGlobalSessionStatus(entry.sessionId, entry.directory, "idle")
  recordSendFailure({
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    directory: entry.directory,
    status: null,
    ambiguous: true,
    confirmationChecked: true,
    reason: "unconfirmed send resolved as not sent",
  })

  const rollback: UnconfirmedSendRollback = {
    runtimeKey: entry.runtimeKey,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    directory: entry.directory,
    content: entry.content,
  }
  for (const listener of unconfirmedSendRollbackListeners) {
    try {
      listener(rollback)
    } catch (error) {
      console.error("[session-actions] unconfirmed send rollback listener failed", error)
    }
  }
}

function materializeConfirmedSendRecords(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  records: Array<{ info: Message; parts: Part[] }>,
): void {
  store.setState((state) => {
    const currentMessages = state.message[sessionId]
    const message = { ...state.message }
    const part = { ...state.part }
    if (currentMessages) {
      const nextMessages = currentMessages.filter((message) => message.id !== messageID)
      message[sessionId] = nextMessages
    }
    delete part[messageID]

    const materialized = materializeSessionSnapshots(
      { ...state, message, part },
      sessionId,
      records,
    )
    return { message: materialized.message, part: materialized.part }
  })
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

/**
 * Compacts a native session through its CLI's own compaction, on the model
 * the composer has selected.
 */
export async function compactNativeSession(
  sessionId: string,
  selection: { providerID: string; modelID: string; variant?: string | null; agent?: string; instructions?: string },
): Promise<void> {
  const { directory } = dirStoreForSession(sessionId)
  const request: NativeCompactRequest = {
    directory: requireNativeDirectory(directory),
    model: { providerID: selection.providerID, modelID: selection.modelID },
    agent: nativeAgentOf(selection.agent),
  }
  if (selection.variant) request.variant = selection.variant
  if (selection.instructions !== undefined) request.instructions = selection.instructions
  await requireNativeAgents().compact(sessionId, request)
}

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  if (isNativeSessionId(sessionId)) {
    try {
      await requireNativeAgents().abort(sessionId)
    } catch (error) {
      console.error("[session-actions] native abort failed", error)
    }
    return
  }
  // The abort must carry the SESSION'S directory, not the active UI directory:
  // OpenCode routes the request to the per-directory instance, and an abort
  // sent to the wrong instance cancels nothing while still returning 200 true
  // (the "stop button does nothing" report — sessions in another project/
  // worktree than the UI's current directory could never be aborted).
  const { directory } = dirStoreForSession(sessionId)
  try {
    await opencodeClient.abortSession(sessionId, directory)
  } catch (error) {
    console.error("[session-actions] abort failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
  directoryOverride?: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = directoryOverride
    || resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  if (await opencodeClient.replyToPermission(sessionId, requestId, response, { directory }) !== true) {
    throw new Error("Permission reply failed")
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    if (await opencodeClient.replyToPermission(sessionId, requestId, "reject", { directory }) !== true) {
      throw new Error("Permission dismissal failed")
    }
  } catch (error) {
    if (isPermissionRequestNotFoundError(error)) {
      removePermissionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

/**
 * Dismiss every pending permission for the session subtree rooted at `sessionId`
 * (the session itself plus any subagent children). Used by the chat send path:
 * sending a message while a permission prompt is open must cancel/supersede the
 * open permission so it cannot linger or block the new turn.
 *
 * The permissions are removed from the local store OPTIMISTICALLY (before any
 * network call) so the prompt disappears instantly instead of waiting on the
 * `permission.reply` round-trip. Each permission is then formally rejected on
 * the backend via `permission.reply` with `reply: "reject"`, which fires
 * `permission.replied` for reconciliation.
 *
 * Returns true when at least one permission was dismissed. Rejection failures are
 * swallowed (a stranded permission must never block the send);
 * PermissionNotFoundError also clears the stale entry from the child store via
 * {@link dismissPermission}.
 *
 * Rejecting unblocks the agent's tool without guaranteeing an idle session.
 * The chat caller preserves explicit Steer as a direct send and queues other
 * follow-ups after dismissal. This helper does not choose message delivery.
 */
export async function dismissOpenPermissionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; requestId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const permissionsBySession = state.permission ?? {}
    for (const scopedId of scopedIds) {
      const requests = permissionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, requestId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the permissions from the local store so the prompt
  // disappears immediately, before the reject round-trip.
  for (const { sessionId: scopedSessionId, requestId } of toDismiss) {
    removePermissionRequestFromChildStores(scopedSessionId, requestId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, requestId }) => {
      try {
        await dismissPermission(scopedSessionId, requestId)
      } catch (error) {
        if (isPermissionRequestNotFoundError(error)) return
        // Swallow: a failed dismissal must not block the send. The next
        // permission.asked / permission.replied event reconciles the store.
        console.error("[session-actions] Failed to dismiss open permission on send:", error)
      }
    }),
  )
  return true
}

// ---------------------------------------------------------------------------
// Forms (the agent asking the user for input)
// ---------------------------------------------------------------------------

// A native question is answered by the OpenChamber server, which hands the
// answer to the CLI waiting on it. Success and a question that is already gone
// both clear it locally, as for OpenCode questions below.
async function settleNativeQuestion(sessionId: string, requestId: string, settle: () => Promise<void>): Promise<void> {
  try {
    await settle()
    removeFormRequestFromChildStores(sessionId, requestId)
  } catch (error) {
    if (error instanceof NativeAgentsRequestError && error.code === NATIVE_QUESTION_GONE) {
      removeFormRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

/** One filled-in form: every field the agent declared, keyed by field key. */
export type FormAnswer = Record<string, string | number | boolean | string[]>

export async function replyToForm(
  sessionId: string,
  formId: string,
  answer: FormAnswer,
): Promise<void> {
  if (!isNativeSessionId(sessionId)) await waitForConnectionOrThrow()
  if (isNativeSessionId(sessionId)) {
    await settleNativeQuestion(sessionId, formId, () => requireNativeAgents().replyQuestion(formId, nativeQuestionAnswers(answer)))
    return
  }
  const directory = getRequestReplyDirectory("form", sessionId, formId)
  try {
    if (await opencodeClient.replyToForm(sessionId, formId, answer, directory) !== true) {
      throw new Error("Form reply failed")
    }
    // A successful reply is authoritative: the backend resolved the form, so
    // clear it from the local store deterministically instead of waiting for
    // the SSE `form.replied` event. A lost event (SSE gap) would leave the
    // form pending forever, which keeps the session in "waiting for answer" —
    // the next task's thinking and final response never render (issues #2911,
    // #2448). The later SSE event is a no-op (the reducer only removes when
    // present).
    removeFormRequestFromChildStores(sessionId, formId)
  } catch (error) {
    if (isFormRequestNotFoundError(error)) {
      removeFormRequestFromChildStores(sessionId, formId)
      recoverStaleBlockingRequest(sessionId)
    }
    throw error
  }
}

export async function cancelForm(sessionId: string, formId: string): Promise<void> {
  if (!isNativeSessionId(sessionId)) await waitForConnectionOrThrow()
  if (isNativeSessionId(sessionId)) {
    await settleNativeQuestion(sessionId, formId, () => requireNativeAgents().rejectQuestion(formId))
    return
  }
  const directory = getRequestReplyDirectory("form", sessionId, formId)
  try {
    if (await opencodeClient.cancelForm(sessionId, formId, directory) !== true) {
      throw new Error("Form cancellation failed")
    }
    // A successful cancellation is authoritative; see replyToForm for the
    // lost-SSE-event rationale (issues #2911, #2448).
    removeFormRequestFromChildStores(sessionId, formId)
  } catch (error) {
    if (isFormRequestNotFoundError(error)) {
      removeFormRequestFromChildStores(sessionId, formId)
      recoverStaleBlockingRequest(sessionId)
    }
    throw error
  }
}

/**
 * Cancel every pending form for the session subtree rooted at `sessionId` (the
 * session itself plus any subagent children). Used by the chat send path:
 * sending a message while a form is open must supersede it so it cannot linger
 * or strand the session in a half-answered state.
 *
 * The forms are removed from the local store OPTIMISTICALLY (before any network
 * call) so the prompt disappears instantly instead of waiting on the round
 * trip. Each form is then formally cancelled on the backend, which fires
 * `form.cancelled` for reconciliation.
 *
 * Returns true when at least one form was cancelled. Failures are swallowed (a
 * stranded form must never block the send); a not-found error also clears the
 * stale entry from the child store via {@link cancelForm}.
 *
 * Rejecting unblocks the agent's tool without guaranteeing an idle session.
 * The chat caller preserves explicit Steer as a direct send (the inbox takes
 * it while the turn is still active) and queues other follow-ups after
 * dismissal. This helper does not abort the session.
 */
export async function dismissOpenFormsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; formId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const formsBySession: Record<string, FormRequest[]> = state.form ?? {}
    for (const scopedId of scopedIds) {
      const requests = formsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, formId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the forms from the local store so the prompt
  // disappears immediately, before the cancel round-trip.
  for (const { sessionId: scopedSessionId, formId } of toDismiss) {
    removeFormRequestFromChildStores(scopedSessionId, formId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, formId }) => {
      try {
        await cancelForm(scopedSessionId, formId)
      } catch (error) {
        if (isFormRequestNotFoundError(error)) return
        if (error instanceof NativeAgentsRequestError && error.code === NATIVE_QUESTION_GONE) return
        // Swallow: a failed cancellation must not block the send. The next
        // form.created / form.cancelled event reconciles the store.
        console.error("[session-actions] Failed to cancel open form on send:", error)
      }
    }),
  )
  return true
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/** What a revert did beyond hiding messages, when the user should know. */
export type RevertOutcome = {
  /** No snapshot of the files before the message exists, so only the conversation went back. */
  conversationOnly: boolean
}

/**
 * Revert to a specific user message.
 *
 * 1. Abort if session is busy
 * 2. Extract text from the target message for prompt restoration
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Call the runtime revert endpoint and merge returned session
 * 5. Set pendingInputText so the reverted message text appears in the input
 *
 * A native session's server stops its running turn and restores its files
 * itself; its history is loaded through the native loader, so the message
 * must already be in the store.
 */
export async function revertToMessage(sessionId: string, messageId: string): Promise<RevertOutcome> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()
  const native = isNativeSessionId(sessionId)

  const localTarget = state.message[sessionId]?.find((message) => message.id === messageId)
  const targetMessage = localTarget ?? (native
    ? undefined
    : (await fetchSessionMessages(sessionId, directory)).find((message) => message.id === messageId))
  if (!targetMessage) throw new Error(`Cannot revert session: message ${messageId} was not found`)

  // Abort if busy before mutating session state
  const status = state.session_status[sessionId]
  if (!native && status && status.type !== "idle") {
    try {
      await opencodeClient.abortSession(sessionId, directory)
    } catch {
      // ignore abort errors
    }
  }

  // Extract message text for prompt restoration.
  const messages = state.message[sessionId] ?? []
  const targetMsg = messages.find((m) => m.id === messageId)
  let messageText = ""
  let submittedFileParts: FilePart[] = []
  let submittedContextParts: readonly ContextCarrierPart[] = []
  if (targetMsg && targetMsg.role === "user") {
    const parts = state.part[messageId] ?? []
    // Every part on a user message is the user's own: OpenCode 2.x delivers
    // injected context as synthetic messages, not as parts of this one.
    messageText = parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    // Snapshot file parts for later restoration to the input.
    submittedFileParts = parts.filter((part): part is FilePart => part.type === "file")
    // Attached context (review comments, quotes, terminal selections) rides in
    // the synthetic messages before this one and belongs back on the chips.
    submittedContextParts = contextCarriersForMessage(messages, messageId)
  }
  const revertMessageID = transcriptCutForMessage(messages, messageId)

  // Optimistically set only the revert marker. Keep messages and parts in the
  // local store; visible-message selectors derive the displayed timeline from
  // session.revert. This matches the server model and preserves reverted
  // messages for the restore dock without maintaining a separate shadow copy.
  const prevRevert = state.session.find((candidate) => candidate.id === sessionId)?.revert
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: revertMessageID } }
    store.setState({ session: sessions })
  }

  // Save input store state before mutations — if the API fails we need to
  // roll back both text and attachments to their previous values.
  const prevInputAttachments = [...useInputStore.getState().attachedFiles]
  const prevInputText = useInputStore.getState().pendingInputText
  const prevInputMode = useInputStore.getState().pendingInputMode
  const draftTarget: InlineCommentDraftTarget | null = directory
    ? { directory, sessionKey: sessionId }
    : null
  const prevDrafts = draftTarget ? useInlineCommentDraftStore.getState().getDrafts(draftTarget) : []

  // Restore reverted message text and file attachments to input
  if (messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }

  // Restore file/image attachments from the target message.
  // Clear existing attachments first — previous revert's attachments
  // must not carry over, even when the current message has no files.
  restoreFilePartsToInput(submittedFileParts)
  if (draftTarget) restoreContextPartsToInput(submittedContextParts, draftTarget)

  // Call SDK and merge authoritative result into store
  try {
    let revertedSession: Session
    let conversationOnly = false
    if (native) {
      // Subagent sessions of a native session are views of its transcript;
      // rewinding the parent is the whole revert.
      const result = await requireNativeAgents().revert(sessionId, messageId, requireNativeDirectory(directory))
      revertedSession = result.session
      conversationOnly = result.conversationOnly
    } else {
      // Descendants go first because OpenCode also restores file snapshots during
      // revert. All sessions share a directory, so the parent's snapshot must win.
      await cascadeRevertToDescendants(sessionId, targetMessage.time.created)
      await opencodeClient.stageRevert(sessionId, revertMessageID, { directory })
      revertedSession = await opencodeClient.getSession(sessionId, directory)
    }
    const current = store.getState()
    const updated = [...current.session]
    const idx = updated.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      updated[idx] = revertedSession
      store.setState({ session: updated })
    }
    if (directory) {
      sessionEvents.requestGitRefresh({ directory })
    }
    return { conversationOnly }
  } catch (err) {
    // Rollback: restore removed messages + revert marker
    const current = store.getState()
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert }
    }
    store.setState({
      session: rollback,
    })
    // Rollback input store: restore previous text and attachments
    useInputStore.setState({
      pendingInputText: prevInputText,
      pendingInputMode: prevInputMode,
      attachedFiles: prevInputAttachments,
    })
    if (draftTarget) {
      useInlineCommentDraftStore.getState().clearDrafts(draftTarget)
      useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, prevDrafts)
    }
    throw err
  }
}

export async function refetchSessionMessages(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const loader = getImperativeSessionMessageLoader()
  if (loader && directory) {
    await loader.refreshTail({ directory, sessionID: sessionId }, MESSAGE_REFETCH_LIMIT)
    const snapshot = loader.getSnapshot({ directory, sessionID: sessionId })
    if (snapshot.status === "error") throw snapshot.error ?? new Error("Session message refresh failed")
    return
  }

  // Actions can run in isolated tests before SyncProvider binds the shared
  // loader. The application runtime always takes the shared path above.
  const page = await opencodeClient.getSessionMessages(sessionId, { limit: MESSAGE_REFETCH_LIMIT }, directory)
  const records = page.items.filter((record) => !!record.info?.id)
  if (records.length === 0) return

  store.setState((state) => {
    const materialized = materializeSessionSnapshots(state, sessionId, records)
    return { message: materialized.message, part: materialized.part }
  })
}

/** Insert the fork into the child store so the sidebar updates immediately, then switch to it. */
function openForkedSession(store: DirectoryStoreApi, forkedSession: Session, directory: string | null | undefined) {
  const sessions = [...store.getState().session]
  const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, forkedSession)
    store.setState({ session: sessions })
  }
  useSessionUIStore.getState().setCurrentSession(forkedSession.id, directory)
}

/**
 * The fork keeps the source's goal (OpenCode copies metadata) but not the
 * source's btw/review links; a file-backed objective is copied to the fork.
 * The objective copy re-reads the fork's goal id first and is skipped when the
 * user armed a new goal on the fork in the meantime.
 */
function inheritForkMetadata(sourceSessionId: string, forkedSession: Session, directory: string | null | undefined, expectedRuntimeKey: string) {
  return applyForkInheritance(sourceSessionId, forkedSession, {
    readGoalId: async (sessionId) => getSessionGoal(isNativeSessionId(sessionId)
      ? await requireNativeAgents().getSession(sessionId, requireNativeDirectory(directory))
      : await opencodeClient.getSession(sessionId, directory))?.id ?? null,
    readObjective: fetchGoalObjectiveContent,
    writeObjective: writeGoalObjectiveFile,
    patchMetadata: async (sessionId, updater) => {
      await patchSessionMetadata(sessionId, directory, updater, { runtimeKey: expectedRuntimeKey })
    },
  })
}

/**
 * Fork keeping an assistant turn: the new session holds everything through
 * `messageId`, so the agent there still sees the answer it just gave. The cut
 * is the first user message after it; with none, the whole transcript is copied.
 * The composer stays empty since there is no prompt to rewrite.
 */
export async function forkAfterMessage(sessionId: string, messageId: string): Promise<Session | null> {
  const expectedRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId)
  const messages = store.getState().message[sessionId] ?? []
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) throw new Error("Fork source message is not loaded")
  const nextUserMessage = messages.slice(index + 1).find((message) => message.role === "user")

  const forkedSession = isNativeSessionId(sessionId)
    ? await forkNativeSession(sessionId, nextUserMessage?.id ?? null, directory)
    : await opencodeClient.forkSession(sessionId, {
      before: nextUserMessage ? transcriptCutForMessage(messages, nextUserMessage.id) : undefined,
      directory,
    })
  if (isStaleRuntime(expectedRuntimeKey)) return null
  const forkDirectory = resolveSessionOwnedDirectory(forkedSession) ?? directory
  openForkedSession(store, forkedSession, forkDirectory)
  await inheritForkMetadata(sessionId, forkedSession, forkDirectory, expectedRuntimeKey)
  return forkedSession
}

/**
 * The last assistant message of the last finished turn, or null when there is
 * none. While a turn runs, everything from its prompt (the last user message)
 * on is excluded: a step inside it can already carry `time.completed` while the
 * turn keeps going, so only turns before it count as stable.
 */
export function findLastCompletedTurnMessageId(messages: readonly Message[], turnRunning: boolean): string | null {
  let end = messages.length
  if (turnRunning) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        end = index
        break
      }
    }
  }
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "assistant" && message.time.completed !== undefined) return message.id
  }
  return null
}

/** The session has no finished turn yet, so a fork would copy nothing stable. */
export class NothingToForkError extends Error {
  constructor() {
    super("No completed turn to fork from")
    this.name = "NothingToForkError"
  }
}

/**
 * `/fork`: fork after the last finished turn and open the fork. A running turn
 * in the source session is left alone and not copied.
 */
export async function forkFromLastCompletedTurn(sessionId: string): Promise<Session | null> {
  const { store } = dirStoreForSession(sessionId)
  const state = store.getState()
  const status = state.session_status?.[sessionId]
  const turnRunning = status !== undefined && status.type !== "idle"
  const messageId = findLastCompletedTurnMessageId(state.message[sessionId] ?? [], turnRunning)
  if (!messageId) throw new NothingToForkError()
  return forkAfterMessage(sessionId, messageId)
}

/**
 * A copy of a native session holding the conversation before a user message,
 * or all of it when `beforeMessageId` is null. The server announces the copy.
 */
export function forkNativeSession(sessionId: string, beforeMessageId: string | null, directory: string | null | undefined): Promise<Session> {
  return requireNativeAgents().fork(sessionId, beforeMessageId, requireNativeDirectory(directory))
}

/** The id of a native session's newest message, or null when it has none. */
export async function readNativeNewestMessageId(sessionId: string, directory: string | null | undefined): Promise<string | null> {
  const page = await requireNativeAgents().loadMessages(sessionId, requireNativeDirectory(directory), { limit: 1 })
  return page.records.at(-1)?.info.id ?? null
}

/**
 * Fork from a user message.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call the runtime fork endpoint
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to the new session and stage its composer replay
 */
export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const expectedRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()

  // Extract message text and file attachments for input restoration.
  const parts = state.part[messageId] ?? []
  const messageText = parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  const fileParts = parts.filter((part): part is FilePart => part.type === "file")

  const forkedSession = isNativeSessionId(sessionId)
    ? await forkNativeSession(sessionId, messageId, directory)
    : await opencodeClient.forkSession(sessionId, {
      before: transcriptCutForMessage(state.message[sessionId] ?? [], messageId), directory,
    })
  if (isStaleRuntime(expectedRuntimeKey)) return
  const target = createChatDraftIdentity(expectedRuntimeKey, resolveSessionOwnedDirectory(forkedSession) ?? directory, forkedSession.id)
  if (!target) throw new Error("Forked session has no composer directory")

  openForkedSession(store, forkedSession, target.directory)

  // Navigation is deferred in the chat column. Leave the source composer alone
  // until the rendered draft identity matches the fork, including for file-only prompts.
  useInputStore.setState({
    pendingComposerRestore: {
      target,
      text: messageText,
      files: fileParts.filter((part) => part.url).map((part) => ({
        url: part.url,
        mimeType: part.mime,
        filename: part.filename ?? "attachment",
      })),
    },
  })
  // The forked session is a fresh draft target, so the attached context of the
  // forked message follows the text into its composer.
  restoreContextPartsToInput(
    contextCarriersForMessage(state.message[sessionId] ?? [], messageId),
    { directory: target.directory, sessionKey: forkedSession.id },
  )
  await inheritForkMetadata(sessionId, forkedSession, target.directory, expectedRuntimeKey)
}

export async function fetchMessagesForSession(sessionID: string, directory?: string | null): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return
  await getImperativeSessionMessageLoader()?.ensure(
    { directory: resolvedDir, sessionID },
    { reason: "navigation" },
  )
}
