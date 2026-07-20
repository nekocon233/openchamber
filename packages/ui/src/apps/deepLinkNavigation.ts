import React from 'react';

import { isCapacitorApp } from '@/lib/platform';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import {
  ensureGlobalSessionsLoaded,
  refreshGlobalSessions,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getPWADisplayMode } from '@/lib/pwa';

import {
  buildDeepLink,
  parseDeepLink,
  parseServiceWorkerNotificationClick,
  type DeepLinkIntent,
  type SessionsFilter,
  type ViewTarget,
} from './deepLinks';

/**
 * Navigation layer for {@link DeepLinkIntent}s — the only place that knows how to *apply* a
 * deep link. Producers (notification taps, widget `widgetURL`, Live Activities) feed intents
 * in via {@link useDeepLinkSource}; the surfaces that can satisfy them register imperative
 * handlers via {@link useDeepLinkHandlers}. Session/new-session navigation goes straight to
 * the session store (always available), so those resolve even before the shell has mounted.
 *
 * Intents that arrive before the app is ready (cold launch from a tap/widget) or before their
 * handler is registered are stashed in a module-level holder that survives the connect flow
 * and SyncProvider remount, then applied as soon as the app becomes ready / the handler
 * appears. Only the most recent intent is kept (newest wins) — a burst of taps shouldn't queue.
 */

export interface DeepLinkHandlers {
  /** Close shell-local surfaces that would obscure a newly selected session. */
  prepareForSession?: () => void;
  /** Open the sessions sheet, optionally pre-filtered (filter support is best-effort for now). */
  openSessions?: (filter?: SessionsFilter) => void;
  /** Open a non-session surface (files / mcp / instances / update). */
  openView?: (target: ViewTarget) => void;
  /** Open the Changes surface, optionally jumping straight to a file diff. */
  openChanges?: (options?: { path?: string; staged?: boolean }) => void;
  /** Open Settings, optionally at a specific section. */
  openSettings?: (section?: string) => void;
}

let handlers: DeepLinkHandlers = {};
let ready = false;
type PendingDeepLink = {
  intent: DeepLinkIntent;
  prepareSession: boolean;
};

let pending: PendingDeepLink | null = null;
let intentRevision = 0;
let resolvingSessionRevision: number | null = null;
let unsubscribePendingSession: (() => void) | null = null;

const stopPendingSessionWatch = (): void => {
  const unsubscribe = unsubscribePendingSession;
  unsubscribePendingSession = null;
  unsubscribe?.();
};

const watchForPendingSession = (
  navigation: PendingDeepLink,
  revision: number,
  runtimeKey: string,
): void => {
  stopPendingSessionWatch();
  const tryResolve = (state: ReturnType<typeof useGlobalSessionsStore.getState>): boolean => {
    if (revision !== intentRevision || runtimeKey !== getRuntimeKey()) {
      stopPendingSessionWatch();
      return true;
    }
    const sessionIntent = navigation.intent;
    if (sessionIntent.type !== 'session') return true;
    const session = [...state.activeSessions, ...state.archivedSessions]
      .find((candidate) => candidate.id === sessionIntent.sessionId);
    const directory = session ? resolveGlobalSessionDirectory(session) : null;
    if (!directory) return false;

    pending = {
      ...navigation,
      intent: { ...sessionIntent, directory },
    };
    stopPendingSessionWatch();
    flush();
    return true;
  };

  if (tryResolve(useGlobalSessionsStore.getState())) return;
  unsubscribePendingSession = useGlobalSessionsStore.subscribe((state) => {
    tryResolve(state);
  });
};

const execute = ({ intent, prepareSession }: PendingDeepLink): boolean => {
  switch (intent.type) {
    case 'session':
      {
        const revision = intentRevision;
        const runtimeKey = getRuntimeKey();
        const store = useSessionUIStore.getState();
        const isProvisionalCurrentSession = store.restoredSessionPendingValidation
          && store.currentSessionId === intent.sessionId;
        const knownDirectory = intent.directory
          ?? (isProvisionalCurrentSession ? null : store.getDirectoryForSession(intent.sessionId));
        if (knownDirectory) {
          if (prepareSession) {
            handlers.prepareForSession?.();
            useUIStore.getState().setSettingsDialogOpen(false);
            useUIStore.getState().setActiveMainTab('chat');
          }
          void store.setCurrentSession(intent.sessionId, knownDirectory);
          return true;
        }
        if (resolvingSessionRevision !== revision) {
          stopPendingSessionWatch();
          resolvingSessionRevision = revision;
          void (async () => {
            try {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                if (attempt === 0) await ensureGlobalSessionsLoaded();
                else await refreshGlobalSessions();
                if (revision !== intentRevision || runtimeKey !== getRuntimeKey()) return;
                const currentStore = useSessionUIStore.getState();
                const globalState = useGlobalSessionsStore.getState();
                const globalSession = [...globalState.activeSessions, ...globalState.archivedSessions]
                  .find((session) => session.id === intent.sessionId);
                const isStillProvisional = currentStore.restoredSessionPendingValidation
                  && currentStore.currentSessionId === intent.sessionId;
                const directory = globalSession
                  ? resolveGlobalSessionDirectory(globalSession)
                  : isStillProvisional ? null : currentStore.getDirectoryForSession(intent.sessionId);
                if (directory) {
                  pending = {
                    intent: { ...intent, directory },
                    prepareSession,
                  };
                  flush();
                  return;
                }
                if (attempt < 2) {
                  await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                }
              }
              if (revision === intentRevision && runtimeKey === getRuntimeKey()) {
                watchForPendingSession({ intent, prepareSession }, revision, runtimeKey);
              }
            } finally {
              if (resolvingSessionRevision === revision) {
                resolvingSessionRevision = null;
              }
            }
          })();
        }
      }
      return false;

    case 'new-session': {
      const store = useSessionUIStore.getState();
      store.openNewSessionDraft();
      if (intent.directory || intent.projectId) {
        store.setNewSessionDraftTarget({
          directoryOverride: intent.directory ?? null,
          projectId: intent.projectId ?? null,
          selectedProjectId: intent.projectId ?? null,
        });
      }
      return true;
    }

    case 'sessions':
      if (!handlers.openSessions) return false;
      handlers.openSessions(intent.filter);
      return true;

    case 'status':
      // The session status panel is store-backed (useUIStore.mobileSessionPanelOpen),
      // so it opens without a shell handler — like session/new-session.
      useUIStore.getState().setMobileSessionPanelOpen(true);
      return true;

    case 'view':
      if (!handlers.openView) return false;
      handlers.openView(intent.target);
      return true;

    case 'changes':
      if (!handlers.openChanges) return false;
      handlers.openChanges({ path: intent.path, staged: intent.staged });
      return true;

    case 'settings':
      if (!handlers.openSettings) return false;
      handlers.openSettings(intent.section);
      return true;
  }
};

const flush = (): void => {
  if (!ready || !pending) return;
  const navigation = pending;
  // Drop the stash before executing; if the handler isn't registered yet, execute() returns
  // false and we re-stash so a later registerDeepLinkHandlers() flush can retry it.
  pending = null;
  if (!execute(navigation)) {
    pending = navigation;
  }
};

/** Apply an intent now if possible, otherwise stash it until the app is ready / a handler appears. */
export const applyDeepLinkIntent = (
  intent: DeepLinkIntent,
  options: { prepareSession?: boolean } = {},
): void => {
  intentRevision += 1;
  stopPendingSessionWatch();
  pending = { intent, prepareSession: options.prepareSession !== false };
  flush();
};

/** Convenience: parse a raw `openchamber://…` URL and apply it. No-op for unrecognised URLs. */
export const applyDeepLinkUrl = (raw: string | null | undefined): void => {
  const intent = parseDeepLink(raw);
  if (intent) {
    applyDeepLinkIntent(intent);
  }
};

const setReady = (value: boolean): void => {
  ready = value;
  flush();
};

/**
 * Register the surfaces that can satisfy shell-scoped intents (sessions/settings/views/changes).
 * Call from the component that owns those panels; the handlers are torn down on unmount.
 * Registering also flushes any pending intent that was waiting for these handlers.
 */
export const useDeepLinkHandlers = (next: DeepLinkHandlers): void => {
  React.useEffect(() => {
    handlers = next;
    flush();
    return () => {
      if (handlers === next) {
        handlers = {};
      }
    };
  }, [next]);
};

/**
 * Single native entry point for deep links. Subscribes to both the custom URL scheme
 * (`App.appUrlOpen` — widgets, Live Activities, external links) and notification taps
 * (`pushNotificationActionPerformed`), normalising each into a {@link DeepLinkIntent}.
 * Both listeners are registered UNCONDITIONALLY so a cold-launch tap/open isn't lost while
 * the app is still connecting; intents stash until `ready` (connected + initialized).
 */
export const useDeepLinkSource = (options: { ready: boolean }): void => {
  const { ready: isReady } = options;

  React.useEffect(() => {
    setReady(isReady);
    return () => setReady(false);
  }, [isReady]);

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        !event.data
        || typeof event.data !== 'object'
        || (event.data as { type?: unknown }).type !== 'openchamber:notification-click'
      ) {
        return;
      }
      const currentUrl = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
      const intent = parseServiceWorkerNotificationClick(event.data, currentUrl);
      if (intent) applyDeepLinkIntent(intent);
      const responsePort = event.ports?.[0];
      responsePort?.postMessage({
        type: 'openchamber:notification-click-ack',
        installed: getPWADisplayMode() !== 'browser',
      });
      responsePort?.close();
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);

  React.useEffect(() => {
    if (!isCapacitorApp()) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/app')
      .then(async ({ App }) => {
        if (disposed) return;
        const handle = await App.addListener('appUrlOpen', (event) => {
          applyDeepLinkUrl(event?.url);
        });
        if (disposed) {
          void handle.remove();
          return;
        }
        cleanup.push(() => void handle.remove());
      })
      .catch(() => undefined);

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = action?.notification?.data as Record<string, unknown> | undefined;
          // Prefer an explicit deep link in the payload (richest); fall back to a bare
          // sessionId for backwards compatibility with existing push senders.
          const url = typeof data?.url === 'string' ? data.url : typeof data?.deeplink === 'string' ? data.deeplink : undefined;
          if (url) {
            applyDeepLinkUrl(url);
            return;
          }
          const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
          if (sessionId) {
            const directory = typeof data?.directory === 'string' ? data.directory : undefined;
            applyDeepLinkIntent({ type: 'session', sessionId, directory });
          }
        });
        if (disposed) {
          void handle.remove();
          return;
        }
        cleanup.push(() => void handle.remove());
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, []);
};

// Re-export so producers (notifications, future widgets) have one import for the whole vocabulary.
export { buildDeepLink, parseDeepLink };
export type { DeepLinkIntent, SessionsFilter, ViewTarget };
