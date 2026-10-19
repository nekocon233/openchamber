import type { QuotaRefresh } from '@/types/quota';

interface ClaudeRefreshSnapshot {
  generation: number;
  enabled: boolean;
  fetching: boolean;
  refresh: QuotaRefresh | undefined;
}

/** A single deadline shared by all mounted quota consumers in this UI. */
export const startClaudeQuotaRefresh = ({
  read,
  subscribe,
  refresh,
  now = () => Date.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = timer => window.clearTimeout(timer),
}: {
  read: () => ClaudeRefreshSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<boolean>;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
}): (() => void) => {
  let timer: number | null = null;
  let generation = read().generation;
  let transportRetryAt = 0;
  let stopped = false;

  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (stopped) return;
    const snapshot = read();
    if (generation !== snapshot.generation) {
      generation = snapshot.generation;
      transportRetryAt = 0;
    }
    if (!snapshot.enabled || snapshot.fetching || !snapshot.refresh) return;
    const due = Math.max(snapshot.refresh.nextAttemptAt, transportRetryAt);
    timer = setTimer(() => {
      timer = null;
      // Browser timers may fire early after a clock adjustment, and long
      // provider cooldowns can exceed setTimeout's signed 32-bit range.
      if (now() < due) { schedule(); return; }
      const owner = generation;
      transportRetryAt = now() + 3 * 60_000;
      void refresh().catch(() => false).finally(() => {
        if (!stopped && read().generation === owner) schedule();
      });
    }, Math.min(2_147_483_647, Math.max(1, due - now())));
  };
  const unsubscribe = subscribe(schedule);
  schedule();
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) clearTimer(timer);
  };
};
