import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { getAllSyncSessionMap, getDirectoryState } from "./sync-refs"
import * as sessionActions from "./session-actions"

const RETRY_DELAYS_MS = [0, 250, 1000]

type Dependencies = {
  getPolicy: () => { sessions: Record<string, boolean>; defaultEnabled: boolean } | null
  getSessions: () => ReadonlyMap<string, Session>
  getSession: (sessionId: string, directory?: string) => Promise<Session>
  getKnownPendingPermissions?: (directory?: string) => PermissionRequest[]
  listPendingPermissions: (directory?: string) => Promise<PermissionRequest[]>
  getPermissionState: (sessionId: string, requestId: string, directory?: string) => Promise<"ok" | "resolved" | "unknown">
  reply: (sessionId: string, requestId: string, directory?: string) => Promise<void>
  wait: (delayMs: number) => Promise<void>
}

export function createVSCodePermissionAutoAcceptRuntime(dependencies: Dependencies) {
  const inFlight = new Map<string, Promise<boolean>>()
  const reconcileInFlight = new Map<string, Promise<void>>()
  const recentOutcomes = new Map<string, boolean>()

  const isEnabled = async (sessionId: string, directory?: string) => {
    if (!sessionId) return false
    const policy = dependencies.getPolicy()
    if (!policy) return false
    const syncedSessions = dependencies.getSessions()
    const seen = new Set<string>()
    let current: string | undefined = sessionId
    let currentDirectory = directory

    while (current) {
      if (seen.has(current)) return false
      if (Object.prototype.hasOwnProperty.call(policy.sessions, current)) return policy.sessions[current] === true
      seen.add(current)

      let session: Session | undefined = syncedSessions.get(current)
      if (!session) {
        try {
          session = await dependencies.getSession(current, currentDirectory)
        } catch {
          return false
        }
      }
      if (!session || session.id !== current) return false
      current = session.parentID
      currentDirectory = session.directory || currentDirectory
    }
    return policy.defaultEnabled
  }

  const processPermission = (
    permission: PermissionRequest,
    directory?: string,
    options?: { verifyPending?: boolean },
  ) => {
    const recent = recentOutcomes.get(permission.id)
    if (recent !== undefined) return Promise.resolve(recent)
    const existing = inFlight.get(permission.id)
    if (existing) return existing

    const task = (async () => {
      if (!(await isEnabled(permission.sessionID, directory))) return false

      if (options?.verifyPending !== false) {
        const permissionState = await dependencies.getPermissionState(permission.sessionID, permission.id, directory)
        if (permissionState === "resolved") return true
      }

      for (const delay of RETRY_DELAYS_MS) {
        if (delay > 0) await dependencies.wait(delay)
        try {
          await dependencies.reply(permission.sessionID, permission.id, directory)
          return true
        } catch {
          // A failed reply stays visible after the bounded retries.
        }
      }
      return false
    })().then((accepted) => {
      if (accepted) {
        recentOutcomes.set(permission.id, true)
        setTimeout(() => recentOutcomes.delete(permission.id), 5000)
      }
      return accepted
    }).finally(() => inFlight.delete(permission.id))

    inFlight.set(permission.id, task)
    return task
  }

  const reconcilePending = (directory?: string) => {
    const key = directory?.trim() || "all"
    const existing = reconcileInFlight.get(key)
    if (existing) return existing

    const task = (async () => {
      const processed = new Set<string>()
      const processAll = async (permissions: PermissionRequest[], verifyPending: boolean) => {
        const pending = permissions.filter((permission) => {
          if (!permission?.id || processed.has(permission.id)) return false
          processed.add(permission.id)
          return true
        })
        await Promise.all(pending.map((permission) => processPermission(permission, directory, { verifyPending })))
      }

      // A permission.asked event is already authoritative local state. Process
      // those visible cards before the network reconciliation so enabling the
      // toggle works even when permission.list is unavailable or stale.
      await processAll(dependencies.getKnownPendingPermissions?.(directory) ?? [], false)
      await processAll(await dependencies.listPendingPermissions(directory), true)
    })()
      .finally(() => reconcileInFlight.delete(key))

    reconcileInFlight.set(key, task)
    return task
  }

  return { processPermission, reconcilePending }
}

const runtime = createVSCodePermissionAutoAcceptRuntime({
  getPolicy: () => {
    const state = usePermissionStore.getState()
    return state.loaded
      ? { sessions: state.autoAccept, defaultEnabled: state.defaultEnabled }
      : null
  },
  getSessions: getAllSyncSessionMap,
  getSession: (sessionId, directory) => opencodeClient.getSession(sessionId, directory),
  getKnownPendingPermissions: (directory) => Object.values(getDirectoryState(directory)?.permission ?? {}).flat(),
  listPendingPermissions: (directory) => opencodeClient.listPendingPermissions({ directories: [directory] }),
  getPermissionState: async (sessionId, requestId, directory) => (await opencodeClient.fetchPermission(sessionId, requestId, directory)).state,
  reply: (sessionId, requestId, directory) => sessionActions.respondToPermission(sessionId, requestId, "once", directory),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
})

export const processVSCodePermissionAutoAccept = (
  permission: PermissionRequest,
  directory?: string,
) => runtime.processPermission(permission, directory, { verifyPending: false })
export const processVSCodeReconciledPermissionAutoAccept = runtime.processPermission
export const reconcileVSCodePendingPermissions = runtime.reconcilePending
