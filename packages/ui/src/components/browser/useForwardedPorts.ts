import React from 'react';

import {
  fetchPortForwardState,
  isPortForwardRelevant,
  startPortForward,
  stopPortForward,
  type ForwardedPort,
  type PortForwardState,
} from '@/lib/browser/portForward';

/**
 * Which host ports are currently published, and the controls to change that.
 *
 * Polled rather than assumed: a forward can be started from another client, or
 * dropped when the host template changes, and a stale list would offer to open
 * a URL that answers nothing. The interval matches dev-server discovery, since
 * the two are read side by side.
 */
const REFRESH_INTERVAL_MS = 2_000;

const IDLE: PortForwardState = { kind: 'unavailable' };

type ForwardedPorts = {
  readonly state: PortForwardState;
  /** Ports with a start or stop in flight, so rows can disable themselves. */
  readonly pending: ReadonlySet<number>;
  readonly isForwarded: (port: number) => boolean;
  /** Resolves to the forward, or null when it could not be started. */
  readonly start: (port: number) => Promise<ForwardedPort | null>;
  readonly stop: (port: number) => Promise<boolean>;
};

export const useForwardedPorts = ({
  enabled,
  onError,
}: {
  enabled: boolean;
  onError: (message: string) => void;
}): ForwardedPorts => {
  const [state, setState] = React.useState<PortForwardState>(IDLE);
  const [pending, setPending] = React.useState<ReadonlySet<number>>(() => new Set());

  // Read inside callbacks that must not be rebuilt when the handler identity
  // changes, which would restart the poll on every render of the caller.
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const next = await fetchPortForwardState(signal);
    if (!mountedRef.current || signal?.aborted) return;
    setState(next);
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const poll = () => {
      void refresh(controller.signal).finally(() => {
        if (controller.signal.aborted) return;
        timer = setTimeout(poll, REFRESH_INTERVAL_MS);
      });
    };
    poll();

    return () => {
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, refresh]);

  const markPending = React.useCallback((port: number, active: boolean) => {
    setPending((current) => {
      const next = new Set(current);
      if (active) next.add(port);
      else next.delete(port);
      return next;
    });
  }, []);

  const start = React.useCallback(async (port: number): Promise<ForwardedPort | null> => {
    markPending(port, true);
    try {
      const forward = await startPortForward(port);
      // Refreshed rather than merged locally: the server owns the list, and a
      // template change could have dropped other forwards in the meantime.
      await refresh();
      return forward;
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (mountedRef.current) markPending(port, false);
    }
  }, [markPending, refresh]);

  const stop = React.useCallback(async (port: number): Promise<boolean> => {
    markPending(port, true);
    try {
      await stopPortForward(port);
      await refresh();
      return true;
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (mountedRef.current) markPending(port, false);
    }
  }, [markPending, refresh]);

  const isForwarded = React.useCallback((port: number): boolean => (
    state.kind === 'ready' && state.forwards.some((entry) => entry.port === port)
  ), [state]);

  return { state, pending, isForwarded, start, stop };
};

/** Whether this client reaches host dev servers through a forward at all. */
export const useIsPortForwardRelevant = (): boolean => {
  // Captured once: it depends on the runtime endpoint, and a switch remounts
  // the panel that owns this.
  const [relevant] = React.useState(isPortForwardRelevant);
  return relevant;
};
