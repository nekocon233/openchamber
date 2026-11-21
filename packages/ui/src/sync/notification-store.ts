
import { create } from "zustand"
import { clearDesktopSessionNotifications } from "@/lib/desktop"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getUnreadSessionIds, markSessionsUnreadSeen, markSessionUnreadSeen, useSessionUnread } from "./session-unread"

export type ErrorNotification = {
  type?: string
  viewed?: boolean
  directory?: string
  session?: string
  time: number
  error?: { name: string | null; message: string | null; responseBody?: string | null }
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: ErrorNotification[]): ErrorNotification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

interface NotificationStore {
  index: {
    sessionUnseenById?: Record<string, number>
    session: { unseenCount: Record<string, number>; unseenHasError?: Record<string, boolean> }
    project?: { unseenCount: Record<string, number>; unseenHasError?: Record<string, boolean> }
  }
  list: ErrorNotification[]
  append: (notification: ErrorNotification) => void
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  index: { sessionUnseenById: {}, session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } },
  list: [],
  append: (notification) => {
    set({ list: pruneNotifications([...get().list, notification]) })
  },
}))

export function appendErrorNotification(notification: ErrorNotification) {
  useNotificationStore.getState().append(notification)
}

export function appendNotification(notification: ErrorNotification & { type?: string; viewed?: boolean }) {
  if (notification.error) {
    useNotificationStore.getState().append(notification)
  }
}

export function useSessionUnseenCount(sessionId?: string | null): number {
  const unread = useSessionUnread(sessionId ?? "")
  return unread ? 1 : 0
}

function closeWebPushSessionNotifications(sessionId: string, spaceId: string | null) {
  void navigator.serviceWorker?.getRegistration()
    .then((registration) => registration?.getNotifications())
    .then((shown) => {
      for (const notification of shown ?? []) {
        const owner = notification.data?.spaceId ?? spaceIdOfDirectory(notification.data?.directory)
        if (notification.data?.sessionId === sessionId && owner === spaceId) notification.close()
      }
    })
    .catch(() => { /* a browser without push notifications has nothing to close */ })
}

export function sessionNotificationUrl(sessionId: string, action: 'view' | 'message-sent', directory?: string | null): string {
  const spaceId = spaceIdOfDirectory(directory)
  return `/api/sessions/${encodeURIComponent(sessionId)}/${action}${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ''}`
}

function clearSessionNotifications(sessionId: string, directory?: string | null) {
  const session = directory === undefined ? useGlobalSessionsStore.getState().entityById.get(sessionId) : null
  const owner = directory ?? (session ? resolveGlobalSessionDirectory(session) : null)
  clearDesktopSessionNotifications(sessionId)
  closeWebPushSessionNotifications(sessionId, spaceIdOfDirectory(owner))
  runtimeFetch(sessionNotificationUrl(sessionId, 'view', owner), { method: "POST" }).catch(() => {})
}

export function markSessionViewed(sessionId: string, directory?: string | null) {
  markSessionUnreadSeen(sessionId)
  clearSessionNotifications(sessionId, directory)
}

export function markSessionRead(sessionId: string) {
  markSessionUnreadSeen(sessionId, { explicit: true })
  clearSessionNotifications(sessionId)
}

export function markAllSessionsViewed() {
  for (const sessionId of markSessionsUnreadSeen(getUnreadSessionIds(), { explicit: true })) clearSessionNotifications(sessionId)
}

export function useLatestSessionError(sessionId: string): ErrorNotification | null {
  return useNotificationStore((s) => {
    if (!sessionId) return null
    for (let index = s.list.length - 1; index >= 0; index -= 1) {
      const notification = s.list[index]
      if (notification.session === sessionId) return notification
    }
    return null
  })
}
