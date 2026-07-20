import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';
import { isBrowserPushRegistrationConfirmed } from '@openchamber/ui/lib/browserPushRegistration';

const SW_READY_TIMEOUT_MS = 1500;
const NOTIFICATION_DEDUPE_TTL_MS = 5000;
const NOTIFICATION_DEDUPE_STORAGE_PREFIX = 'openchamber-notification-claim:';

const notificationClaims = new Map<string, number>();

const isClientFocused = (): boolean => {
  if (typeof document === 'undefined') return true;
  return document.hasFocus();
};

const getNotificationClaimKey = (payload?: NotificationPayload): string => {
  const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
  if (tag) return tag;

  return [payload?.sessionId, payload?.kind, payload?.title, payload?.body]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('|');
};

const pruneNotificationClaims = (now: number): void => {
  for (const [key, claimedAt] of notificationClaims) {
    if (now - claimedAt > NOTIFICATION_DEDUPE_TTL_MS) {
      notificationClaims.delete(key);
    }
  }
};

const claimNotificationPayload = (payload?: NotificationPayload): boolean => {
  const key = getNotificationClaimKey(payload);
  if (!key) return true;

  const now = Date.now();
  pruneNotificationClaims(now);

  const claimedAt = notificationClaims.get(key) ?? 0;
  if (now - claimedAt < NOTIFICATION_DEDUPE_TTL_MS) {
    return false;
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const storageKey = `${NOTIFICATION_DEDUPE_STORAGE_PREFIX}${key}`;
      const stored = Number(window.localStorage.getItem(storageKey) ?? '0');
      if (Number.isFinite(stored) && now - stored < NOTIFICATION_DEDUPE_TTL_MS) {
        notificationClaims.set(key, stored);
        return false;
      }
      if (Number.isFinite(stored) && stored > 0) {
        window.localStorage.removeItem(storageKey);
      }
      window.localStorage.setItem(storageKey, String(now));
    }
  } catch {
    // Storage is best-effort; in-memory dedupe still covers duplicate streams in this tab.
  }

  notificationClaims.set(key, now);
  return true;
};

const getNotificationRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  let existing: ServiceWorkerRegistration | null = null;
  try {
    existing = (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    existing = null;
  }

  if (existing?.active) {
    return existing;
  }

  if (!existing) {
    return null;
  }

  try {
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS);
      }),
    ]);

    return ready ?? existing;
  } catch {
    return existing;
  }
};

const getNotificationData = (payload?: NotificationPayload): Record<string, string> | undefined => {
  const sessionId = payload?.sessionId?.trim();
  if (!sessionId) return undefined;
  const directory = payload?.directory?.trim();
  const search = new URLSearchParams({ session: sessionId });
  if (directory) search.set('directory', directory);

  return {
    url: `/?${search.toString()}`,
    sessionId,
    ...(directory ? { directory } : {}),
    ...(payload?.kind ? { type: payload.kind } : {}),
  };
};

const notifyWithServiceWorker = async (payload?: NotificationPayload): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || typeof registration.showNotification !== 'function') {
    return false;
  }

  try {
    await registration.showNotification(payload?.title ?? 'OpenChamber', {
      body: payload?.body,
      tag: payload?.tag,
      data: getNotificationData(payload),
    });
    return true;
  } catch (error) {
    console.warn('Failed to send notification via service worker', error);
    return false;
  }
};

const hasConfirmedActivePushSubscription = async (): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || !('pushManager' in registration) || !registration.pushManager) {
    return false;
  }

  try {
    const subscription = await registration.pushManager.getSubscription();
    return Boolean(subscription && isBrowserPushRegistrationConfirmed(subscription.endpoint));
  } catch {
    return false;
  }
};

const notifyWithWebAPI = async (payload?: NotificationPayload): Promise<boolean> => {
  if (payload?.requireHidden && typeof document !== 'undefined' && document.hasFocus()) {
    return true;
  }

  if (typeof Notification === 'undefined') {
    console.info('Notifications not supported in this environment', payload);
    return false;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted');
      return false;
    }
  }

  if (Notification.permission !== 'granted') {
    console.warn('Notification permission not granted');
    return false;
  }

  // Background push is the delivery channel only after the active runtime has
  // acknowledged this browser subscription. A local-only or failed registration
  // must keep SSE-driven local delivery eligible instead of dropping the event.
  if (!isClientFocused() && await hasConfirmedActivePushSubscription()) {
    return true;
  }

  if (!claimNotificationPayload(payload)) {
    return true;
  }

  try {
    // Some installed PWAs expose Notification.permission but only allow
    // notifications through an active service worker registration.
    if (await notifyWithServiceWorker(payload)) {
      return true;
    }

    const notification = new Notification(payload?.title ?? 'OpenChamber', {
      body: payload?.body,
      tag: payload?.tag,
    });
    const targetUrl = getNotificationData(payload)?.url;
    notification.onclick = () => {
      notification.close();
      if (typeof window === 'undefined') return;
      try {
        window.focus();
      } catch {
        // Focus is best-effort; navigation can still recover the target.
      }
      if (targetUrl) {
        try {
          window.location.assign(targetUrl);
        } catch {
          // The notification remains informational if the page can no longer navigate.
        }
      }
    };
    return true;
  } catch (error) {
    console.warn('Failed to send notification', error);
    return false;
  }
};

const notifyWithDesktop = async (payload?: NotificationPayload): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
  if (!desktop?.invoke) {
    return false;
  }

  try {
    await desktop.invoke('desktop_notify', {
      payload: {
        title: payload?.title,
        body: payload?.body,
        tag: payload?.tag,
        kind: payload?.kind,
        sessionId: payload?.sessionId,
        directory: payload?.directory,
        requireHidden: payload?.requireHidden,
      },
    });
    return true;
  } catch (error) {
    console.warn('Failed to send native notification (desktop)', error);
    return false;
  }
};

export const createWebNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    return (await notifyWithDesktop(payload)) || (await notifyWithWebAPI(payload));
  },
  canNotify: () => {
    if (typeof window !== 'undefined') {
      const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
      if (desktop?.invoke) {
        return true;
      }
    }
    return typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false;
  },
});
type DesktopBridgeGlobal = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};
