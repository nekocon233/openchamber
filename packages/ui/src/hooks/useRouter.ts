import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import { listenForNotificationNavigation } from '@/lib/router/notificationNavigation';
import { isSessionOpenRedirect, openSessionFromRoute, openSessionLink } from '@/lib/router/openSessionFromRoute';
import type { RouteState, AppRouteState } from '@/lib/router';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/**
 * Check if running in VS Code webview context.
 */
function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

export function getCurrentAppRouteState(): AppRouteState {
  const sessionState = useSessionUIStore.getState();
  const uiState = useUIStore.getState();

  return {
    sessionId: sessionState.currentSessionId,
    sessionDirectory: sessionState.currentSessionDirectory,
    isSettingsOpen: uiState.isSettingsDialogOpen,
    settingsPath: uiState.settingsPage,
  };
}

/**
 * Hook that provides bidirectional URL routing for OpenChamber.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop: Full bidirectional sync
 * - VS Code: State-only (no URL updates, reads initial params)
 */
export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const pendingRouteRef = React.useRef<{ route: RouteState; initial: boolean; normalize: boolean } | null>(null);

  // Get store actions (stable references)
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  const applyRouteState = React.useCallback(
    async (route: RouteState) => {
      // 1. Apply session first (may trigger async operations); a message
      // link also asks the session's timeline to show that message.
      if (route.sessionId) {
        if (route.messageId) {
          await openSessionLink(route.sessionId, route.messageId);
        } else {
          await openSessionFromRoute(route.sessionId, route.sessionDirectory);
        }
      }

      // 2. Handle settings first because it is a full-screen overlay.
      if (route.settingsPath) {
        setSettingsPage(resolveSettingsSlug(route.settingsPath));
        setSettingsDialogOpen(true);
        // Do not process a route view while settings is open.
        return;
      }

      // Close settings if URL has no settings section
      if (useUIStore.getState().isSettingsDialogOpen) {
        setSettingsDialogOpen(false);
      }

      // 3. Apply the view selected by the legacy URL parameter. Desktop
      // surfaces live in the context panel, so a non-chat tab deep link
      // opens the matching panel surface; activeSurface itself stays 'chat'
      // (nothing renders non-chat surfaces in the main area).
      if (route.tab && route.tab !== 'chat') {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (directory) {
          const mode: ContextPanelMode = route.tab === 'files' ? 'file' : route.tab;
          useUIStore.getState().openContextSurface(directory, mode);
        }
      }

      // 4. Apply diff file (only if going to diff tab)
      if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
        navigateToDiff(route.diffFile);
      }
    },
    [setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState, initial = false, normalize = true) => {
      pendingRouteRef.current = { route, initial, normalize };
      if (isApplyingRouteRef.current) {
        return;
      }

      isApplyingRouteRef.current = true;

      try {
        while (pendingRouteRef.current) {
          const request = pendingRouteRef.current;
          pendingRouteRef.current = null;
          await applyRouteState(request.route);
          if (!isVSCode && request.normalize && !request.route.messageId && !pendingRouteRef.current) {
            const state = getCurrentAppRouteState();
            const currentSessionState = useSessionUIStore.getState();
            const sessionId = state.sessionId ?? request.route.sessionId;
            const sessionDirectory = request.route.sessionDirectory
              ?? (currentSessionState.currentSessionId === sessionId
                ? currentSessionState.currentSessionDirectory
                : null);
            updateBrowserURL(request.initial ? {
              ...state,
              sessionId,
              sessionDirectory,
              settingsPath: request.route.settingsPath ?? state.settingsPath,
            } : state, { replace: true, force: request.initial });
          }
        }
      } finally {
        isApplyingRouteRef.current = false;
      }
    },
    [applyRouteState, isVSCode]
  );

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppRouteState();
      updateBrowserURL(state, options);
    },
    [isVSCode]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params. The launch may already have reopened the last
      // session (App selects it before this effect runs, so the session
      // subscription below never sees that change): name it in the URL
      // without adding a history entry.
      syncURLFromState({ replace: true });
      return;
    }

    const route = parseRoute();

    void applyRoute(route, true);
  }, [applyRoute, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) return;

    return listenForNotificationNavigation((target) => {
      if (isApplyingRouteRef.current) return false;
      const route = parseRoute(target.searchParams);
      window.history.pushState({}, '', target.href);
      void applyRoute(route, false, false).catch((error) => {
        console.error('[PWA] notification navigation failed:', error);
      });
      return true;
    });
  }, [applyRoute, isVSCode]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    const unsubscribe = useSessionUIStore.subscribe((state, previousState) => {
      const sessionChanged = state.currentSessionId !== previousState.currentSessionId;
      const directoryChanged = state.currentSessionDirectory !== previousState.currentSessionDirectory;

      // Skip if no change or if we're currently applying a route
      if ((!sessionChanged && !directoryChanged) || isApplyingRouteRef.current) {
        return;
      }

      syncURLFromState({ replace: !sessionChanged || isSessionOpenRedirect() });
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Subscribe to UI store changes (view, settings)
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;

      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;

      if (settingsOpenChanged || settingsPathChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const handlePopState = () => {
      // Parse the new URL and apply it
      const route = parseRoute();

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        void applyRoute(route);
      } else {
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode, setSettingsDialogOpen]);
}
