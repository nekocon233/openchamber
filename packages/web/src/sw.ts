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
    directory?: string;
    type?: string;
  };
  icon?: string;
  badge?: string;
};

type NotificationData = {
  url?: string;
  sessionId?: string;
  directory?: string;
  type?: string;
};

type NotificationClickMessage = {
  type: 'openchamber:notification-click';
  url?: string;
  sessionId?: string;
  directory?: string;
};

type NotificationClickAck = {
  type: 'openchamber:notification-click-ack';
  installed?: boolean;
};

const SESSION_TAG_PREFIXES = ['ready-', 'error-', 'question-', 'permission-', 'goal-'] as const;
const NOTIFICATION_CLICK_ACK_TIMEOUT_MS = 300;

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
  const fallbackUrl = (() => {
    if (!sessionId) return '';
    const search = new URLSearchParams({ session: sessionId });
    if (data?.directory?.trim()) search.set('directory', data.directory.trim());
    return `/?${search.toString()}`;
  })();
  const rawUrl = data?.url?.trim() || fallbackUrl;
  if (!rawUrl) return null;

  try {
    const target = new URL(rawUrl, self.location.origin);
    if (target.origin !== self.location.origin) return null;
    if (sessionId) {
      const urlSessionId = target.searchParams.get('session')?.trim() ?? '';
      target.searchParams.set('session', sessionId);
      if (data?.directory?.trim()) {
        target.searchParams.set('directory', data.directory.trim());
      } else if (urlSessionId && urlSessionId !== sessionId) {
        target.searchParams.delete('directory');
      }
    }
    return target.href;
  } catch {
    return null;
  }
};

const postNotificationClickIntent = (
  client: WindowClient,
  message: NotificationClickMessage,
): Promise<NotificationClickAck | null> => new Promise((resolve) => {
  const channel = new MessageChannel();
  let settled = false;
  const finish = (acknowledgement: NotificationClickAck | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    channel.port1.onmessage = null;
    channel.port1.close();
    resolve(acknowledgement);
  };
  const timeout = setTimeout(() => finish(null), NOTIFICATION_CLICK_ACK_TIMEOUT_MS);
  channel.port1.onmessage = (event: MessageEvent<NotificationClickAck>) => {
    finish(event.data?.type === 'openchamber:notification-click-ack' ? event.data : null);
  };
  channel.port1.start();

  try {
    client.postMessage(message, [channel.port2]);
  } catch {
    finish(null);
  }
});

const focusWindowClient = async (client: WindowClient): Promise<boolean> => {
  try {
    return Boolean(await client.focus());
  } catch {
    return false;
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
    const hasFocusedTopLevelClient = clients.some((client) => (
      (client.frameType === undefined || client.frameType === 'top-level') && client.focused
    ));
    if (hasFocusedTopLevelClient) {
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
  const sessionId = getNotificationSessionId(data, event.notification.tag ?? '');
  const directory = data?.directory?.trim() || undefined;
  const targetUrl = getNotificationTargetUrl(data, event.notification.tag ?? '');

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const clients = allClients.filter((client) => client.frameType === undefined || client.frameType === 'top-level');
    const orderedClients = [
      ...clients.filter((client) => client.focused),
      ...clients.filter((client) => !client.focused && client.visibilityState === 'visible'),
      ...clients.filter((client) => !client.focused && client.visibilityState !== 'visible'),
    ];

    const fallbackUrl = targetUrl ?? new URL('/', self.location.origin).href;
    if (orderedClients.length === 0) {
      await self.clients.openWindow(fallbackUrl).catch(() => null);
      return;
    }

    // A targetless notification is informational. Reuse the existing app as-is;
    // posting an empty navigation intent or opening `/` can clear its selected
    // session when an installed PWA routes the launch into that same window.
    if (!sessionId) {
      for (const candidate of orderedClients) {
        if (await focusWindowClient(candidate)) return;
      }
      await self.clients.openWindow(fallbackUrl).catch(() => null);
      return;
    }

    const message: NotificationClickMessage = {
      type: 'openchamber:notification-click',
      ...(targetUrl ? { url: targetUrl } : {}),
      sessionId,
      ...(directory ? { directory } : {}),
    };

    for (const candidate of orderedClients) {
      if (typeof candidate.postMessage === 'function') {
        const acknowledgement = await postNotificationClickIntent(candidate, message);

        // Chromium grants one window-interaction allowance per notification click.
        // Installed PWAs use openWindow so Windows can route through the app launcher;
        // browser tabs use focus. Never chain both operations for one candidate.
        // Older app bundles acknowledged without an `installed` field. Prefer the
        // launcher-safe path for that upgrade window; only an explicit false is a
        // browser tab that should consume the allowance with focus().
        if (acknowledgement && acknowledgement.installed !== false) {
          await self.clients.openWindow(fallbackUrl).catch(() => null);
          return;
        }
        if (acknowledgement && await focusWindowClient(candidate)) return;
        if (!acknowledgement) {
          await self.clients.openWindow(fallbackUrl).catch(() => null);
          return;
        }
        continue;
      }

      if (targetUrl) {
        let navigatedClient: WindowClient | null = null;
        try {
          navigatedClient = await candidate.navigate(targetUrl);
        } catch {
          // Uncontrolled legacy clients may reject navigation.
        }
        if (navigatedClient && await focusWindowClient(navigatedClient)) return;
        await self.clients.openWindow(fallbackUrl).catch(() => null);
        return;
      }

      if (await focusWindowClient(candidate)) return;
    }

    await self.clients.openWindow(fallbackUrl).catch(() => null);
  })());
});
