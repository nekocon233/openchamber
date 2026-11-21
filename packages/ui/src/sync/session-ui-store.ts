import type { ContextPartMetadata } from "@/lib/messages/contextParts"
import { readEffortRevision, rememberEffort } from "@/lib/modelEfforts"
import { create } from "zustand"
import type { Metadata, Part, Session, TextPart } from "@/lib/opencode/model"
import type { AttachedFile, SessionWorktreeAttachment } from "@/stores/types/sessionTypes"
import { type PermissionMode, permissionModeForNewSession } from "@/stores/utils/permissionAutoAccept"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient } from "@/lib/opencode/client";
import { runtimeFetch } from "@/lib/runtime-fetch"
import { useConfigStore } from "@/stores/useConfigStore"
import { runAfterOpenCodeStartup } from "./opencode-startup-gate"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useSessionDisplayStore } from "@/stores/useSessionDisplayStore"
import { syncSessionKnowledge } from "@/lib/sessionKnowledgeApi"
import { fetchResponseStyleInstruction } from "@/lib/responseStyle"
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from "@/stores/useGlobalSessionsStore"
import { isDirectoryUnknown, useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useSessionTabsStore } from "@/stores/useSessionTabsStore"
import { selectCommandsForDirectory, useCommandsStore } from "@/stores/useCommandsStore"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { prepareUserMessageResume } from "./user-message-resume"
import { normalizePath } from "@/lib/pathNormalization"
import { descendingId } from "@/lib/opencode/ids"
import {
  CHAT_DRAFT_PROJECT_ID,
  createChatDirectory,
  deleteChatDirectory,
  getChatsRootFromDirectory,
  isChatDirectoryPath,
  warmChatsRootDirectory,
  captureChatDirectoryCleanup as captureChatCleanup,
  getChatsRoot,
  resolveChatsRootDirectory,
} from "@/lib/chatDirectories"
import { isSpaceArchiveDirectory } from "@/lib/spaces/space-archives"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isVSCodeWithoutWorkspace } from "@/lib/vscodeBootstrap"
import { composeForkSessionMessage } from "@/lib/messages/executionMeta"
import { findLatestUserModelChoice } from "@/lib/messages/userModelChoice"
import { noteDraftSendWaiting, waitForPendingDraftWorktreeRequest } from "@/lib/worktrees/pendingDraftWorktree"
import { waitForWorktreeBootstrap } from "@/lib/worktrees/worktreeBootstrap"
import { getWorktreeSetupWaitEnabled } from "@/lib/openchamberConfig"
import { resolveCreatedWorktreeStartDirectory, resolveStartDirectory, resolveWorktreeStartDirectory } from "@/lib/worktrees/worktreeStartDirectory"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import { isSessionDirectoryAdmitted } from "./session-admission-rule"
import { admitSession, isSessionAdmitted, withAdmittedLineage } from "./session-admission"
import {
  getSyncSessions,
  getAllSyncSessions,
  getSyncMessages,
  getSyncParts,
  getDirectoryState,
  getSyncSessionDirectory,
} from "./sync-refs"
import { resolveSessionDirectoryFromSources, type SessionDirectoryResolution, type SessionDirectorySources } from "./session-directory-resolution"
import { markSessionViewed, sessionNotificationUrl } from "./notification-store"
import { releaseKeptUnreadMarks } from "./session-unread"
import { setActiveSession } from "./sync-context"
import {
  createSession as createSessionAction,
  type SessionCreateSelection,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  archiveSession as archiveSessionAction,
  archiveSessions as archiveSessionsAction,
  unarchiveSession as unarchiveSessionAction,
  unarchiveSessions as unarchiveSessionsAction,
  updateSessionTitle as updateSessionTitleAction,
  refetchSessionMessages,
  revertToMessage as revertToMessageAction,
  forkFromMessage as forkFromMessageAction,
  forkAfterMessage as forkAfterMessageAction,
  fetchMessagesForSession,
  type ArchiveSessionsOptions,
  type DeleteSessionOptions,
  type DeleteSessionsOptions,
  type UnarchiveSessionsOptions,
  adoptSessionMove,
  markSessionStatus,
  openPendingSessionTranscript,
} from "./session-actions";
import { useInputStore, type SyntheticContextPart } from "./input-store"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { trackPreparedChatFolder } from "@/lib/unconfirmedSends"
import type { SendMessageOptions } from "./send-message-options"
import { setSessionGoal, sessionGoalIntro } from "@/lib/sessionGoalActions"
import { useUIStore } from "@/stores/useUIStore"
import { useSelectionStore } from "./selection-store"
import { getViewportSessionMemory, useViewportStore, viewportSessionKey } from "./viewport-store"
import { useSessionWorktreeStore } from "./session-worktree-store"
import { getAttachedSessionDirectory } from "./session-worktree-contract"
import {
  getRuntimeEndpointGeneration,
  getRuntimeKey,
  isTransientRuntimeKey,
  captureRuntimeInstance,
} from "@/lib/runtime-switch";
import { persistLastActiveSession, readLastActiveSession, clearLastActiveSession } from "./last-session-cache"
import { useSessionDraftsStore } from "@/stores/useSessionDraftsStore"
import { persistWorktreeTopology, readPersistedWorktreeTopology } from "./worktree-topology-cache"
import { rememberRuntimeLiveStatus } from "./runtime-live-memory"
import { createInputHistoryIdentity, useInputHistoryStore } from "@/stores/useInputHistoryStore"
import { listModelVariantIds } from "@/lib/modelVariants"
import { navigationReturnSchema, type NavigationReturn } from "./navigation-return"
import { captureAgentCombinationDraft } from "@/lib/native-agents/combination-drafts"
import { partitionAttachmentsForSend } from "./zip-attachments"
import { NativeAgentsRequestError, nativeSessionActionErrorKey } from "@/lib/native-agents/errors";
import { isNativeSessionId, nativeBackendOfProviderId, nativeBackendOfSessionId, type NativeBackend } from "@/lib/native-agents/ids"
import type { I18nKey } from "@/lib/i18n"
import { clearPersistedSessionNavigation, persistSessionNavigation, readPersistedSessionNavigation, setSessionOpener } from "./session-navigation"
import { sharePwaSessionSelection } from "./pwa-session-selection"
import type { ExpectedRuntimeContext } from './session-dispatch';
import {
  assertExpectedRuntimeContext,
  routeMessage,
  resolveDirectoryKey,
  getAuthoritativeSessionDirectory,
} from './session-dispatch';

export { resolveSendSelection } from "./session-selection"
export type { SendMessageOptions, SentMessage } from "./send-message-options"

type GoalCommand = { name: string; template?: string }

export function expandSlashCommandGoalObjective(content: string, commands: GoalCommand[]): string {
  if (!content.startsWith("/")) return content
  const [head, ...tail] = content.split(" ")
  const command = commands.find((candidate) => candidate.name === head.slice(1))
  if (!command?.template?.trim()) return content
  const argumentsText = tail.join(" ")
  if (command.template.includes("$ARGUMENTS")) {
    return command.template.replaceAll("$ARGUMENTS", argumentsText)
  }

  const positions = [...command.template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  if (positions.length > 0) {
    const parsedArguments = [...argumentsText.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    const lastPosition = Math.max(...positions)
    return command.template.replace(/\$(\d+)/g, (_match, value: string) => {
      const position = Number(value)
      return position === lastPosition
        ? parsedArguments.slice(position - 1).join(" ")
        : (parsedArguments[position - 1] ?? "")
    })
  }

  return argumentsText ? `${command.template}\n\n${argumentsText}` : command.template
}

export function resolveGoalObjective(content: string, directory: string | null | undefined): string {
  if (!content.startsWith("/")) return content
  return expandSlashCommandGoalObjective(content, selectCommandsForDirectory(useCommandsStore.getState(), directory))
}

type PendingDraftPermissionPolicy = {
  enabled: boolean
  inflight: Promise<void> | null
  token: symbol
}

const pendingDraftPermissionPolicies = new Map<string, PendingDraftPermissionPolicy>()

const pendingDraftPermissionPolicyKey = (sessionId: string, runtimeKey = getRuntimeKey()): string => `${runtimeKey}\n${sessionId}`

export const clearPendingDraftPermissionPolicy = (
  sessionId: string,
  runtimeKey = getRuntimeKey(),
  expectedToken?: symbol,
): void => {
  const key = pendingDraftPermissionPolicyKey(sessionId, runtimeKey)
  if (expectedToken && pendingDraftPermissionPolicies.get(key)?.token !== expectedToken) return
  pendingDraftPermissionPolicies.delete(key)
}

export const supersedePendingDraftPermissionPolicy = (
  sessionId: string,
  runtimeKey = getRuntimeKey(),
): Promise<void> | null => {
  const key = pendingDraftPermissionPolicyKey(sessionId, runtimeKey)
  const pending = pendingDraftPermissionPolicies.get(key)
  pendingDraftPermissionPolicies.delete(key)
  return pending?.inflight ?? null
}

export const setPendingDraftPermissionPolicy = (
  sessionId: string,
  enabled: boolean,
  runtimeKey = getRuntimeKey(),
): symbol => {
  const token = Symbol("pending-draft-permission-policy")
  pendingDraftPermissionPolicies.set(
    pendingDraftPermissionPolicyKey(sessionId, runtimeKey),
    { enabled, inflight: null, token },
  )
  return token
}

export async function ensurePendingDraftPermissionPolicy(
  sessionId: string,
  expectedRuntime?: ExpectedRuntimeContext,
): Promise<void> {
  const operationRuntime = expectedRuntime ?? {
    runtimeKey: getRuntimeKey(),
    generation: getRuntimeEndpointGeneration(),
  }
  assertExpectedRuntimeContext(operationRuntime)
  const key = pendingDraftPermissionPolicyKey(sessionId, operationRuntime.runtimeKey)
  const pending = pendingDraftPermissionPolicies.get(key)
  if (!pending) return

  if (!pending.inflight) {
    const operation = (async () => {
      const { usePermissionStore } = await import("@/stores/permissionStore")
      await usePermissionStore.getState().setSessionMode(
        sessionId,
        pending.enabled ? "auto" : "ask",
        { preservePendingDraftIntent: true },
      )
      assertExpectedRuntimeContext(operationRuntime)
    })().finally(() => {
      if (pendingDraftPermissionPolicies.get(key) === pending && pending.inflight === operation) {
        pending.inflight = null
      }
    })
    pending.inflight = operation
  }

  await pending.inflight
  assertExpectedRuntimeContext(operationRuntime)
  if (pendingDraftPermissionPolicies.get(key) === pending) {
    pendingDraftPermissionPolicies.delete(key)
  }
}

type AssistantMessageSessionExecution = {
  providerID: string
  modelID: string
  variant: string
  agent: string
  instructions: string
  createWorktree?: boolean
  runAsGoal?: boolean
}

type AssistantMessageSessionSource = {
  sessionId: string
  directory: string
  text: string
}

function revertedUserMessageIndex(
  messages: readonly { id: string }[],
  userMessages: readonly { id: string }[],
  revertMessageID: string,
): number {
  const markerIndex = messages.findIndex((message) => message.id === revertMessageID)
  if (markerIndex < 0) return -1
  const reverted = messages.slice(markerIndex).find((message) => userMessages.includes(message))
  return reverted ? userMessages.indexOf(reverted) : -1
}

function notifyMessageSent(sessionId: string, directory?: string | null): void {
  runtimeFetch(sessionNotificationUrl(sessionId, "message-sent", directory), { method: "POST" })
    .catch(() => { /* ignore */ })
}

type NewSessionDraftTarget = "chat" | "project"

export type NewSessionDraftState = {
  draftId: number
  open: boolean
  selectedProjectId?: string | null
  directoryOverride: string | null
  permissionMode?: PermissionMode
  pendingWorktreeRequestId?: string | null
  bootstrapPendingDirectory?: string | null
  worktreeStartDirectory?: string | { worktreeRoot: string; directory: string | null } | null
  preserveDirectoryOverride?: boolean
  parentID: string | null
  title?: string
  initialPrompt?: string
  syntheticParts?: SyntheticContextPart[]
  targetFolderId?: string
  projectContextPins?: { notes: string[]; plans: string[] }
  target: NewSessionDraftTarget
  preparedChatDirectory?: string | null
  workDraftId?: string | null
}

export type SetCurrentSessionOptions = {
  transition?: "submitted-draft" | "restored"
  keepSingleProject?: boolean
}

export type SessionUIState = {
  restoredSessionPendingValidation: boolean
  restoredSessionRuntimeKey: string | null
  captureNavigationReturn: (directory: string) => () => void
  captureNavigationReturnSnapshot: (directory: string) => NavigationReturn
  restoreNavigationReturn: (snapshot: NavigationReturn) => void
  reconcileRestoredSession: (session: Session | null) => void
  currentSessionId: string | null
  currentSessionDirectory: string | null
  currentSessionKeepsSingleProject?: boolean
  materializedDraftSessionId: string | null
  pendingDraftSends: ReadonlyMap<string, PendingDraftSend>
  newSessionDraft: NewSessionDraftState
  abortPromptSessionId: string | null
  abortPromptExpiresAt: number | null
  error: string | null
  worktreeMetadata: Map<string, WorktreeMetadata>
  availableWorktrees: WorktreeMetadata[]
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
  worktreeDiscoveryByProject: ReadonlyMap<string, 'loading' | 'ready' | 'error'>
  webUICreatedSessions: Set<string>
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean }>
  abortControllers: Map<string, AbortController>
  isLoading: boolean
  lastLoadedDirectory: string | null

  setCurrentSession: (
    id: string | null,
    directoryHint?: string | null,
    transitionOrOptions?: "submitted-draft" | SetCurrentSessionOptions,
  ) => void
  clearMaterializedDraftSession: (sessionId: string) => void
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null, previousRuntimeKey?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState> & { automatic?: boolean }) => void
  prepareChatDraftDirectory: () => Promise<string | null>
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  setDraftPermissionMode: (mode: PermissionMode) => void
  setDraftProjectContextPin: (kind: "note" | "plan", id: string, pinned: boolean) => void
  acknowledgeSessionAbort: (sessionId: string) => void
  clearAbortPrompt: () => void
  armAbortPrompt: (durationMs?: number, sessionId?: string) => number | null
  clearError: () => void
  markSessionAsOpenChamberCreated: (sessionId: string) => void
  isOpenChamberCreatedSession: (sessionId: string) => boolean
  initializeNewOpenChamberSession: (sessionId: string, agents: unknown[]) => void
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null, directoryOverride?: string | null) => void
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null, options?: Record<string, unknown>) => void
  setDraftBootstrapPendingDirectory: (directory: string | null) => void
  setDraftWorktreeStartDirectory: (directoryOrDraftId: string | number | null, worktreeRoot?: string, directory?: string | null) => void
  setPendingDraftWorktreeRequest: (requestId: string | null) => void
  getWorktreeMetadata: (sessionId: string) => WorktreeMetadata | undefined

  sendMessage: (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata; systemContext?: 'session-knowledge' | 'feature-instructions' }>,
    variant?: string | null,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => Promise<void>

  createSession: (
    title?: string,
    directoryOverride?: string | null,
    metadata?: Metadata,
    selection?: SessionCreateSelection,
  ) => Promise<Session | null>
  deleteSession: (id: string, options?: DeleteSessionOptions) => Promise<boolean>
  deleteSessions: (ids: string[], options?: DeleteSessionsOptions) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: ArchiveSessionsOptions) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  unarchiveSession: (id: string) => Promise<boolean>
  unarchiveSessions: (ids: string[], options?: UnarchiveSessionsOptions) => Promise<{ restoredIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  revertToMessage: (sessionId: string, messageId: string, options?: { skipRedoPush?: boolean }) => Promise<boolean>
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  forkAfterMessage: (sessionId: string, messageId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string) => Promise<void>
  createSessionFromAssistantMessage: (source: AssistantMessageSessionSource, execution: AssistantMessageSessionExecution) => Promise<void>

  getSessionsByDirectory: (directory: string) => Session[]
  getDirectoryForSession: (sessionId: string) => string | null
  getLastUserChoice: (sessionId: string) => { agent?: string; providerID?: string; modelID?: string; variant?: string } | null
  getCurrentAgent: (sessionId: string) => string | undefined
  debugSessionMessages: (sessionId: string) => Promise<void>
  pollForTokenUpdates: () => void
  setSessionDirectory: (sessionId: string, directory: string | null) => void
  adoptAuthoritativeSessionDirectory: (sessionId?: string) => void
}

const safeStorage = getDeferredSafeStorage()
const DRAFT_TARGET_STORAGE_KEY = "oc.chatInput.lastDraftTarget"

type PersistedDraftTarget = {
  projectId: string | null
  directory: string | null
  target: NewSessionDraftTarget | null
}

const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId?: unknown; directory?: unknown; target?: unknown }
    return {
      projectId: typeof parsed?.projectId === "string" ? parsed.projectId : null,
      directory: normalizePath(typeof parsed?.directory === "string" ? parsed.directory : null),
      target: parsed?.target === "chat" || parsed?.target === "project" ? parsed.target : null,
    }
  } catch {
    return null
  }
}

const persistDraftTarget = (target: PersistedDraftTarget): void => {
  try {
    safeStorage.setItem(DRAFT_TARGET_STORAGE_KEY, JSON.stringify(target))
  } catch { /* ignored */ }
}

const resolveDraftProjectForDirectory = resolveProjectForSessionDirectory

const getAttachmentForSession = (sessionId: string | null | undefined): SessionWorktreeAttachment | undefined => {
  if (!sessionId) return undefined
  return useSessionWorktreeStore.getState().getAttachment(sessionId)
}

export const getRememberedSessionDirectory = (sessionId: string): {
  runtime: string | null
  persisted: string | null
} => {
  const key = runtimeMemoryKey()
  const runtimeMemory = runtimeSessionMemory.get(key)
  const persistedNavigation = readPersistedSessionNavigation(key)
  const persistedLastSession = readLastActiveSession(key)
  const persisted = persistedNavigation?.sessionId === sessionId
    ? persistedNavigation
    : persistedLastSession
  return {
    runtime: runtimeMemory?.sessionId === sessionId ? normalizePath(runtimeMemory.directory) : null,
    persisted: persisted?.sessionId === sessionId ? normalizePath(persisted.directory) : null,
  }
}

let guessedSelectionSessionId: string | null = null
let admissionNavigationRevision = 0
export const getAdmissionNavigationRevision = (): number => admissionNavigationRevision

const collectSessionDirectorySources = (
  sessionId: string,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
  selected: string | null,
): SessionDirectorySources => ({
  authoritative: getAuthoritativeSessionDirectory(sessionId),
  selected: sessionId === guessedSelectionSessionId ? null : normalizePath(selected),
  attachment: getAttachedSessionDirectory(getAttachmentForSession(sessionId)),
  worktreeMetadata: normalizePath(getWtMeta(sessionId)?.path ?? null),
  remembered: getRememberedSessionDirectory(sessionId).runtime,
})

const reportedDirectoryConflicts = new Set<string>()
const MAX_REPORTED_DIRECTORY_CONFLICTS = 200

const reportSessionDirectoryConflict = (
  sessionId: string,
  resolution: SessionDirectoryResolution,
): void => {
  if (!resolution.conflict) return
  const conflictKey = JSON.stringify([
    runtimeMemoryKey(),
    sessionId,
    resolution.directory,
    resolution.conflict.source,
    resolution.conflict.directory,
  ])
  if (reportedDirectoryConflicts.has(conflictKey)) return
  if (reportedDirectoryConflicts.size >= MAX_REPORTED_DIRECTORY_CONFLICTS) {
    reportedDirectoryConflicts.clear()
  }
  reportedDirectoryConflicts.add(conflictKey)
  console.warn(
    "[session-directory] session directory sources disagree; using the higher-authority one. "
    + "Run __opencodeDebug.diagnoseSessionDirectory() for the full picture.",
    {
      sessionId,
      using: resolution.source,
      directory: resolution.directory,
      conflictingSource: resolution.conflict.source,
      conflictingDirectory: resolution.conflict.directory,
    },
  )
}

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
  selected: string | null = null,
): string | null => {
  if (!sessionId) return null
  const resolution = resolveSessionDirectoryFromSources(
    collectSessionDirectorySources(sessionId, getWtMeta, selected),
  )
  reportSessionDirectoryConflict(sessionId, resolution)
  return resolution.directory
}

const activateConfigForDirectory = async (
  directory: string | null | undefined,
  options?: { preserveManualModel?: boolean },
): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory), options)
}

const resolveDraftConfigDirectory = (
  draft: NewSessionDraftState,
  project: { path?: string | null } | null | undefined,
): string | null => normalizePath(draft.directoryOverride ?? null)
  ?? normalizePath(project?.path ?? null)
  ?? (draft.target === "chat" ? getChatsRoot() : null)

const applyDraftTargetSelectionDefaults = (
  draft: NewSessionDraftState,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  selectedProjectOverride?: {
    path?: string | null
    defaultAgent?: string | null
    defaultModel?: string | null
    defaultAgentCombinationId?: string | null
    defaultVariant?: string | null
  } | null,
  previousDraft?: NewSessionDraftState,
): void => {
  if (!draft.open) return
  const projects = useProjectsStore.getState().projects
  const selectedProject = draft.target !== "project"
    ? null
    : (selectedProjectOverride
      ?? (draft.selectedProjectId
        ? projects.find((project) => project.id === draft.selectedProjectId) ?? null
        : resolveDraftProjectForDirectory(
          projects,
          availableWorktreesByProject,
          normalizePath(draft.directoryOverride ?? null),
        )))

  const configDirectory = resolveDraftConfigDirectory(draft, selectedProject)

  if (previousDraft?.open && previousDraft.draftId === draft.draftId && previousDraft.target === draft.target) {
    const previousProject = previousDraft.target !== 'project' ? null
      : projects.find((project) => project.id === previousDraft.selectedProjectId)
        ?? resolveDraftProjectForDirectory(projects, availableWorktreesByProject, normalizePath(previousDraft.directoryOverride ?? null))
    const previousConfigDirectory = resolveDraftConfigDirectory(previousDraft, previousProject)
    if (previousConfigDirectory === configDirectory && (typeof draft.worktreeStartDirectory === "string" || draft.worktreeStartDirectory?.directory !== null)) return
  }

  const runtimeKey = getRuntimeKey()
  const revision = ++draftDefaultsRevision
  const projectChanged = !previousDraft || previousDraft.target !== draft.target
    || previousDraft.selectedProjectId !== draft.selectedProjectId
  const applyDefaults = () => {
    if (!projectChanged) return
    const currentProject = selectedProject?.path
      ? useProjectsStore.getState().projects.find((project) => normalizePath(project.path) === normalizePath(selectedProject.path))
      : undefined
    useConfigStore.getState().applyDefaultModelAgentSelection({
      projectDefaultAgent: currentProject?.defaultAgent,
      projectDefaultModel: currentProject?.defaultModel,
      projectDefaultAgentCombinationId: currentProject?.defaultAgentCombinationId,
      projectDefaultVariant: currentProject?.defaultVariant,
    })
  }
  const activationOptions = { preserveManualModel: !projectChanged && draft.target === 'project' }
  const worktreeProject = projectOfWorktreeRoot(configDirectory, draft.selectedProjectId, availableWorktreesByProject)
  if (configDirectory && worktreeProject) {
    useSessionUIStore.getState().setDraftWorktreeStartDirectory(draft.draftId, configDirectory, null)
  }
  const isDraftStillCurrent = () => {
    const current = useSessionUIStore.getState()
    return revision === draftDefaultsRevision && getRuntimeKey() === runtimeKey
      && current.newSessionDraft.open && current.newSessionDraft.draftId === draft.draftId
  }
  const activation = configDirectory && worktreeProject
    ? resolveStartDirectory(worktreeProject, configDirectory).then(({ directory }) => directory, () => configDirectory).then(async (directory) => {
      if (!isDraftStillCurrent()) return
      useSessionUIStore.getState().setDraftWorktreeStartDirectory(draft.draftId, configDirectory, directory)
      await activateConfigForDirectory(directory, activationOptions)
    })
    : !configDirectory && draft.target === "chat"
      ? resolveChatsRootDirectory().then(async (chatsRoot) => {
        if (!isDraftStillCurrent()) return
        const activated = activateConfigForDirectory(chatsRoot, activationOptions)
        applyDefaults()
        await activated
      }, () => undefined)
      : activateConfigForDirectory(configDirectory, activationOptions)
  applyDefaults()
  void activation.then(() => {
    const current = useSessionUIStore.getState()
    if (revision !== draftDefaultsRevision || getRuntimeKey() !== runtimeKey
      || current.currentSessionId || !current.newSessionDraft.open
      || current.newSessionDraft.draftId !== draft.draftId
      || current.newSessionDraft.target !== draft.target
      || current.newSessionDraft.selectedProjectId !== draft.selectedProjectId
      || useConfigStore.getState().selectionSource === 'manual'
      || useConfigStore.getState().agentSelectionSource === 'manual'
      || useConfigStore.getState().currentVariantSelection.override !== undefined) return
    applyDefaults()
  })
}

let draftDefaultsRevision = 0

const DEFAULT_DRAFT: NewSessionDraftState = {
  draftId: 0,
  open: false,
  directoryOverride: null,
  parentID: null,
  target: "chat",
}
let nextDraftId = 1
const pendingChatDirectoryByDraft = new Map<string, Promise<string | null>>()

const activeSessionByRuntime = new Map<string, string | null>()
type RuntimeSessionMemory = {
  sessionId: string | null
  directory: string | null
  draft: NewSessionDraftState
  worktreeMetadata: Map<string, WorktreeMetadata>
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
}
const runtimeSessionMemory = new Map<string, RuntimeSessionMemory>()

const runtimeMemoryKey = (value?: string | null): string => {
  const key = (value ?? getRuntimeKey()).trim()
  return key || "default"
}

const cloneDraft = (draft: NewSessionDraftState): NewSessionDraftState => ({ ...draft })

const writeRuntimeSessionMemory = (key: string, patch: Partial<RuntimeSessionMemory>): void => {
  const current = runtimeSessionMemory.get(key)
  runtimeSessionMemory.set(key, {
    sessionId: current?.sessionId ?? null,
    directory: current?.directory ?? null,
    draft: current?.draft ? cloneDraft(current.draft) : { ...DEFAULT_DRAFT },
    worktreeMetadata: current?.worktreeMetadata ?? new Map(),
    availableWorktreesByProject: current?.availableWorktreesByProject ?? new Map(),
    ...patch,
  })
}

type MaterializedDraftSession = {
  sessionId: string
  directory: string | null
  agent?: string
  syntheticParts?: SyntheticContextPart[]
}

export type PendingDraftSend = {
  draftId: number
  sessionCreated: boolean
}

type DraftMaterialization = {
  promise: Promise<MaterializedDraftSession | null>
}

const draftMaterializations = new Map<string, DraftMaterialization>()

const draftMaterializationKey = (runtime: ExpectedRuntimeContext): string => (
  `${runtime.runtimeKey}\n${runtime.generation}`
)

const resolveProjectRefForWorktreeDirectory = (directory: string | null, projectId?: string | null): { id: string; path: string } | null => {
  const projectsState = useProjectsStore.getState()
  if (projectId) {
    const project = projectsState.projects.find((entry) => entry.id === projectId)
    if (project?.path) return { id: project.id, path: project.path }
  }
  const resolved = resolveProjectForSessionDirectory(projectsState.projects, useSessionUIStore.getState().availableWorktreesByProject, directory)
  return resolved?.path ? { id: resolved.id, path: resolved.path } : null
}

const waitForWorktreeBootstrapIfConfigured = async (directory: string | null, projectId?: string | null): Promise<void> => {
  if (!directory || isSpaceDirectory(directory)) return
  const project = resolveProjectRefForWorktreeDirectory(directory, projectId)
  if (project && await getWorktreeSetupWaitEnabled(project)) {
    await waitForWorktreeBootstrap(directory)
  }
}

const projectOfWorktreeRoot = (
  directory: string | null,
  projectId: string | null | undefined,
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>,
): { id: string; path: string } | null => {
  if (!directory) return null
  const target = normalizePath(directory)
  const isWorktreeRoot = [...availableWorktreesByProject.values()]
    .some((worktrees) => worktrees.some((worktree) => normalizePath(worktree.path) === target))
  return isWorktreeRoot ? resolveProjectRefForWorktreeDirectory(directory, projectId) : null
}

const resolveDraftStartDirectory = async (directory: string | null, projectId?: string | null): Promise<string | null> => {
  const project = projectOfWorktreeRoot(directory, projectId, useSessionUIStore.getState().availableWorktreesByProject)
  return directory && project ? resolveWorktreeStartDirectory(project, directory) : directory
}

const resolveActiveProjectDirectory = (draft: NewSessionDraftState): string | null => {
  const projectsState = useProjectsStore.getState()
  return normalizePath(
    projectsState.getActiveProject()?.path
      ?? (draft.selectedProjectId
        ? projectsState.projects.find((project) => project.id === draft.selectedProjectId)?.path
        : null)
      ?? null,
  )
}

const isRecoverableDraftDirectory = (draft: NewSessionDraftState, directory: string | null): directory is string =>
  Boolean(directory)
  && draft.open
  && draft.preserveDirectoryOverride !== true
  && !isSpaceDirectory(directory)
  && !draft.pendingWorktreeRequestId
  && !draft.bootstrapPendingDirectory
  && normalizePath(draft.directoryOverride) === normalizePath(directory)

const recoverMissingDraftDirectory = async (draft: NewSessionDraftState, directory: string | null): Promise<string | null> => {
  if (!isRecoverableDraftDirectory(draft, directory)) return directory
  const activeProjectDirectory = resolveActiveProjectDirectory(draft)
  if (!activeProjectDirectory || normalizePath(directory) === activeProjectDirectory) return directory
  const availability = await opencodeClient.getDirectoryAvailability(directory)
  return availability === "missing" ? activeProjectDirectory : directory
}

const resolveCreatableDraftDirectory = async (
  draft: NewSessionDraftState,
  requestedDirectory: string | null | undefined,
  options: { allowDetachedDraft?: boolean } = {},
): Promise<{ status: "ok"; directory: string | null | undefined } | { status: "aborted" }> => {
  const directory = requestedDirectory ?? opencodeClient.getDirectory() ?? null
  if (!isRecoverableDraftDirectory(draft, directory)) {
    return { status: "ok", directory }
  }

  const activeProjectDirectory = resolveActiveProjectDirectory(draft)
  if (!activeProjectDirectory || normalizePath(directory) === activeProjectDirectory) {
    return { status: "ok", directory }
  }

  const runtimeKey = getRuntimeKey()
  const draftDirectory = draft.directoryOverride
  const availability = await opencodeClient.getDirectoryAvailability(directory)
  const currentDraft = useSessionUIStore.getState().newSessionDraft
  const currentDirectory = normalizePath(currentDraft.directoryOverride)
  const capturedDirectory = normalizePath(draftDirectory)
  // openNewSessionDraft may rewrite the same implicit draft to this fallback
  // while createSession's probe is still in flight. That is the intended
  // destination, not a user change, so do not abort the create.
  const recoveredToActiveProject = currentDirectory === activeProjectDirectory
    && capturedDirectory !== activeProjectDirectory
  const draftChanged = !currentDraft.open
    || currentDraft.preserveDirectoryOverride !== draft.preserveDirectoryOverride
    || currentDraft.pendingWorktreeRequestId !== draft.pendingWorktreeRequestId
    || (currentDirectory !== capturedDirectory && !recoveredToActiveProject)

  if (getRuntimeKey() !== runtimeKey || (!options.allowDetachedDraft && draftChanged)) {
    return { status: "aborted" }
  }

  if (recoveredToActiveProject) {
    return { status: "ok", directory: activeProjectDirectory }
  }

  return {
    status: "ok",
    directory: availability === "missing" ? activeProjectDirectory : directory,
  }
}

const recoverStaleDraftDirectory = async (openedDraft: NewSessionDraftState): Promise<void> => {
  if (openedDraft.target !== "project") return

  const resolved = await resolveCreatableDraftDirectory(openedDraft, openedDraft.directoryOverride)
  if (resolved.status !== "ok") return
  const recovered = normalizePath(resolved.directory ?? null)
  const original = normalizePath(openedDraft.directoryOverride)
  if (!recovered || recovered === original) return

  const currentDraft = useSessionUIStore.getState().newSessionDraft
  if (!currentDraft.open) return
  if (currentDraft.target !== "project") return
  if (currentDraft.preserveDirectoryOverride === true) return
  if (currentDraft.pendingWorktreeRequestId) return
  if (normalizePath(currentDraft.directoryOverride) !== original) return

  const recoveredProject = useProjectsStore.getState().projects.find((project) => (
    normalizePath(project.path) === recovered
  ))
  const nextDraft: NewSessionDraftState = {
    ...currentDraft,
    selectedProjectId: recoveredProject?.id ?? currentDraft.selectedProjectId,
    directoryOverride: recovered,
  }
  useSessionUIStore.setState({ newSessionDraft: nextDraft })
  writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
  persistDraftTarget({ projectId: nextDraft.selectedProjectId ?? null, directory: recovered, target: nextDraft.target })
  void activateConfigForDirectory(recovered)
}

const createSessionWithDraftLifecycle = async (
  title?: string,
  directoryOverride?: string | null,
  metadata?: Metadata,
  selectionTransition?: "submitted-draft",
  selection?: SessionCreateSelection,
  draftOverride?: NewSessionDraftState,
  expectedRuntime?: ExpectedRuntimeContext,
  nativeBackend: NativeBackend | null = null,
): Promise<Session | null> => {
  assertExpectedRuntimeContext(expectedRuntime)
  const store = useSessionUIStore.getState()
  const draft = draftOverride ?? store.newSessionDraft
  const targetFolderId = draft.targetFolderId

  try {
    const resolved = await resolveCreatableDraftDirectory(draft, directoryOverride, {
      allowDetachedDraft: selectionTransition === "submitted-draft" && draftOverride !== undefined,
    })
    assertExpectedRuntimeContext(expectedRuntime)
    if (resolved.status === "aborted") return null
    const directory = resolved.directory
    const session = await createSessionAction(title, directory, metadata, selectionTransition, selection, "open", undefined, expectedRuntime?.runtimeKey, nativeBackend)
    assertExpectedRuntimeContext(expectedRuntime)
    if (!session) return null

    useSessionUIStore.getState().closeNewSessionDraft()

    if (targetFolderId) {
      const currentStore = useSessionUIStore.getState()
      const scopeDirectory = directory || currentStore.lastLoadedDirectory || session.directory
      const scopeKey = getChatsRootFromDirectory(scopeDirectory) ?? scopeDirectory
      if (scopeKey) {
        useSessionFoldersStore.getState().addSessionToFolder(scopeKey, targetFolderId, session.id)
      }
    }

    return session
  } catch (error) {
    console.error("[session-ui-store] createSession failed", error)
    return null
  }
}

const resolveVariantToRecord = (
  sendsFromMainChat: boolean,
  agentName: string | undefined,
  providerID: string,
  modelID: string,
  sentVariant: string | null | undefined,
): string | null | undefined => {
  const config = useConfigStore.getState()
  const describesThisSend = sendsFromMainChat
    && config.currentProviderId === providerID
    && config.currentModelId === modelID
    && config.currentAgentName === agentName
  return describesThisSend ? config.currentVariantSelection.override : sentVariant
}

type DraftSessionSelection = {
  providerID: string
  modelID: string
  agent?: string
  variant?: string | null
}

const trimAgent = (agent: string | undefined): string | undefined => (
  typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined
)

const draftSessionCreateSelection = (selection: DraftSessionSelection): SessionCreateSelection => ({
  model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant },
  agent: trimAgent(selection.agent),
})

const draftSessionMetadata = (draft: NewSessionDraftState): Metadata | undefined => {
  const draftPins = draft.projectContextPins ?? { notes: [], plans: [] }
  return draftPins.notes.length > 0 || draftPins.plans.length > 0
    ? { openchamber: { project_context_pins: draftPins } }
    : undefined
}

const resolveDraftTargetDirectory = async (draft: NewSessionDraftState): Promise<string | null> => {
  const store = useSessionUIStore.getState()
  let directory = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null

  if (draft.pendingWorktreeRequestId) {
    const requestId = draft.pendingWorktreeRequestId
    noteDraftSendWaiting(requestId, true)
    try {
      directory = await waitForPendingDraftWorktreeRequest(requestId)
    } finally {
      noteDraftSendWaiting(requestId, false)
    }
    store.resolvePendingDraftWorktreeTarget(requestId, directory)
  }

  if (draft.target === "chat") {
    directory = await store.prepareChatDraftDirectory()
    if (!directory) throw new Error("Failed to prepare chat directory")
    const currentDraft = useSessionUIStore.getState().newSessionDraft
    if (currentDraft.draftId === draft.draftId) {
      useSessionUIStore.setState({
        newSessionDraft: { ...currentDraft, preparedChatDirectory: null },
      })
    }
  }

  return directory
}

const resolveDraftCreateDirectory = async (draft: NewSessionDraftState, directory: string | null): Promise<string | null> => {
  const draftProjectId = draft.selectedProjectId ?? null
  await waitForWorktreeBootstrapIfConfigured(directory, draftProjectId)
  const startDirectory = await resolveDraftStartDirectory(directory, draftProjectId)
  return recoverMissingDraftDirectory(draft, startDirectory)
}

const finishDraftSession = async (
  draft: NewSessionDraftState,
  created: Session,
  requestedDirectory: string | null | undefined,
  runtimeKey: string,
): Promise<string | null> => {
  const isChatDraft = draft.target === "chat"
  const createdDirectory = normalizePath(created.directory ?? requestedDirectory ?? null)

  if (isChatDraft && !useSessionDisplayStore.getState().showChatsSection) {
    useSessionDisplayStore.getState().setShowChatsSection(true)
    void import("@/lib/persistence")
      .then(({ updateDesktopSettings }) => updateDesktopSettings({ sidebarShowChatsSection: true }))
      .catch((error) => {
        console.warn("Failed to save the shown Chats section:", error)
      })
  }

  persistDraftTarget({
    projectId: draft.selectedProjectId ?? null,
    directory: createdDirectory,
    target: draft.target,
  })

  void activateConfigForDirectory(createdDirectory).catch((error) => {
    console.warn("Failed to activate directory after creating session:", error)
  })

  const permissionMode = permissionModeForNewSession(
    draft.permissionMode,
    isSpaceDirectory(createdDirectory),
    useUIStore.getState().permissionDefaultMode,
  )
  await applyDraftPermissions(created.id, permissionMode, { runtimeKey, generation: getRuntimeEndpointGeneration() })

  if (draft.targetFolderId) {
    const scopeDirectory = requestedDirectory || useSessionUIStore.getState().lastLoadedDirectory || created.directory
    const scopeKey = getChatsRootFromDirectory(scopeDirectory) ?? scopeDirectory
    if (scopeKey) {
      useSessionFoldersStore.getState().addSessionToFolder(scopeKey, draft.targetFolderId, created.id)
    }
  }

  return createdDirectory
}

const saveDraftSessionSelection = (sessionId: string, selection: DraftSessionSelection): string | undefined => {
  const configState = useConfigStore.getState()
  const effectiveDraftAgent = trimAgent(selection.agent) ?? configState.currentAgentName
  const variantOverride = resolveVariantToRecord(
    true,
    effectiveDraftAgent,
    selection.providerID,
    selection.modelID,
    selection.variant,
  )

  useSelectionStore.getState().saveSessionModelSelection(sessionId, selection.providerID, selection.modelID)

  if (effectiveDraftAgent) {
    useSelectionStore.getState().saveSessionAgentSelection(sessionId, effectiveDraftAgent)
    if (configState.selectionSource === "manual") {
      useSelectionStore.getState().saveAgentModelForSession(sessionId, effectiveDraftAgent, selection.providerID, selection.modelID)
    }
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, effectiveDraftAgent, selection.providerID, selection.modelID, variantOverride)
  }

  useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, configState.agents ?? [])
  return effectiveDraftAgent
}

type CapturedChatDirectoryCleanup = (directory: string) => Promise<void>

const captureChatDirectoryCleanup = async (
  target: NewSessionDraftState["target"],
  expectedRuntimeKey: string,
): Promise<CapturedChatDirectoryCleanup | null> => {
  return target === "chat" ? captureChatCleanup(expectedRuntimeKey) : null
}

const deletePreparedChatDirectory = async (
  directory: string | null | undefined,
  cleanup: CapturedChatDirectoryCleanup | null,
): Promise<void> => {
  if (!directory) return
  await cleanup?.(directory)
}

const applyDraftPermissions = async (sessionId: string, draftPermissionMode: PermissionMode | undefined, operationRuntime: ExpectedRuntimeContext) => {
    if (draftPermissionMode) {
      const pendingPolicyToken = draftPermissionMode === "ask"
        ? setPendingDraftPermissionPolicy(sessionId, false, operationRuntime.runtimeKey)
        : null
      try {
        const { usePermissionStore } = await import("@/stores/permissionStore")
        assertExpectedRuntimeContext(operationRuntime)
        await usePermissionStore.getState().setSessionMode(
          sessionId,
          draftPermissionMode,
          { preservePendingDraftIntent: true },
        )
        if (pendingPolicyToken) {
          clearPendingDraftPermissionPolicy(sessionId, operationRuntime.runtimeKey, pendingPolicyToken)
        }
      } catch (error) {
        // A draft that chose "ask" is the one that disables auto-accept: a
        // failed write there must stop the dispatch instead of letting the
        // session run under the default policy. The pending intent recorded
        // above makes the next send retry it.
        if (draftPermissionMode === "ask") throw error
        console.warn("Failed to apply the draft permission mode to the new session:", error)
      }
    }
}

export function materializeOpenDraftSession(selection: {
  providerID: string
  modelID: string
  agent?: string
  variant?: string | null
  expectedRuntime?: ExpectedRuntimeContext
  onSessionMaterialized?: (sessionId: string, directory: string | null) => void
}, draftOverride?: NewSessionDraftState): Promise<MaterializedDraftSession | null> {
  const operationRuntime = selection.expectedRuntime ?? {
    runtimeKey: getRuntimeKey(),
    generation: getRuntimeEndpointGeneration(),
  }
  assertExpectedRuntimeContext(operationRuntime)
  const store = useSessionUIStore.getState()
  const draft = draftOverride ?? store.newSessionDraft
  const materializationKey = draftMaterializationKey(operationRuntime)
  const existing = draftMaterializations.get(materializationKey)
  if (existing) return existing.promise
  if (!draft?.open) return Promise.resolve(null)
  const combinationDraft = captureAgentCombinationDraft({ draftId: draft.draftId })
  const config = useConfigStore.getState()
  const inheritedId = combinationDraft?.configuration.inheritedMain ? combinationDraft.configuration.combination?.id
    : config.selectionSource === 'auto' ? config.currentDefaultAgentCombinationId : undefined
  const inherited = combinationDraft?.configuration.inheritedMain
  const validChoice = (choice: typeof inherited) => {
    if (!choice) return true
    const model = config.providers.find((provider) => provider.id === choice.model.providerID)?.models.find((model) => model.id === choice.model.modelID || model.nativeAliases?.some((alias) => alias.id === choice.model.modelID))
    return Boolean(model && (!choice.variant || listModelVariantIds(model.variants).includes(choice.variant)))
  }
  const mainToValidate = inherited && config.currentVariantSelection.override !== undefined
    ? { ...inherited, variant: selection.variant ?? undefined } : inherited
  const rolesAvailable = !inherited || [mainToValidate, combinationDraft?.configuration.subagent ?? undefined, combinationDraft?.configuration.execution ?? undefined].every(validChoice)
  if (inheritedId && (!combinationDraft || !rolesAvailable || !config.nativeAgentCombinations.some((entry) => entry.id === inheritedId))) {
    return import('@/lib/i18n').then(({ formatMessage, useI18nStore }) => {
      throw new Error(formatMessage(useI18nStore.getState().dictionary, 'agents.combinations.defaultUnavailable'))
    })
  }

  const materialization = (async () => {
    // Only an explicit choice is written: without one the server applies its own
    // default mode, which is also what the shield button shows meanwhile.
    const draftPermissionMode = draft.permissionMode

    const trimmedAgent = typeof selection.agent === "string" && selection.agent.trim().length > 0
      ? selection.agent.trim()
      : undefined
    let draftDirectoryOverride = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null
    const draftProjectId = draft.selectedProjectId ?? null

    if (draft.pendingWorktreeRequestId) {
      const requestId = draft.pendingWorktreeRequestId
      // Tell the request's owner a send is waiting on it, so a slow answer is
      // not mistaken for an abandoned draft.
      noteDraftSendWaiting(requestId, true)
      try {
        draftDirectoryOverride = await waitForPendingDraftWorktreeRequest(requestId)
      } finally {
        noteDraftSendWaiting(requestId, false)
      }
      assertExpectedRuntimeContext(operationRuntime)
      store.resolvePendingDraftWorktreeTarget(draft.pendingWorktreeRequestId, draftDirectoryOverride)
    }

    const isChatDraft = draft.target === "chat"
    if (isChatDraft) {
      draftDirectoryOverride = await store.prepareChatDraftDirectory()
      assertExpectedRuntimeContext(operationRuntime)
      if (!draftDirectoryOverride) throw new Error("Failed to prepare chat directory")
      const currentDraft = useSessionUIStore.getState().newSessionDraft
      if (currentDraft.draftId === draft.draftId) {
        useSessionUIStore.setState({
          newSessionDraft: { ...currentDraft, preparedChatDirectory: null },
        })
      }
    }

    draftDirectoryOverride = await resolveDraftCreateDirectory(draft, draftDirectoryOverride)
    assertExpectedRuntimeContext(operationRuntime)

    const draftPins = draft.projectContextPins ?? { notes: [], plans: [] }
    // Picking a CLI's model in the draft makes the session a native one.
    const nativeBackend = nativeBackendOfProviderId(selection.providerID)
    const created = await createSessionWithDraftLifecycle(
      draft.title,
      draftDirectoryOverride,
      !nativeBackend && (draftPins.notes.length > 0 || draftPins.plans.length > 0)
        ? { openchamber: { project_context_pins: draftPins } }
        : undefined,
      "submitted-draft",
      { model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant }, agent: trimmedAgent, combinationDraft },
      draft,
      operationRuntime,
      nativeBackend,
    )
    assertExpectedRuntimeContext(operationRuntime)
    if (!created?.id) {
      if (isChatDraft && draftDirectoryOverride) {
        await deleteChatDirectory(draftDirectoryOverride, operationRuntime.runtimeKey).catch(() => undefined)
      }
      throw new Error("Failed to create session")
    }

    const draftSyntheticParts = draft.syntheticParts
    // The create response is authoritative and may canonicalize the requested
    // worktree path through symlinks or platform-specific casing.
    const createdDirectory = normalizePath(created.directory ?? draftDirectoryOverride ?? null)
    selection.onSessionMaterialized?.(created.id, createdDirectory)

    persistDraftTarget({
      projectId: draftProjectId,
      directory: createdDirectory,
      target: draft.target,
    })

    const configState = useConfigStore.getState()
    void activateConfigForDirectory(createdDirectory).catch((error) => {
      console.warn("Failed to activate directory after creating session:", error)
    })

    const effectiveDraftAgent = trimmedAgent ?? configState.currentAgentName
    const variantOverride = resolveVariantToRecord(
      true, effectiveDraftAgent,
      selection.providerID,
      selection.modelID,
      selection.variant,
    )

    useSelectionStore.getState().saveSessionModelSelection(created.id, selection.providerID, selection.modelID)

    if (effectiveDraftAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
      if (configState.selectionSource === 'manual') {
        useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID)
      }
      useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID, variantOverride)
    }

    store.initializeNewOpenChamberSession(created.id, configState.agents ?? [])

    // Native sessions approve every tool themselves; no policy to apply.
    if (!nativeBackend) await applyDraftPermissions(created.id, draftPermissionMode, operationRuntime)
    assertExpectedRuntimeContext(operationRuntime)

    return {
      sessionId: created.id,
      directory: createdDirectory,
      agent: effectiveDraftAgent,
      syntheticParts: draftSyntheticParts,
    }
  })().finally(() => {
    if (draftMaterializations.get(materializationKey)?.promise === materialization) {
      draftMaterializations.delete(materializationKey)
    }
  })
  draftMaterializations.set(materializationKey, { promise: materialization })
  return materialization
}

export class DraftSendError extends Error {
  constructor(
    readonly sessionId: string,
    readonly directory: string,
    readonly sessionCreated: boolean,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "DraftSendError"
  }
}

const sentDraftIds = new Set<number>()

const setPendingDraftSend = (sessionId: string, state: PendingDraftSend | null): void => {
  useSessionUIStore.setState((current) => {
    if (state === null && !current.pendingDraftSends.has(sessionId)) return current
    const next = new Map(current.pendingDraftSends)
    if (state === null) next.delete(sessionId)
    else next.set(sessionId, state)
    return { pendingDraftSends: next }
  })
}

const reopenDraftAfterFailedCreation = (
  draft: NewSessionDraftState,
  sessionId: string,
  directory: string,
  runtimeKey: string,
): void => {
  sentDraftIds.delete(draft.draftId)
  const reopened: NewSessionDraftState = {
    ...draft,
    preparedChatDirectory: null,
    pendingWorktreeRequestId: null,
    directoryOverride: draft.target === "chat" ? draft.directoryOverride : directory,
  }
  if (getRuntimeKey() !== runtimeKey) {
    const capturedKey = runtimeMemoryKey(runtimeKey)
    const capturedMemory = runtimeSessionMemory.get(capturedKey)
    if (capturedMemory && capturedMemory.sessionId !== sessionId) return
    writeRuntimeSessionMemory(capturedKey, {
      sessionId: null,
      directory: reopened.directoryOverride ?? null,
      draft: reopened,
    })
    activeSessionByRuntime.set(capturedKey, null)
    clearLastActiveSession(capturedKey)
    return
  }
  const store = useSessionUIStore.getState()
  if (store.currentSessionId !== sessionId) return
  store.setCurrentSession(null, reopened.directoryOverride)
  useSessionUIStore.setState({ newSessionDraft: reopened })
  writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory: reopened.directoryOverride ?? null, draft: reopened })
  clearLastActiveSession(runtimeMemoryKey())
}

const nativeRevertRefusal = (error: NativeAgentsRequestError): I18nKey | null => {
  if (error.code === "NATIVE_REVERT_FIRST_MESSAGE") return "chat.revert.toast.nativeFirstMessage"
  if (error.code === "NATIVE_REVERT_MID_TURN") return "chat.revert.toast.nativeMidTurn"
  if (error.code === "NATIVE_REWIND_BEFORE_COMPACTION") return "chat.revert.toast.nativeBeforeCompaction"
  return nativeSessionActionErrorKey(error)
}

const showRevertToast = async (kind: "info" | "error", key: I18nKey) => {
  const { toast } = await import("sonner")
  const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
  toast[kind](formatMessage(useI18nStore.getState().dictionary, key))
}

const flattenWorktreeMap = (map: Map<string, WorktreeMetadata[]>): WorktreeMetadata[] => {
  const out: WorktreeMetadata[] = []
  for (const list of map.values()) out.push(...list)
  return out
}

const PERSISTED_WORKTREE_MAP = readPersistedWorktreeTopology(runtimeMemoryKey())

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  restoredSessionPendingValidation: false,
  restoredSessionRuntimeKey: null,
  reconcileRestoredSession: (session) => {
    const state = get()
    const key = runtimeMemoryKey()
    if (
      !state.restoredSessionPendingValidation
      || !state.currentSessionId
      || state.restoredSessionRuntimeKey !== key
    ) return

    const clearRestoredSession = () => {
      clearPersistedSessionNavigation(state.currentSessionId, key)
      activeSessionByRuntime.set(key, null)
      writeRuntimeSessionMemory(key, { sessionId: null, directory: null })
      set({
        currentSessionId: null,
        currentSessionDirectory: null,
        currentSessionKeepsSingleProject: false,
        restoredSessionPendingValidation: false,
        restoredSessionRuntimeKey: null,
      })
      setActiveSession("", "")
    }

    if (!session || session.id !== state.currentSessionId) {
      clearRestoredSession()
      return
    }

    const globalState = useGlobalSessionsStore.getState()
    const sessionsById = new Map(
      [...globalState.activeSessions, ...globalState.archivedSessions]
        .map((candidate) => [candidate.id, candidate] as const),
    )
    let primarySession = session
    const visited = new Set<string>()
    while (primarySession.parentID) {
      if (visited.has(primarySession.id)) {
        clearRestoredSession()
        return
      }
      visited.add(primarySession.id)
      const parentSession = sessionsById.get(primarySession.parentID)
      if (!parentSession) {
        clearRestoredSession()
        return
      }
      primarySession = parentSession
    }

    const authoritativeDirectory = resolveGlobalSessionDirectory(primarySession) ?? state.currentSessionDirectory
    if (!isSessionAdmitted(authoritativeDirectory)) {
      clearRestoredSession()
      return
    }
    set({ restoredSessionPendingValidation: false, restoredSessionRuntimeKey: null })
    get().setCurrentSession(primarySession.id, authoritativeDirectory, { transition: "restored", keepSingleProject: true })
  },
  captureNavigationReturn: (directory) => {
    const snapshot = {
      runtimeKey: getRuntimeKey(), directory,
      sessionId: get().currentSessionId, draft: cloneDraft(get().newSessionDraft),
      projectId: useProjectsStore.getState().activeProjectId,
    }
    return () => get().restoreNavigationReturn(snapshot)
  },
  captureNavigationReturnSnapshot: (directory) => navigationReturnSchema.parse({
    runtimeKey: getRuntimeKey(), directory,
    sessionId: get().currentSessionId, draft: get().newSessionDraft,
    projectId: useProjectsStore.getState().activeProjectId,
  }),
  restoreNavigationReturn: ({ runtimeKey, directory, sessionId, draft, projectId }) => {
      if (getRuntimeKey() !== runtimeKey) return
      if (sessionId) {
        get().setCurrentSession(sessionId, directory)
        if (projectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId)
        return
      }
      if (draft.open) {
        admissionNavigationRevision += 1
        nextDraftId = Math.max(nextDraftId, draft.draftId + 1)
        // Keep the draft id, prepared chat directory and attached context intact.
        // Restore its directory's selections without reapplying project defaults.
        draftDefaultsRevision += 1
        const restored = cloneDraft(draft)
        set({
          newSessionDraft: restored,
          currentSessionId: null,
          currentSessionDirectory: null,
          currentSessionKeepsSingleProject: false,
          materializedDraftSessionId: null,
          restoredSessionPendingValidation: false,
          restoredSessionRuntimeKey: null,
          error: null,
        })
        writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory, draft: restored })
        persistDraftTarget({ projectId: restored.selectedProjectId ?? null, directory: restored.directoryOverride, target: restored.target })
        const selectedProject = useProjectsStore.getState().projects.find(project => project.id === restored.selectedProjectId)
        void activateConfigForDirectory(restored.directoryOverride ?? selectedProject?.path ?? directory)
      } else {
        get().closeNewSessionDraft()
        get().setCurrentSession(null, directory)
      }
      if (projectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId)
      useDirectoryStore.getState().setDirectory(directory, { showOverlay: false })
      opencodeClient.setDirectory(directory)
  },
  currentSessionId: null,
  currentSessionDirectory: null,
  currentSessionKeepsSingleProject: false,
  materializedDraftSessionId: null,
  pendingDraftSends: new Map(),
  newSessionDraft: { ...DEFAULT_DRAFT },
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  worktreeMetadata: new Map(),
  availableWorktrees: flattenWorktreeMap(PERSISTED_WORKTREE_MAP),
  availableWorktreesByProject: PERSISTED_WORKTREE_MAP,
  worktreeDiscoveryByProject: new Map(),
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,

  setCurrentSession: (id, directoryHint?: string | null, transitionOrOptions?: "submitted-draft" | SetCurrentSessionOptions) => {
    const options: SetCurrentSessionOptions | undefined = typeof transitionOrOptions === "string"
      ? { transition: transitionOrOptions }
      : transitionOrOptions
    const transition = options?.transition
    const keepSingleProject = options?.keepSingleProject === true
    const navigationRevision = transition === "restored" ? admissionNavigationRevision : ++admissionNavigationRevision
    if (id) {
      const record = useGlobalSessionsStore.getState().entityById.get(id)
      const directory = withAdmittedLineage(id, (record ? resolveGlobalSessionDirectory(record) : null)
        ?? resolveSessionDirectory(id, (sid) => get().worktreeMetadata.get(sid))
        ?? normalizePath(directoryHint))
      if (!directory || !isSessionAdmitted(directory)) {
        if (transition === "restored") return
        const runtimeKey = getRuntimeKey()
        const stillSelected = () => navigationRevision === admissionNavigationRevision && runtimeKey === getRuntimeKey()
        void (async () => {
          const destination = directory ?? (isNativeSessionId(id) ? null : resolveGlobalSessionDirectory(await opencodeClient.getSession(id)))
          if (!destination || !stillSelected()) return
          const admitted = await admitSession(id, destination, true)
          if (!admitted || !stillSelected()) return
          get().setCurrentSession(id, admitted, options)
        })().catch((error) => console.warn('[session-admission] Could not open the session:', error))
        return
      }
      directoryHint = directory
    }
    const materializedDraftSessionId = id && options?.transition === "submitted-draft" ? id : null
    if (get().materializedDraftSessionId !== materializedDraftSessionId) {
      set({ materializedDraftSessionId })
    }
    const leavesChatDraft = Boolean(id) && get().newSessionDraft.open && get().newSessionDraft.target === "chat"
    if (id) {
      get().closeNewSessionDraft()
    }

    const key = runtimeMemoryKey()
    activeSessionByRuntime.set(key, id)

    const previousSessionId = get().currentSessionId
    const directoryState = useDirectoryStore.getState()

    const sessionDir = resolveSessionDirectory(
      id,
      (sid) => get().worktreeMetadata.get(sid),
    )
    const fallbackDir = opencodeClient.getDirectory() ?? directoryState.currentDirectory ?? null
    const knownDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir
    const resolvedDir = knownDir ?? fallbackDir
    const isGuessedDir = knownDir === null
    const projectsState = useProjectsStore.getState()
    const sessionProject = resolvedDir
      ? resolveProjectForSessionDirectory(
        projectsState.projects,
        get().availableWorktreesByProject,
        resolvedDir,
      )
      : null

    if (id) {
      void fetchMessagesForSession(id, resolvedDir)
    }

    set({
      currentSessionId: id,
      currentSessionDirectory: id ? resolvedDir ?? null : null,
      currentSessionKeepsSingleProject: Boolean(id) && keepSingleProject,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    })
    guessedSelectionSessionId = isGuessedDir && id ? id : null
    const rememberedDir = isGuessedDir ? null : resolvedDir ?? null
    writeRuntimeSessionMemory(key, { sessionId: id, directory: rememberedDir })
    if (id) {
      persistSessionNavigation(id, rememberedDir, key)
      // Mobile cold launches still consume the bounded legacy cache directly.
      persistLastActiveSession(key, { sessionId: id, directory: rememberedDir })
      if (transition !== "restored" && get().currentSessionId === id) {
        sharePwaSessionSelection(id)
      }
    } else if (previousSessionId) {
      clearPersistedSessionNavigation(previousSessionId, key)
    }

    try {
      if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
        directoryState.setDirectory(resolvedDir, { showOverlay: false })
      } else if (resolvedDir && leavesChatDraft) {
        void activateConfigForDirectory(resolvedDir).catch((error) => {
          console.warn("Failed to activate directory after leaving a chat draft:", error)
        })
      }
      if (sessionProject && projectsState.activeProjectId !== sessionProject.id) {
        projectsState.setActiveProjectIdOnly(sessionProject.id)
      }
      if (id && !isGuessedDir && sessionProject && !keepSingleProject) {
        useSessionDisplayStore.getState().setSingleProjectId(sessionProject.id)
      }
      opencodeClient.setDirectory(resolvedDir ?? undefined)
    } catch (e) {
      console.warn("Failed to set OpenCode directory for session switch:", e)
    }

    if (previousSessionId && previousSessionId !== id) {
      const prevId = previousSessionId
      const newId = id
      queueMicrotask(() => {
        const current = get().currentSessionId
        if (current !== newId) return
        const memState = getViewportSessionMemory(prevId)
        if (!memState?.isStreaming) {
          const prevMessages = getSyncMessages(prevId)
          if (prevMessages.length > 0) {
            useViewportStore.getState().updateViewportAnchor(prevId, prevMessages.length - 1)
          }
        }
      });
    }

    if (id) {
      if (previousSessionId !== id) releaseKeptUnreadMarks()
      markSessionViewed(id, resolvedDir)
      setActiveSession(resolvedDir ?? "", id)
    } else {
      setActiveSession("", "")
    }
  },

  clearMaterializedDraftSession: (sessionId) => {
    if (get().materializedDraftSessionId !== sessionId) return
    set({ materializedDraftSessionId: null })
  },

  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    draftDefaultsRevision += 1
    const key = runtimeMemoryKey(apiBaseUrl)
    const directoryState = useDirectoryStore.getState()
    const directory = isTransientRuntimeKey(key) || isDirectoryUnknown(directoryState)
      ? null
      : directoryState.currentDirectory || null
    const currentSessionId = get().currentSessionId
    const directorySnapshot = directory ? getDirectoryState(directory) : null
    rememberRuntimeLiveStatus({
      runtimeKey: key,
      directory,
      sessionId: currentSessionId,
      status: currentSessionId ? directorySnapshot?.session_status?.[currentSessionId] : null,
    })
    activeSessionByRuntime.set(key, get().currentSessionId)
    writeRuntimeSessionMemory(key, {
      sessionId: currentSessionId,
      directory,
      draft: cloneDraft(get().newSessionDraft),
      worktreeMetadata: new Map(get().worktreeMetadata),
      availableWorktreesByProject: new Map(get().availableWorktreesByProject),
    })
  },

  restoreForRuntimeSwitch: (apiBaseUrl?: string | null, previousRuntimeKey?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const memory = runtimeSessionMemory.get(key)
    const hasActiveMemory = activeSessionByRuntime.has(key)
    const persisted = memory || hasActiveMemory ? null : readPersistedSessionNavigation(key)
    const rememberedSessionId = memory
      ? memory.sessionId
      : hasActiveMemory
        ? activeSessionByRuntime.get(key) ?? null
        : persisted?.sessionId ?? null
    const restoredDraft = memory?.draft ? cloneDraft(memory.draft) : { ...DEFAULT_DRAFT }
    const cached = rememberedSessionId ? useGlobalSessionsStore.getState().entityById.get(rememberedSessionId) : null
    const restoredDirectory = (cached ? resolveGlobalSessionDirectory(cached) : null) ?? memory?.directory ?? persisted?.directory ?? null
    const availableWorktreesByProject = memory?.availableWorktreesByProject
      ?? readPersistedWorktreeTopology(key)
    const restoredSessionId = rememberedSessionId && isSessionDirectoryAdmitted(restoredDirectory, useProjectsStore.getState().projects, availableWorktreesByProject)
      ? rememberedSessionId : null
    if (restoredDirectory && (!rememberedSessionId || restoredSessionId)) {
      useDirectoryStore.getState().setDirectory(restoredDirectory, { showOverlay: false })
      opencodeClient.setDirectory(restoredDirectory)
    } else if (previousRuntimeKey && previousRuntimeKey !== key && !isTransientRuntimeKey(previousRuntimeKey)) {
      // Nothing is remembered here and the directory was in use on the host
      // just left, so it is forgotten instead of carried over. Coming from no
      // host (a cold launch that connects through a switch) the directory is
      // the one this window started with and stays.
      useDirectoryStore.getState().resetForRuntimeSwitch()
    }
    writeRuntimeSessionMemory(key, {
      sessionId: restoredSessionId,
      directory: restoredSessionId ? restoredDirectory : null,
      draft: restoredSessionId ? { ...DEFAULT_DRAFT } : restoredDraft,
    })
    activeSessionByRuntime.set(key, restoredSessionId)
    set({
      currentSessionId: restoredSessionId,
      currentSessionDirectory: restoredSessionId ? restoredDirectory : null,
      currentSessionKeepsSingleProject: Boolean(persisted && restoredSessionId),
      materializedDraftSessionId: null,
      restoredSessionPendingValidation: Boolean(persisted && restoredSessionId),
      restoredSessionRuntimeKey: persisted && restoredSessionId ? key : null,
      newSessionDraft: restoredSessionId ? { ...DEFAULT_DRAFT } : restoredDraft,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      error: null,
      worktreeMetadata: memory?.worktreeMetadata ?? new Map(),
      availableWorktrees: flattenWorktreeMap(availableWorktreesByProject),
      availableWorktreesByProject,
      sessionAbortFlags: new Map(),
    })
    if (restoredSessionId) {
      setActiveSession(restoredDirectory ?? opencodeClient.getDirectory() ?? "", restoredSessionId)
    } else {
      setActiveSession("", "")
      const pendingStart = restoredDraft.worktreeStartDirectory
      if (restoredDraft.open && pendingStart && typeof pendingStart !== "string" && pendingStart.directory === null) {
        applyDraftTargetSelectionDefaults(restoredDraft, availableWorktreesByProject, undefined, restoredDraft)
      }
    }
  },

  openNewSessionDraft: (options) => {
    if (!options?.automatic) admissionNavigationRevision += 1
    const projectsState = useProjectsStore.getState()
    const projects = projectsState.projects
    const availableWorktreesByProject = get().availableWorktreesByProject
    const activeProject = projectsState.getActiveProject()
    const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
    const persistedTarget = readPersistedDraftTarget()

    // Callers that forward "the current session's directory" forward it for
    // chat sessions too, and a chat session's scratch directory names no
    // project. Treating it as an explicit project target would force a project
    // draft rooted in scratch; it is a request for another chat. The archive
    // directory of a deleted isolated space is the same: a chat opened from
    // the Archive page leaves it behind as the current one, and a draft rooted
    // there would make a live session inside the archive.
    const isScratchDirectory = (directory: string): boolean => isChatDirectoryPath(directory) || isSpaceArchiveDirectory(directory)
    const rawExplicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    const explicitDirectoryIsChat = rawExplicitDirectory !== null && isScratchDirectory(rawExplicitDirectory)
    const explicitDirectory = explicitDirectoryIsChat ? null : rawExplicitDirectory
    const persistedProjectById = persistedTarget?.projectId
      ? projects.find((p) => p.id === persistedTarget.projectId) ?? null
      : null
    const persistedProjectByDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, persistedTarget?.directory ?? null)
    const currentDirProject = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, currentDirectory)
    // A user-initiated implicit open from an external path outside every
    // project is a Chat for this draft: forcing the live path into a project
    // draft is wrong, and the live location is not a target choice that should
    // erase the project the user last picked. A managed chat scratch directory
    // is not external; the recorded project still reopens from it.
    const isImplicitExternalChatFallback = currentDirectory !== null
      && !isScratchDirectory(currentDirectory)
      && currentDirProject === null
      && options?.automatic !== true
      && options?.target === undefined
      && options?.directoryOverride === undefined
      && options?.selectedProjectId === undefined
    const persistedProject = persistedProjectById ?? persistedProjectByDir

    // Nothing explicit was asked for: reopen on the side the user last worked
    // on. Only a recorded project target that still resolves to an existing
    // project beats Chat — a project removed since must not open a draft
    // pointing at a directory that is no longer registered — and the live
    // directory must not itself be an unregistered external path.
    const restoresProjectTarget = !isVSCodeRuntime()
      && !options?.target
      && options?.directoryOverride === undefined
      && options?.selectedProjectId === undefined
      && persistedTarget?.target === "project"
      && persistedProject !== null
      && !isImplicitExternalChatFallback

    let target = isVSCodeRuntime() ? "project" : options?.target
    if (!target) {
      const hasExplicitProjectTarget = (options?.directoryOverride !== undefined && !explicitDirectoryIsChat)
        || (options?.selectedProjectId !== undefined && options.selectedProjectId !== CHAT_DRAFT_PROJECT_ID)
        || isVSCodeRuntime()
      target = options?.selectedProjectId === CHAT_DRAFT_PROJECT_ID
        ? "chat"
        : hasExplicitProjectTarget || restoresProjectTarget
          ? "project"
          : "chat"
    }
    const explicitProject = target === "project" && options?.selectedProjectId
      ? projects.find((p) => p.id === options.selectedProjectId) ?? null
      : null

    const inferredProjectFromDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, explicitDirectory)
    const fallbackProject = (() => {
      if (activeProject) return activeProject
      if (projectsState.activeProjectId) return projects.find((p) => p.id === projectsState.activeProjectId) ?? null
      return projects[0] ?? null
    })()

    const selectedProject = target === "chat" ? null : (() => {
      if (explicitProject) return explicitProject
      if (explicitDirectory !== null) return inferredProjectFromDir
      // A chat session leaves a managed scratch directory behind as the current
      // one; it owns no project, so it must not decide this draft's project —
      // the recorded target below knows which project the user last chose.
      if (currentDirectory && !isScratchDirectory(currentDirectory)) return currentDirProject
      return persistedProject ?? fallbackProject
    })()

    const directory = target === "chat" ? null : (() => {
      if (explicitDirectory !== null) return explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      // A chat session's directory is a managed scratch folder, never a
      // project: letting it through would open a project draft rooted in it.
      if (currentDirectory && !isScratchDirectory(currentDirectory)) return currentDirectory
      if (persistedTarget?.directory && !isScratchDirectory(persistedTarget.directory)) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    if (target === "chat") {
      warmChatsRootDirectory()
    }

    // An unregistered live path falls back to managed Chat for this draft, but
    // it is not a user choice that should discard the recorded project target.
    if (!(target === "chat" && isImplicitExternalChatFallback)) {
      persistDraftTarget({ projectId: selectedProject?.id ?? null, directory, target })
    }

    const nextDraft: NewSessionDraftState = {
      draftId: nextDraftId++,
      open: true,
      target,
      preparedChatDirectory: null,
      selectedProjectId: selectedProject?.id ?? null,
      directoryOverride: directory,
      ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
      pendingWorktreeRequestId: options?.pendingWorktreeRequestId ?? null,
      bootstrapPendingDirectory: normalizePath(options?.bootstrapPendingDirectory ?? null),
      preserveDirectoryOverride: options?.preserveDirectoryOverride === true || isSpaceDirectory(directory),
      parentID: options?.parentID ?? null,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
      syntheticParts: options?.syntheticParts,
      targetFolderId: options?.targetFolderId,
      projectContextPins: options?.projectContextPins,
    }

    set({
      newSessionDraft: nextDraft,
      currentSessionId: null,
      currentSessionDirectory: null,
      currentSessionKeepsSingleProject: false,
      materializedDraftSessionId: null,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
      error: null,
    })

    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory, draft: nextDraft })
    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    // Config (providers/agents/default model+agent) lives at the PROJECT level. When the user
    // came from a worktree session, `directory` is the worktree path, whose provider list does
    // not include project/global-scoped providers (e.g. the default agent's non-opencode model)
    // — resolving defaults against it would wrongly fall back to opencode/big-pickle. Activate
    // the project's config instead so the default cascade matches app startup, then re-apply it
    // (a fresh draft must start from defaults, not inherit the previous session's selection).
    applyDraftTargetSelectionDefaults(nextDraft, availableWorktreesByProject, selectedProject)

    if (directory && directory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(directory)
    }

    void recoverStaleDraftDirectory(nextDraft)
  },

  prepareChatDraftDirectory: async () => {
    const draft = get().newSessionDraft
    if (!draft.open || draft.target !== "chat") return null
    if (draft.preparedChatDirectory) return draft.preparedChatDirectory

    const runtimeKey = getRuntimeKey()
    const key = `${runtimeKey}:${draft.draftId}`
    const existing = pendingChatDirectoryByDraft.get(key)
    if (existing) return existing

    const pending = (async () => {
      const cleanup = await captureChatDirectoryCleanup("chat", runtimeKey)
      if (getRuntimeKey() !== runtimeKey) return null
      const directory = await createChatDirectory()
      const current = get().newSessionDraft
      if (
        getRuntimeKey() !== runtimeKey
        || !current.open
        || current.target !== "chat"
        || current.draftId !== draft.draftId
      ) {
        await deletePreparedChatDirectory(directory, cleanup)
        return null
      }
      set({ newSessionDraft: { ...current, preparedChatDirectory: directory } })
      trackPreparedChatFolder(runtimeKey, directory)
      return directory
    })().finally(() => {
      pendingChatDirectoryByDraft.delete(key)
    })
    pendingChatDirectoryByDraft.set(key, pending)
    return pending
  },

  closeNewSessionDraft: () => {
    const currentDraft = get().newSessionDraft
    if (currentDraft.preparedChatDirectory) {
      void deleteChatDirectory(currentDraft.preparedChatDirectory).catch(() => undefined)
    }
    if (
      !currentDraft.open
      && currentDraft.selectedProjectId == null
      && currentDraft.directoryOverride == null
      && currentDraft.pendingWorktreeRequestId == null
      && currentDraft.bootstrapPendingDirectory == null
      && !currentDraft.preserveDirectoryOverride
      && currentDraft.parentID == null
      && currentDraft.title === undefined
      && currentDraft.initialPrompt === undefined
      && currentDraft.syntheticParts === undefined
      && currentDraft.targetFolderId === undefined
      && currentDraft.permissionMode === undefined
    ) {
      return
    }
    const nextDraft: NewSessionDraftState = {
      draftId: currentDraft.draftId,
      open: false,
      target: "chat",
      preparedChatDirectory: null,
      selectedProjectId: null,
      directoryOverride: null,
      pendingWorktreeRequestId: null,
      bootstrapPendingDirectory: null,
      preserveDirectoryOverride: false,
      parentID: null,
      title: undefined,
      initialPrompt: undefined,
      syntheticParts: undefined,
      targetFolderId: undefined,
    }
    set({
      newSessionDraft: nextDraft,
    })
    writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
  },

  setNewSessionDraftTarget: (target) => {
    if (isVSCodeRuntime() && !isVSCodeWithoutWorkspace() && target.projectId === CHAT_DRAFT_PROJECT_ID) return
    const previousDraft = get().newSessionDraft
    if (previousDraft.preparedChatDirectory && target.projectId !== CHAT_DRAFT_PROJECT_ID) {
      void deleteChatDirectory(previousDraft.preparedChatDirectory).catch(() => undefined)
    }
    let nextDirectory: string | null = null
    set((s) => {
      nextDirectory = normalizePath(target.directoryOverride ?? s.newSessionDraft.directoryOverride)
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          target: target.projectId === CHAT_DRAFT_PROJECT_ID ? "chat" : "project",
          preparedChatDirectory: target.projectId === CHAT_DRAFT_PROJECT_ID ? s.newSessionDraft.preparedChatDirectory : null,
          selectedProjectId: target.projectId ?? target.selectedProjectId ?? s.newSessionDraft.selectedProjectId,
          directoryOverride: target.projectId === CHAT_DRAFT_PROJECT_ID ? null : target.directoryOverride ?? s.newSessionDraft.directoryOverride,
        },
      }
    })

    applyDraftTargetSelectionDefaults(get().newSessionDraft, get().availableWorktreesByProject, undefined, previousDraft)

    const nextDraft = get().newSessionDraft
    persistDraftTarget({
      projectId: nextDraft.target === "chat" ? null : nextDraft.selectedProjectId ?? null,
      directory: normalizePath(nextDraft.directoryOverride ?? null),
      target: nextDraft.target,
    })

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
    }),

  setDraftPermissionMode: (mode) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, permissionMode: mode } }
    }),

  setDraftProjectContextPin: (kind, id, pinned) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const pins = s.newSessionDraft.projectContextPins ?? { notes: [], plans: [] }
      const key = kind === "note" ? "notes" : "plans"
      const next = new Set(pins[key])
      if (pinned) next.add(id)
      else next.delete(id)
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          projectContextPins: { ...pins, [key]: [...next] },
        },
      }
    }),

  acknowledgeSessionAbort: (sessionId) =>
    set((s) => {
      const flags = new Map(s.sessionAbortFlags)
      const existing = flags.get(sessionId)
      if (existing) flags.set(sessionId, { ...existing, acknowledged: true })
      return { sessionAbortFlags: flags }
    }),

  clearAbortPrompt: () => set({ abortPromptSessionId: null, abortPromptExpiresAt: null }),

  armAbortPrompt: (durationMs = 5000, sessionId) => {
    const target = sessionId ?? get().currentSessionId
    if (!target) return null
    const expiresAt = Date.now() + durationMs
    set({ abortPromptSessionId: target, abortPromptExpiresAt: expiresAt })
    return expiresAt
  },

  clearError: () => set({ error: null }),

  markSessionAsOpenChamberCreated: (sessionId) =>
    set((s) => {
      const next = new Set(s.webUICreatedSessions)
      next.add(sessionId)
      return { webUICreatedSessions: next }
    }),

  isOpenChamberCreatedSession: (sessionId) => get().webUICreatedSessions.has(sessionId),

  initializeNewOpenChamberSession: () => {
    // Stub — was a no-op in old store
  },

  setWorktreeMetadata: (sessionId, metadata, directoryOverride) => {
    // Write to authoritative session-worktree-store
    if (metadata) {
      useSessionWorktreeStore.getState().setAttachment(sessionId, {
        worktreeRoot: metadata.worktreeRoot ?? metadata.path ?? null,
        cwd: directoryOverride ?? metadata.path ?? null,
        branch: metadata.branch ?? null,
        headState: metadata.headState ?? (metadata.branch ? 'branch' : 'detached'),
        worktreeStatus: metadata.worktreeStatus ?? 'ready',
        worktreeSource: metadata.worktreeSource ?? null,
        legacy: false,
        degraded: false,
      })
    } else {
      useSessionWorktreeStore.getState().clearAttachment(sessionId)
    }
    // Also keep local map for backward compatibility
    set((s) => {
      const map = new Map(s.worktreeMetadata)
      if (metadata) map.set(sessionId, metadata)
      else map.delete(sessionId)
      return { worktreeMetadata: map }
    })
  },

  overrideNewSessionDraftTarget: (options) => {
    const previousDraft = get().newSessionDraft
    let nextDirectory: string | null = null
    set((s) => {
      const nextDraft = { ...s.newSessionDraft, ...options }
      nextDirectory = normalizePath(
        typeof nextDraft.directoryOverride === "string" ? nextDraft.directoryOverride : null,
      )
      return { newSessionDraft: nextDraft }
    })
    applyDraftTargetSelectionDefaults(get().newSessionDraft, get().availableWorktreesByProject, undefined, previousDraft)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  resolvePendingDraftWorktreeTarget: (requestId, directory, options) =>
    set((s) => {
      if (!s.newSessionDraft?.open || s.newSessionDraft.pendingWorktreeRequestId !== requestId) return s
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          selectedProjectId: (options as Record<string, unknown> | undefined)?.projectId as string ?? s.newSessionDraft.selectedProjectId ?? null,
          directoryOverride: normalizePath(directory),
          pendingWorktreeRequestId: null,
          bootstrapPendingDirectory: normalizePath((options as Record<string, unknown> | undefined)?.bootstrapPendingDirectory as string ?? s.newSessionDraft.bootstrapPendingDirectory ?? null),
          preserveDirectoryOverride: ((options as Record<string, unknown> | undefined)?.preserveDirectoryOverride ?? true) as boolean,
        },
      }
    }),

  setDraftBootstrapPendingDirectory: (directory) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, bootstrapPendingDirectory: normalizePath(directory) } }
    }),

  setDraftWorktreeStartDirectory: (directoryOrDraftId, worktreeRoot, directory) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const nextValue = typeof directoryOrDraftId === "number" && worktreeRoot !== undefined
        ? { worktreeRoot, directory: directory ?? null }
        : (typeof directoryOrDraftId === "string" ? directoryOrDraftId : null)
      return { newSessionDraft: { ...s.newSessionDraft, worktreeStartDirectory: nextValue } }
    }),

  setPendingDraftWorktreeRequest: (requestId) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, pendingWorktreeRequestId: requestId } }
    }),

  getWorktreeMetadata: (sessionId) => get().worktreeMetadata.get(sessionId),

  sendMessage: async (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata; systemContext?: "session-knowledge" | "feature-instructions" }>,
    variant?: string | null,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => {
    assertExpectedRuntimeContext(options?.expectedRuntime)
    const capturedTarget = options?.target
    const effortRevision = options?.effortRevision ?? readEffortRevision(providerID, modelID)
    const isCurrentRuntimeInstance = captureRuntimeInstance()
    const capturedRuntimeKey = capturedTarget?.runtimeKey ?? getRuntimeKey()
    if (capturedTarget && capturedTarget.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
    return runAfterOpenCodeStartup(async () => {
      const draft = options?.draftSnapshot ?? get().newSessionDraft
      const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined
      if (capturedRuntimeKey !== getRuntimeKey()) {
        throw new Error("Message was not sent because the runtime changed.")
      }
      const selected = capturedTarget?.sessionId ?? options?.sessionId ?? (!draft?.open ? get().currentSessionId : null)
      if (selected) await ensurePendingDraftPermissionPolicy(selected, options?.expectedRuntime)
      const backend = (selected ? nativeBackendOfSessionId(selected) : null) ?? nativeBackendOfProviderId(providerID)
      const responseStyleInstruction = inputMode === "shell" || backend !== null || (selected && isNativeSessionId(selected))
        ? undefined
        : fetchResponseStyleInstruction().catch(() => undefined)

      const queuedGoal = options?.queuedGoal
      const goalArm = inputMode === "shell" || content.trim().length === 0
        ? { armed: false, objectiveOverride: null }
        : queuedGoal !== undefined
          ? { armed: queuedGoal !== null, objectiveOverride: queuedGoal?.objective ?? null }
          : useSessionGoalArmStore.getState().consume()
      const goalArmed = goalArm.armed
      const goalUiState = useUIStore.getState()
      const goalTokenBudget = backend === "codex" ? null : queuedGoal
        ? queuedGoal.tokenBudget
        : (goalUiState.sessionGoalDefaultBudgetEnabled ? goalUiState.sessionGoalDefaultBudget : null)
      if (goalArmed) {
        additionalParts = [...(additionalParts ?? []), { text: sessionGoalIntro(goalTokenBudget), synthetic: true, systemContext: "feature-instructions" }]
      }
      const applyArmedGoal = async (goalSessionId: string, goalDirectory: string | null | undefined) => {
        if (!goalArmed) return
        const tokenBudget = goalTokenBudget
        const objective = goalArm.objectiveOverride?.trim() || (isNativeSessionId(goalSessionId) ? content : resolveGoalObjective(content, goalDirectory))
        try {
          await setSessionGoal(goalSessionId, goalDirectory ?? undefined, { objective, tokenBudget }, null, capturedRuntimeKey)
        } catch (error) {
          if (queuedGoal === undefined) useSessionGoalArmStore.getState().setArmed(true, goalArm.objectiveOverride)
          throw error
        }
      }

      let materialized: MaterializedDraftSession | null = null
      const sendingDraft = !capturedTarget && !options?.sessionId && draft?.open
      const config = useConfigStore.getState()
      if (sendingDraft && (backend || captureAgentCombinationDraft({ draftId: draft.draftId })
        || (config.selectionSource === "auto" && config.currentDefaultAgentCombinationId))) {
        materialized = await materializeOpenDraftSession({
          providerID, modelID, agent: trimmedAgent, variant,
          expectedRuntime: options?.expectedRuntime,
          onSessionMaterialized: options?.onSessionMaterialized,
        }, draft)
        if (!materialized) throw new Error("Failed to create session")
        options?.progress?.sessionMinted?.(materialized.sessionId, draft.target === "chat" ? materialized.directory : null)
        if (materialized.syntheticParts?.length) additionalParts = [...(additionalParts ?? []), ...materialized.syntheticParts]
      }
      if (sendingDraft && !materialized) {
        if (sentDraftIds.has(draft.draftId)) throw new Error("The session is still being created.")
        sentDraftIds.add(draft.draftId)
        const selection: DraftSessionSelection = { providerID, modelID, agent: trimmedAgent, variant }
        let directory: string | null = null
        let chatDirectoryCleanup: CapturedChatDirectoryCleanup | null = null
        try {
          chatDirectoryCleanup = await captureChatDirectoryCleanup(draft.target, capturedRuntimeKey)
          if (getRuntimeKey() !== capturedRuntimeKey) throw new Error("Message was not sent because the runtime changed.")
          directory = (await resolveDraftTargetDirectory(draft)) ?? opencodeClient.getDirectory() ?? null
          if (!directory) throw new Error("Failed to create session")
          if (getRuntimeKey() !== capturedRuntimeKey) {
            throw new Error("Message was not sent because the runtime changed.")
          }
        } catch (error) {
          if (draft.target === "chat") await deletePreparedChatDirectory(directory, chatDirectoryCleanup)
          sentDraftIds.delete(draft.draftId)
          throw error
        }
        const sessionDirectory = directory

        const sessionId = descendingId("ses")
        options?.progress?.sessionMinted?.(sessionId, draft.target === "chat" ? sessionDirectory : null)
        const draftAgent = saveDraftSessionSelection(sessionId, selection)
        openPendingSessionTranscript(sessionId, sessionDirectory)
        get().setCurrentSession(sessionId, sessionDirectory, { transition: "submitted-draft" })
        setPendingDraftSend(sessionId, { draftId: draft.draftId, sessionCreated: false })
        const releaseGate = () => setPendingDraftSend(sessionId, null)

        let dispatchFailed = false
        let resolveSessionCreated!: (created: boolean) => void
        const sessionCreatedOutcome = new Promise<boolean>((resolve) => { resolveSessionCreated = resolve })
        const creation = (async () => {
          try {
            const createDirectory = await resolveDraftCreateDirectory(draft, sessionDirectory)
            const created = await createSessionAction(
              draft.title,
              createDirectory,
              draftSessionMetadata(draft),
              undefined,
              draftSessionCreateSelection(selection),
              "preserve",
              sessionId,
              capturedRuntimeKey,
            )
            if (!created?.id) throw new Error("Failed to create session")
            if (created.id !== sessionId) {
              console.error("[session-ui-store] the server created the session under another id", { requested: sessionId, created: created.id })
              void deleteSessionAction(created.id).catch(() => undefined)
              throw new Error("Failed to create session")
            }
            resolveSessionCreated(true)
            options?.onSessionMaterialized?.(sessionId, createDirectory ?? sessionDirectory)
            setPendingDraftSend(sessionId, { draftId: draft.draftId, sessionCreated: true })
            if (draft.workDraftId) void useSessionDraftsStore.getState().discard(draft.workDraftId, { final: true }).catch(() => undefined)
            const createdDirectory = (await finishDraftSession(draft, created, createDirectory, capturedRuntimeKey)) ?? sessionDirectory
            if (createdDirectory !== normalizePath(sessionDirectory)) {
              adoptSessionMove(sessionId, sessionDirectory, createdDirectory)
              if (get().currentSessionId === sessionId) get().setCurrentSession(sessionId, createdDirectory, { transition: "submitted-draft" })
            }
            if (!dispatchFailed) markSessionStatus(sessionId, createdDirectory, "busy")
            await applyArmedGoal(sessionId, createdDirectory)
            if (inputMode !== "shell") await syncSessionKnowledge(createdDirectory, sessionId, await responseStyleInstruction, capturedRuntimeKey)
          } finally {
            resolveSessionCreated(false)
          }
        })()
        creation.catch(() => undefined)

        const draftParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata; systemContext?: "session-knowledge" | "feature-instructions" }> | undefined = draft.syntheticParts?.length
          ? [...(additionalParts || []), ...draft.syntheticParts]
          : additionalParts
        const historyIdentity = createInputHistoryIdentity(capturedRuntimeKey, sessionDirectory, sessionId)
        const historySubmissions = options?.historySubmissions
        const appendSubmissions = historyIdentity && historySubmissions?.length
          ? () => useInputHistoryStore.getState().appendSubmissions(historyIdentity, historySubmissions)
          : undefined

        notifyMessageSent(sessionId, sessionDirectory)
        useSessionTabsStore.getState().pinTab(sessionId)

        markPendingUserSendAnimation(sessionId)

        const files = attachments ? partitionAttachmentsForSend(attachments).fileParts : undefined

        try {
          const draftRoute = await routeMessage({
            runtimeKey: capturedRuntimeKey,
            sessionId,
            directory: sessionDirectory,
            content,
            providerID,
            modelID,
            agent: draftAgent,
            agentMentionName,
            variant,
            inputMode,
            files,
            appendSubmissions,
            delivery: options?.delivery,
            preserveModelSelection: options?.preserveModelSelection,
            interruptAntigravity: options?.interruptAntigravity,
            expectedNativeSource: options?.expectedNativeSource,
            subagentModel: options?.subagentModel,
            messageId: options?.messageId,
            expectedRuntime: options?.expectedRuntime,
            skills: options?.skills,
            ready: creation,
            beforeSend: () => { releaseGate(); options?.progress?.requestLeaving?.() },
            onMessageMinted: options?.progress?.messageMinted,
            markBusy: false,
            additionalParts: draftParts?.map((p) => ({
              text: p.text,
              synthetic: p.synthetic,
              metadata: p.metadata,
              systemContext: p.systemContext,
              files: p.attachments ? partitionAttachmentsForSend(p.attachments).fileParts : undefined,
            })),
          })
          if (draftRoute !== "shell" && options?.recordEffort && isCurrentRuntimeInstance()) {
            rememberEffort(providerID, modelID, variant ?? null, effortRevision)
          }
        } catch (error) {
          dispatchFailed = true
          const sessionCreated = await sessionCreatedOutcome
          releaseGate()
          const liveDirectory = getSyncSessionDirectory(sessionId) ?? sessionDirectory
          if (sessionCreated) {
            markSessionStatus(sessionId, liveDirectory, "idle")
          } else {
            await deletePreparedChatDirectory(sessionDirectory, chatDirectoryCleanup)
            reopenDraftAfterFailedCreation(draft, sessionId, sessionDirectory, capturedRuntimeKey)
          }
          throw new DraftSendError(sessionId, liveDirectory, sessionCreated, error)
        }
        return
      }

      const targetSessionId = materialized?.sessionId ?? capturedTarget?.sessionId ?? options?.sessionId ?? get().currentSessionId
      const settleModelPick = targetSessionId
        ? useSelectionStore.getState().captureSessionModelPickSettlement(targetSessionId, providerID, modelID, capturedRuntimeKey)
        : undefined
      const resumeAfterSend = options?.userInitiated && inputMode !== 'shell' && targetSessionId
        ? prepareUserMessageResume(targetSessionId, capturedRuntimeKey)
        : undefined
      const sessionAgentSelection = targetSessionId
        ? useSelectionStore.getState().getSessionAgentSelection(targetSessionId)
        : null
      const configAgentName = useConfigStore.getState().currentAgentName
      const effectiveAgent = trimmedAgent || materialized?.agent || sessionAgentSelection || configAgentName || undefined

      if (targetSessionId) {
        useSelectionStore.getState().saveSessionModelSelection(targetSessionId, providerID, modelID)
      }

      if (targetSessionId && effectiveAgent) {
        useSelectionStore.getState().saveSessionAgentSelection(targetSessionId, effectiveAgent)
        useSelectionStore.getState().saveAgentModelVariantForSession(
          targetSessionId,
          effectiveAgent,
          providerID,
          modelID,
          resolveVariantToRecord(targetSessionId === get().currentSessionId, effectiveAgent, providerID, modelID, variant),
        )
      }

      if (targetSessionId) {
        const viewportState = useViewportStore.getState()
        const memState = getViewportSessionMemory(targetSessionId)
        if (!memState || !memState.lastUserMessageAt) {
          const newMemState = new Map(viewportState.sessionMemoryState)
          newMemState.set(viewportSessionKey(targetSessionId), {
            viewportAnchor: 0,
            isStreaming: false,
            lastAccessedAt: Date.now(),
            backgroundMessageCount: 0,
            ...memState,
            lastUserMessageAt: Date.now(),
          })
          useViewportStore.setState({ sessionMemoryState: newMemState })
        }
      }

      const currentSessionDirectory = targetSessionId
        ? normalizePath(materialized?.directory ?? capturedTarget?.directory ?? options?.directory ?? get().getDirectoryForSession(targetSessionId))
        : null
      if (targetSessionId) {
        notifyMessageSent(targetSessionId, currentSessionDirectory)
        useSessionTabsStore.getState().pinTab(targetSessionId)
      }

      if (targetSessionId) {
        markPendingUserSendAnimation(targetSessionId)
      }

      const files = attachments ? partitionAttachmentsForSend(attachments).fileParts : undefined

      const knowledgeSync = responseStyleInstruction && targetSessionId && !isNativeSessionId(targetSessionId)
        ? responseStyleInstruction.then((style) => syncSessionKnowledge(currentSessionDirectory, targetSessionId, style, capturedRuntimeKey))
        : undefined

      if (targetSessionId) {
        await applyArmedGoal(targetSessionId, currentSessionDirectory)
      }
      const historyIdentity = createInputHistoryIdentity(
        capturedRuntimeKey,
        currentSessionDirectory ?? '',
        targetSessionId || '',
      )
      const historySubmissions = options?.historySubmissions
      const appendSubmissions = historyIdentity && historySubmissions?.length
        ? () => useInputHistoryStore.getState().appendSubmissions(historyIdentity, historySubmissions)
        : undefined

      const carriedPick = inputMode !== "shell" && targetSessionId && effectiveAgent
        && useSelectionStore.getState().getSessionAgentPick(targetSessionId) === effectiveAgent
        ? { sessionId: targetSessionId, agent: effectiveAgent }
        : null
      if (carriedPick) useSelectionStore.getState().settleSessionAgentPick(carriedPick.sessionId, carriedPick.agent)
      const settleSentSelection = targetSessionId
        ? useSelectionStore.getState().captureSessionSelectionSentSettlement(targetSessionId, providerID, modelID, effectiveAgent, variant)
        : undefined
      const routed = await routeMessage({
        runtimeKey: capturedRuntimeKey,
        sessionId: targetSessionId || "",
        directory: currentSessionDirectory,
        content,
        providerID,
        modelID,
        agent: effectiveAgent,
        agentMentionName,
        variant,
        inputMode,
        files,
        appendSubmissions,
        delivery: options?.delivery,
        preserveModelSelection: options?.preserveModelSelection,
        interruptAntigravity: options?.interruptAntigravity,
            expectedNativeSource: options?.expectedNativeSource,
        subagentModel: options?.subagentModel,
        messageId: options?.messageId,
        expectedRuntime: options?.expectedRuntime,
        skills: options?.skills,
        metadata: options?.metadata,
        ready: knowledgeSync,
        beforeSend: options?.progress?.requestLeaving,
        onMessageMinted: options?.progress?.messageMinted,
        additionalParts: additionalParts?.map((p) => ({
          text: p.text,
          synthetic: p.synthetic,
          metadata: p.metadata,
          systemContext: p.systemContext,
          files: p.attachments ? partitionAttachmentsForSend(p.attachments).fileParts : undefined,
        })),
      }).catch((error) => {
        const selection = useSelectionStore.getState()
        if (carriedPick && selection.getSessionAgentPick(carriedPick.sessionId) === null
          && selection.getSessionAgentSelection(carriedPick.sessionId) === carriedPick.agent) {
          selection.pickSessionAgent(carriedPick.sessionId, carriedPick.agent)
        }
        throw error
      })
      if (targetSessionId) options?.onSent?.({ route: routed, sessionId: targetSessionId })
      if (routed !== "shell" && options?.recordEffort && isCurrentRuntimeInstance()) {
        rememberEffort(providerID, modelID, variant ?? null, effortRevision)
      }
      if (routed !== "shell") {
        settleModelPick?.()
        if (isCurrentRuntimeInstance()) settleSentSelection?.()
      }
      void resumeAfterSend?.().catch(console.warn)
    })
  },

  createSession: (title, directoryOverride, metadata, selection) =>
    createSessionWithDraftLifecycle(title, directoryOverride, metadata, undefined, selection),

  deleteSession: async (id, options) => deleteSessionAction(id, options),

  deleteSessions: async (ids, options) => {
    const result = await deleteSessionsAction(ids, options)

    return result
  },

  archiveSession: (id) => archiveSessionAction(id),

  archiveSessions: (ids, options) => archiveSessionsAction(ids, options),

  unarchiveSession: (id) => unarchiveSessionAction(id),

  unarchiveSessions: (ids, options) => unarchiveSessionsAction(ids, options),

  updateSessionTitle: async (sessionId, title) => {
    await updateSessionTitleAction(sessionId, title, { byUser: true })
  },

  revertToMessage: async (sessionId, messageId) => {
    try {
      const outcome = await revertToMessageAction(sessionId, messageId, { refresh: true })
      if (outcome.conversationOnly) await showRevertToast("info", "chat.revert.toast.conversationOnly")
      return true
    } catch (error) {
      const refusal = error instanceof NativeAgentsRequestError ? nativeRevertRefusal(error) : null
      if (!refusal) throw error
      await showRevertToast("error", refusal)
      return false
    }
  },

  handleSlashUndo: async (sessionId) => {
    const messages = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)

    const userMessages = messages.filter((m) => m.role === "user")
    if (userMessages.length === 0) return

    const revertToId = currentSession?.revert?.messageID
    let targetMessage: typeof messages[number] | undefined
    if (revertToId) {
      const revertIndex = revertedUserMessageIndex(messages, userMessages, revertToId)
      targetMessage = revertIndex > 0 ? userMessages[revertIndex - 1] : undefined
    } else {
      targetMessage = userMessages[userMessages.length - 1]
    }

    if (!targetMessage) return

    // Read target message parts BEFORE calling revertToMessage.
    // revertToMessage optimistically deletes messages from the sync store
    // before the API call, so getSyncParts must run first.
    const targetParts = getSyncParts(targetMessage.id)
    const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
    const preview = textPart?.text
      ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
      : "[No text]"

    // revertToMessage handles the redo stack push internally
    if (!(await get().revertToMessage(sessionId, targetMessage.id))) return

    const { toast } = await import("sonner")
    const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
    const { dictionary } = useI18nStore.getState()
    toast.success(formatMessage(dictionary, "chat.revert.toast.undo", { preview }))
  },

  handleSlashRedo: async (sessionId) => {
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)
    const revertToId = currentSession?.revert?.messageID
    if (!revertToId) return

    await refetchSessionMessages(sessionId)
    const messages = getSyncMessages(sessionId)
    const userMessages = messages.filter((m) => m.role === "user")
    const revertIndex = revertedUserMessageIndex(messages, userMessages, revertToId)
    const targetMessage = revertIndex >= 0 ? userMessages[revertIndex + 1] : undefined

    if (targetMessage) {
      if (!(await get().revertToMessage(sessionId, targetMessage.id, { skipRedoPush: true }))) return
      const { toast } = await import("sonner")
      const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
      const { dictionary } = useI18nStore.getState()
      toast.success(formatMessage(dictionary, "chat.revert.toast.redo"))
    }
    // A committed revert has no server-side undo in OpenCode 2.x: once the
    // marker is at the newest user message there is nothing further to redo.
  },

  forkFromMessage: async (sessionId, messageId) => {
    const sessions = getSyncSessions()
    const existingSession = sessions.find((s) => s.id === sessionId)
    if (!existingSession) return

    try {
      await forkFromMessageAction(sessionId, messageId)

      const { toast } = await import("sonner")
      toast.success(`Forked from ${existingSession.title}`)
    } catch (error) {
      console.error("Failed to fork session:", error)
      const refusal = error instanceof NativeAgentsRequestError ? nativeRevertRefusal(error) : null
      if (refusal) {
        await showRevertToast("error", refusal)
        return
      }
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    }
  },

  forkAfterMessage: async (sessionId, messageId) => {
    const existingSession = getSyncSessions().find((s) => s.id === sessionId)
    if (!existingSession) return

    try {
      await forkAfterMessageAction(sessionId, messageId)

      const { toast } = await import("sonner")
      toast.success(`Forked from ${existingSession.title}`)
    } catch (error) {
      console.error("Failed to fork session:", error)
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    }
  },

  createSessionFromAssistantMessage: async (source, execution) => {
    if (!source.sessionId) return
    if (!execution?.instructions?.trim()) return
    const assistantPlanText = source.text
    if (!assistantPlanText.trim()) return

    const sourceDirectory = normalizePath(source.directory)
    if (!sourceDirectory) {
      throw new Error("Source session directory is unavailable")
    }
    const sourceWorktreeMetadata = get().worktreeMetadata.get(source.sessionId)

    const providerID = execution.providerID || useSelectionStore.getState().lastUsedProvider?.providerID
    const modelID = execution.modelID || useSelectionStore.getState().lastUsedProvider?.modelID

    if (!providerID || !modelID) return

    let sessionDirectory: string | null = sourceDirectory
    let createdWorktree: WorktreeMetadata | null = null
    let createdWorktreeProject: { id: string; path: string } | null = null

    if (execution.createWorktree) {
      if (isSpaceDirectory(sourceDirectory)) {
        throw new Error("A fork of a session in an isolated space stays in the space")
      }
      const projects = useProjectsStore.getState().projects
      const project = resolveProjectForSessionDirectory(
        projects,
        get().availableWorktreesByProject,
        sourceWorktreeMetadata?.projectDirectory ?? null,
      ) ?? resolveProjectForSessionDirectory(
        projects,
        get().availableWorktreesByProject,
        sourceDirectory,
      )
      if (!project?.path) {
        throw new Error("Project is not registered in OpenChamber")
      }

      const [branchNameModule, configModule, trustModule, createModule] = await Promise.all([
        import("@/lib/git/branchNameGenerator"),
        import("@/lib/openchamberConfig"),
        import("@/lib/sharedTrustConfirmation"),
        import("@/lib/worktrees/worktreeCreate"),
      ])
      const branchName = branchNameModule.generateBranchName()
      createdWorktreeProject = { id: project.id, path: project.path }
      const setupCommands = await trustModule.resolveWorktreeSetupCommands(createdWorktreeProject)
      createdWorktree = await createModule.createWorktreeWithDefaults(createdWorktreeProject, {
        preferredName: branchName,
        mode: "new",
        branchName,
        worktreeName: branchName,
        setupCommands,
        returnAfterDirectoryCreated: true,
      })
      sessionDirectory = normalizePath(createdWorktree.path)
      if (!sessionDirectory) {
        throw new Error("Worktree create missing name/path")
      }
      if (await configModule.getWorktreeSetupWaitEnabled(createdWorktreeProject)) {
        await waitForWorktreeBootstrap(sessionDirectory)
      }
      sessionDirectory = await resolveCreatedWorktreeStartDirectory(createdWorktreeProject, createdWorktree)
    }

    const session = await get().createSession(undefined, sessionDirectory)
    if (!session) {
      if (createdWorktree && createdWorktreeProject) {
        const { removeProjectWorktree } = await import("@/lib/worktrees/worktreeManager")
        await removeProjectWorktree(createdWorktreeProject, createdWorktree, { deleteLocalBranch: true }).catch(() => undefined)
      }
      throw new Error("Failed to create session")
    }

    if (createdWorktree) {
      get().setWorktreeMetadata(session.id, {
        ...createdWorktree,
        kind: "standard",
      }, sessionDirectory)
      useDirectoryStore.getState().setDirectory(sessionDirectory, { showOverlay: false })
    }

    useSessionGoalArmStore.getState().setArmed(execution.runAsGoal === true)

    await get().sendMessage(
      composeForkSessionMessage(execution.instructions, assistantPlanText),
      providerID,
      modelID,
      execution.agent || undefined,
      undefined,
      undefined,
      undefined,
      execution.variant || undefined,
      undefined,
      { sessionId: session.id },
    )
  },

  getSessionsByDirectory: (directory) => {
    const nd = normalizePath(directory)
    if (!nd) return []
    const sessions = getAllSyncSessions()
    return sessions.filter((s) => resolveDirectoryKey(s) === nd)
  },

  getDirectoryForSession: (sessionId) => {
    const selected = sessionId === get().currentSessionId ? get().currentSessionDirectory : null
    const resolved = resolveSessionDirectory(
      sessionId,
      (sid) => get().worktreeMetadata.get(sid),
      selected,
    )
    if (resolved) return resolved
    const globalStore = useGlobalSessionsStore.getState()
    const globalSession = [...globalStore.activeSessions, ...globalStore.archivedSessions]
      .find((s) => s.id === sessionId)
    if (globalSession) return resolveGlobalSessionDirectory(globalSession)
    return null
  },

  getLastUserChoice: (sessionId) => {
    const directory = get().getDirectoryForSession(sessionId) ?? undefined
    const messages = getSyncMessages(sessionId, directory)
    const choice = findLatestUserModelChoice(
      messages,
      (messageId) => getSyncParts(messageId, directory),
    )
    if (!choice) {
      return null
    }
    return {
      agent: choice.agent,
      providerID: choice.providerID,
      modelID: choice.modelID,
      variant: choice.variant,
    }
  },

  getCurrentAgent: (sessionId) => {
    return useSelectionStore.getState().sessionAgentSelections.get(sessionId) ?? undefined
  },

  debugSessionMessages: async (sessionId) => {
    const msgs = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    console.log(`Debug session ${sessionId}:`, {
      session,
      messageCount: msgs.length,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        tokens: m.role === "assistant" ? m.tokens : undefined,
      })),
    })
  },

  pollForTokenUpdates: () => {
    // Handled by sync system's SSE stream
  },

  adoptAuthoritativeSessionDirectory: (sessionId) => {
    const target = sessionId ?? get().currentSessionId
    // Only a guess is promoted. A confirmed selection outranks anything sync
    // learns later, and a selection that has since moved on must not be
    // rewritten by a directory that finished bootstrapping in the background.
    if (!target || target !== guessedSelectionSessionId) return
    if (target !== get().currentSessionId) return

    const authoritative = getAuthoritativeSessionDirectory(target)
    if (!authoritative) return

    // The selection stops being a guess even when the directory is unchanged:
    // the value has now been confirmed by the store that owns the session.
    guessedSelectionSessionId = null
    if (authoritative !== get().currentSessionDirectory) {
      set({ currentSessionDirectory: authoritative })
    }
    setActiveSession(authoritative, target)
    const key = runtimeMemoryKey()
    writeRuntimeSessionMemory(key, { sessionId: target, directory: authoritative })
    persistSessionNavigation(target, authoritative, key)
    persistLastActiveSession(key, { sessionId: target, directory: authoritative })
  },

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
    if (sessionId === guessedSelectionSessionId) {
      guessedSelectionSessionId = null
    }
    if (sessionId === get().currentSessionId) {
      if (normalized && !isSessionAdmitted(normalized)) {
        get().setCurrentSession(null)
        get().setCurrentSession(sessionId, normalized)
        return
      }
      const moved = normalized !== get().currentSessionDirectory
      set({ currentSessionDirectory: normalized })
      setActiveSession(normalized ?? "", sessionId)
      const key = runtimeMemoryKey()
      writeRuntimeSessionMemory(key, { sessionId, directory: normalized })
      persistSessionNavigation(sessionId, normalized, key)
      persistLastActiveSession(key, { sessionId, directory: normalized })
      if (moved && normalized && !useConfigStore.getState().providersLoaded) {
        useDirectoryStore.getState().setDirectory(normalized, { showOverlay: false })
        opencodeClient.setDirectory(normalized)
      }
    }
  },
}))

const lastPersistedWorktreeSerializedByRuntime = new Map<string, string>()
setSessionOpener((sessionID, directory) => {
  useSessionUIStore.getState().setCurrentSession(sessionID, directory)
})

useSessionUIStore.subscribe((state, prev) => {
  if (state.availableWorktreesByProject !== prev.availableWorktreesByProject) {
    const runtimeKey = runtimeMemoryKey()
    const serialized = JSON.stringify([...state.availableWorktreesByProject.entries()])
    if (serialized !== lastPersistedWorktreeSerializedByRuntime.get(runtimeKey)) {
      lastPersistedWorktreeSerializedByRuntime.set(runtimeKey, serialized)
      persistWorktreeTopology(runtimeKey, state.availableWorktreesByProject)
    }
  }
})

export type { AttachedFile }

export { routeMessage } from './session-dispatch';
