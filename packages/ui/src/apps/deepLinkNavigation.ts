import React from 'react';
import { Capacitor } from '@capacitor/core';

import { isCapacitorApp } from '@/lib/platform';
import { subscribeToNativeShortcutRequests } from '@/lib/nativeShortcutRequests';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId } from '@/types';
import { useInputStore } from '@/sync/input-store';
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
import { persistSessionNavigation } from '@/sync/session-navigation';
import { requestMessageFocus } from '@/lib/router/messageFocus';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';

import {
  parseDeepLink,
  parseServiceWorkerNotificationClick,
  type DeepLinkIntent,
  type SessionsFilter,
  type ViewTarget,
} from './deepLinks';

interface DeepLinkHandlers {
  prepareForSession?: () => void;
  openSessions?: (filter?: SessionsFilter) => void;
  openView?: (target: ViewTarget) => void;
  openChanges?: (options?: { path?: string; staged?: boolean }) => void;
  openSettings?: (section?: string) => void;
}

type ShortcutNewSessionIntent = { type: 'shortcut-new-session'; projectId?: string; text?: string };

type NavigationIntent = DeepLinkIntent | ShortcutNewSessionIntent;

let handlers: DeepLinkHandlers = {};
let ready = false;
type PendingDeepLink = {
  intent: NavigationIntent;
  prepareSession: boolean;
};

let pending: PendingDeepLink | null = null;
let launchUrlConsumed = false;
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

const openShortcutSession = (intent: ShortcutNewSessionIntent): void => {
  const store = useSessionUIStore.getState();
  const project = intent.projectId
    ? useProjectsStore.getState().projects.find((entry) => entry.id === intent.projectId) ?? null
    : null;
  store.openNewSessionDraft(project ? { selectedProjectId: project.id } : undefined);
  const text = intent.text?.trim();
  if (!text) return;
  if (intent.projectId && !project) {
    useInputStore.getState().setPendingInputText(text, 'append');
    return;
  }
  useInputStore.getState().requestDraftSubmit(useSessionUIStore.getState().newSessionDraft.draftId, text);
};

const execute = ({ intent, prepareSession }: PendingDeepLink): boolean => {
  switch (intent.type) {
    case 'shortcut-new-session':
      openShortcutSession(intent);
      return true;

    case 'session':
      if (intent.messageId && !intent.directory) {
        void openSessionLink(intent.sessionId, intent.messageId);
        return true;
      }
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
          }
          if (intent.messageId) requestMessageFocus(intent.sessionId, intent.messageId);
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
      if (!handlers.openSessions) return false;
      handlers.openSessions();
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
      if (intent.section === 'usage' && intent.providerId) {
        // SAFETY: parseDeepLink admits only well-formed provider ids, and the widgets send ids
        // taken from the quota store's own results.
        useQuotaStore.getState().setSelectedProvider(intent.providerId as QuotaProviderId);
      }
      handlers.openSettings(intent.section);
      return true;
  }
};

const flush = (): void => {
  if (!pending) return;
  const canApplyWhileConnecting = pending.intent.type === 'session'
    && typeof pending.intent.directory === 'string'
    && pending.intent.directory.trim().length > 0;
  if (!ready && !canApplyWhileConnecting) return;
  const navigation = pending;
  pending = null;
  if (!execute(navigation)) {
    pending = navigation;
  }
};

export const applyDeepLinkIntent = (
  intent: NavigationIntent,
  options: { prepareSession?: boolean } = {},
): void => {
  intentRevision += 1;
  stopPendingSessionWatch();
  pending = { intent, prepareSession: options.prepareSession !== false };
  flush();
};

const applyDeepLinkUrl = (raw: string | null | undefined): void => {
  const intent = parseDeepLink(raw);
  if (intent) {
    applyDeepLinkIntent(intent);
  }
};

const setReady = (value: boolean): void => {
  ready = value;
  flush();
};

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
      const accepted = intent?.type === 'session';
      if (intent?.type === 'session') {
        // The installed-PWA launcher may reload this page immediately after the
        // acknowledgement, so persist the target before handing control back.
        persistSessionNavigation(intent.sessionId, intent.directory);
        applyDeepLinkIntent(intent);
      }
      const responsePort = event.ports?.[0];
      responsePort?.postMessage({
        type: 'openchamber:notification-click-ack',
        accepted,
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
        // external: https://capacitorjs.com/docs/apis/app#getlaunchurl Android cold-launch URLs require getLaunchUrl and are consumed once per process.
        if (!launchUrlConsumed && Capacitor.getPlatform() === 'android') {
          launchUrlConsumed = true;
          const initial = await App.getLaunchUrl().catch(() => null);
          if (!disposed && initial?.url) applyDeepLinkUrl(initial.url);
        }
      })
      .catch(() => undefined);

    cleanup.push(subscribeToNativeShortcutRequests((request) => {
      applyDeepLinkIntent({ type: 'shortcut-new-session', projectId: request.projectId, text: request.text });
    }));

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = action?.notification?.data as Record<string, unknown> | undefined;
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
