import type { StoreApi } from "zustand"
import type { FormRequest, PermissionRequest } from "@/lib/opencode/model"
import { isVSCodeRuntime } from "@/lib/desktop"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { readDirectoryFormSnapshot } from "./directory-recovery-snapshots"
import { mergeNativeFormSnapshot, readNativeForms } from "./native-directory-snapshots"
import { isNativeSessionId } from "@/lib/native-agents/ids"
import { opencodeClient } from "@/lib/opencode/client"
import { processVSCodeReconciledPermissionAutoAccept } from "./vscode-permission-auto-accept"
import { toast } from "@/components/ui"
import { showPermissionNeededToast } from "./permission-toast"
import { isViewedInCurrentSession } from "./viewed-sessions"
import {
  getFormToastKey,
  pendingFormToastIds,
  FORM_TOAST_DESCRIPTION,
  formToastAction,
  pendingPermissionToastIds,
  openRequestFromToast,
} from "./sync-request-notifications"

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean; isCurrent?: () => boolean },
) {
  const isCurrent = options?.isCurrent ?? (() => true)
  if (!isCurrent()) return
  let succeeded = true
  const before = store.getState()
  const candidateIds = new Set<string>(candidateSessionIds ?? [
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.form ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  if (candidateIds.size === 0) return
  const candidates = Array.from(candidateIds)
  const needsOpenCode = candidates.some((sessionId) => !isNativeSessionId(sessionId))
  const needsNative = candidates.some((sessionId) => isNativeSessionId(sessionId))

  try {
    let openCodeOk = true
    let nativeOk = true
    const snapshot = await readDirectoryFormSnapshot(store, async () => {
      const [pendingForms, nativeForms] = await Promise.all([
        needsOpenCode
          ? opencodeClient.listPendingForms({ directories: [directory] }).catch(() => { openCodeOk = false; return null })
          : Promise.resolve<FormRequest[]>([]),
        needsNative ? readNativeForms(directory) : Promise.resolve(null),
      ])
      nativeOk = !needsNative || nativeForms !== null
      if (nativeForms && candidates.some((id) => nativeForms.unavailableSessionIds.has(id))) succeeded = false
      return [
        ...(pendingForms ?? Object.values(before.form).flat().filter((form) => !isNativeSessionId(form.sessionID))),
        ...(needsNative ? mergeNativeFormSnapshot(nativeForms, store.getState().form) : []),
      ]
    })
    if (!isCurrent()) return
    if (!openCodeOk || !nativeOk) succeeded = false
    // A failed backend read leaves that backend's sessions' questions as they are.
    const settledCandidates = candidates.filter((sessionId) => (
      isNativeSessionId(sessionId) ? nativeOk : openCodeOk
    ))
    const grouped: Record<string, FormRequest[]> = {}
    for (const sessionId of settledCandidates) {
      const forms = snapshot[sessionId]
      if (forms && forms.length > 0) grouped[sessionId] = forms
    }

    for (const [sessionId, forms] of Object.entries(grouped)) {
      const knownIds = new Set((before.form[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const form of forms) {
        if (knownIds.has(form.id)) continue
        const toastKey = getFormToastKey(sessionId, form.id)
        if (!toastKey || pendingFormToastIds.has(toastKey)) continue
        pendingFormToastIds.add(toastKey)
        toast.info(form.title, {
          id: `form-${toastKey}`,
          description: FORM_TOAST_DESCRIPTION,
          action: formToastAction(sessionId, directory, form.id),
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      let merged: Record<string, FormRequest[]> | null = null
      const draft = () => (merged ??= { ...state.form })
      for (const sessionId of settledCandidates) {
        const next = grouped[sessionId]
        const existing = state.form[sessionId]
        if (next && next.length > 0) {
          if (existing && JSON.stringify(existing) === JSON.stringify(next)) continue
          draft()[sessionId] = next
        } else if (sessionId in state.form) {
          delete draft()[sessionId]
        }
      }
      return merged ? { form: merged } : state
    })
  } catch {
    succeeded = false
  }

  if (options?.includePermissions === false || !needsOpenCode) return succeeded

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    if (!isCurrent()) return
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!candidateIds.has(permission.sessionID)) continue
      const list = grouped[permission.sessionID]
      if (list) list.push(permission)
      else grouped[permission.sessionID] = [permission]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    if (isVSCodeRuntime()) {
      const acceptedIdsBySession = new Map<string, Set<string>>()
      await Promise.all(Object.entries(grouped).flatMap(([sessionId, permissions]) =>
        permissions.map(async (permission) => {
          if (!(await processVSCodeReconciledPermissionAutoAccept(permission, directory))) return
          const accepted = acceptedIdsBySession.get(sessionId) ?? new Set<string>()
          accepted.add(permission.id)
          acceptedIdsBySession.set(sessionId, accepted)
        }),
      ))
      if (!isCurrent()) return

      for (const sessionId of Object.keys(grouped)) {
        const acceptedIds = acceptedIdsBySession.get(sessionId)
        if (!acceptedIds) continue
        const remaining = (grouped[sessionId] ?? []).filter((permission) => !acceptedIds.has(permission.id))
        if (remaining.length > 0) grouped[sessionId] = remaining
        else delete grouped[sessionId]
      }
    }

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        showPermissionNeededToast({
          permission,
          directory,
          isViewed,
          pendingIds: pendingPermissionToastIds,
          show: (title, options) => toast.info(title, options),
          openSession: openRequestFromToast,
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission }
      for (const [sessionId, permissions] of Object.entries(grouped)) {
        merged[sessionId] = permissions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.permission[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { permission: merged }
    })
  } catch {
    succeeded = false
  }
  return succeeded
}

export async function resyncBlockingRequestsForActiveDirectory(
  directory: string,
  childStores: ChildStoreManager,
) {
  const store = childStores.getChild(directory)
  if (!store) return
  await resyncBlockingRequestsForDirectory(directory, store)
}
