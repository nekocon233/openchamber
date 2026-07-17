/// <reference lib="webworker" />

// NOTE: keep the Workbox injection point so vite-plugin-pwa can build.
// We intentionally do not use Workbox runtime helpers here: iOS Safari can be
// fragile with more complex SW bundles. For push notifications we only need a
// minimal SW.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __precacheManifest = self.__WB_MANIFEST;

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  data?: {
    url?: string;
    sessionId?: string;
    type?: string;
  };
  icon?: string;
  badge?: string;
};

type NotificationData = {
  url?: string;
  sessionId?: string;
  type?: string;
};

const SESSION_TAG_PREFIXES = ['ready-', 'error-', 'question-', 'permission-', 'goal-'] as const;

const getNotificationSessionId = (data: NotificationData | null, tag: string): string | undefined => {
  const explicitSessionId = data?.sessionId?.trim();
  if (explicitSessionId) return explicitSessionId;

  const prefix = SESSION_TAG_PREFIXES.find((candidate) => tag.startsWith(candidate));
  if (!prefix) return undefined;

  const taggedSessionId = tag.slice(prefix.length).split(':', 1)[0]?.trim();
  return taggedSessionId || undefined;
};

const getNotificationTargetUrl = (data: NotificationData | null, tag: string): string | null => {
  const sessionId = getNotificationSessionId(data, tag);
  const rawUrl = data?.url?.trim() || (sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '');
  if (!rawUrl) return null;

  try {
    const target = new URL(rawUrl, self.location.origin);
    return target.origin === self.location.origin ? target.href : null;
  } catch {
    return null;
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const payload = (event.data?.json() ?? null) as PushPayload | null;
    if (!payload) {
      return;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused);
    if (hasVisibleClient) {
      return;
    }

    const title = payload.title || 'OpenChamber';
    const body = payload.body ?? '';
    const icon = payload.icon ?? '/apple-touch-icon-180x180.png';
    const badge = payload.badge ?? '/favicon-32.png';

    await self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? null) as NotificationData | null;
  const targetUrl = getNotificationTargetUrl(data, event.notification.tag ?? '');

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const orderedClients = [
      ...clients.filter((client) => client.focused),
      ...clients.filter((client) => !client.focused && client.visibilityState === 'visible'),
      ...clients.filter((client) => !client.focused && client.visibilityState !== 'visible'),
    ];

    for (const candidate of orderedClients) {
      let client = candidate;
      if (targetUrl) {
        try {
          client = await candidate.navigate(targetUrl) ?? candidate;
        } catch {
          // Uncontrolled clients may reject navigation but can still be focused.
        }
      }

      try {
        await client.focus();
        return;
      } catch {
        // The window may have closed after matchAll; try the next one.
      }
    }

    const fallbackUrl = targetUrl ?? new URL('/', self.location.origin).href;
    await self.clients.openWindow(fallbackUrl);
  })());
});
