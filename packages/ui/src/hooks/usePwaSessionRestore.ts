import { useEffect, useRef, useState } from 'react';
import { hasRouteParams } from '@/lib/router';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isPwaSessionSelectionEnabled, readPwaSessionSelection } from '@/sync/pwa-session-selection';
import { isSessionAdmitted } from '@/sync/session-admission';
import { getAdmissionNavigationRevision, useSessionUIStore } from '@/sync/session-ui-store';

const listenForNavigationInput = (cancel: () => void, signal: AbortSignal) => {
  for (const event of ['pointerdown', 'keydown', 'beforeinput', 'popstate']) {
    window.addEventListener(event, cancel, { capture: true, once: true, signal });
  }
};

export const usePwaSessionRestore = (
  ready: boolean,
  canNavigate: () => boolean,
  selectSession: (sessionId: string, directory: string) => void,
): void => {
  // Capture the launch URL before the router starts writing the local selection to it.
  const [launch] = useState(() => {
    if (!isPwaSessionSelectionEnabled()) return null;
    return {
      hasExplicitRoute: hasRouteParams(),
      navigationRevision: getAdmissionNavigationRevision(),
      isCurrentRuntime: captureRuntimeInstance(),
    };
  });
  const launchChecked = useRef(launch?.hasExplicitRoute === true);
  const foregroundWhileStarting = useRef(false);

  useEffect(() => {
    if (ready || !launch) return;
    const startup = new AbortController();
    if (!launchChecked.current) {
      listenForNavigationInput(() => { launchChecked.current = true; }, startup.signal);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') foregroundWhileStarting.current = true;
    }, { signal: startup.signal });
    return () => startup.abort();
  }, [ready, launch]);

  useEffect(() => {
    if (!ready || !launch) return;
    const lifetime = new AbortController();
    let pending: AbortController | undefined;

    const check = () => {
      pending?.abort();
      if (document.visibilityState !== 'visible' || !canNavigate()) return;
      const initial = !launchChecked.current;
      const revision = getAdmissionNavigationRevision();
      launchChecked.current = true;
      if (initial ? revision !== launch.navigationRevision || !launch.isCurrentRuntime()
        : useSessionUIStore.getState().newSessionDraft.open) return;

      const controller = new AbortController();
      pending = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]);
      const cancel = () => controller.abort();
      listenForNavigationInput(cancel, signal);
      const isCurrentRuntime = captureRuntimeInstance();
      const stillCurrent = () => !signal.aborted && isCurrentRuntime() && canNavigate()
        && getAdmissionNavigationRevision() === revision;

      void (async () => {
        const id = await readPwaSessionSelection(signal);
        if (!id || !stillCurrent() || useSessionUIStore.getState().currentSessionId === id) return;

        await ensureGlobalSessionsLoaded();
        if (!stillCurrent()) return;
        let sessions = useGlobalSessionsStore.getState();
        // A device in the background may have missed the creation of a new session.
        if (!initial && sessions.hasLoaded && !sessions.entityById.has(id)) {
          if (!await sessions.refreshSessionHead() || !stillCurrent()) return;
          sessions = useGlobalSessionsStore.getState();
        }
        if (!sessions.hasLoaded || sessions.status === 'error') return;
        const session = sessions.entityById.get(id);
        if (!session || session.time.archived) return;
        const directory = resolveGlobalSessionDirectory(session);
        if (directory && isSessionAdmitted(directory)) selectSession(id, directory);
      })().catch(() => {
        // This is optional continuity. A failed read leaves the local selection in place.
      }).finally(cancel);
    };

    document.addEventListener('visibilitychange', check, { signal: lifetime.signal });
    if (!launchChecked.current || foregroundWhileStarting.current) {
      queueMicrotask(() => {
        if (lifetime.signal.aborted) return;
        foregroundWhileStarting.current = false;
        check();
      });
    }
    return () => {
      lifetime.abort();
      pending?.abort();
    };
  }, [ready, launch, canNavigate, selectSession]);
};
