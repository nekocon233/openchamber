import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { getPinnedSessionKey, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { useSidebarStateStore } from '@/stores/useSidebarStateStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { forgetLegacyPins, getLegacyPins, setPendingPin, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { setSessionPinned } from './session-actions';

type PinTarget = { directory: string; sessionId: string };

const pinQueues = new Map<string, { tail: Promise<void>; count: number }>();

export function toggleSessionPin(target: PinTarget): Promise<void> {
  const key = getPinnedSessionKey(getRuntimeKey(), target.directory, target.sessionId);
  if (!key) return Promise.resolve();
  return writeSessionPin(key, target, !useSessionPinnedStore.getState().ids.has(key), null);
}

export function setSessionPinList(target: PinTarget, pinned: boolean, list: string | null): Promise<void> {
  const key = getPinnedSessionKey(getRuntimeKey(), target.directory, target.sessionId);
  if (!key) return Promise.resolve();
  return writeSessionPin(key, target, pinned, list);
}

async function retireSharedPin(runtimeKey: string, sessionId: string) {
  const sidebar = useSidebarStateStore.getState();
  if (sidebar.runtimeKey === runtimeKey && sidebar.snapshot?.pinnedSessionIds.includes(sessionId)) {
    await sidebar.mutate({ type: 'session.unpin', sessionId });
  }
}

function writeSessionPin(key: string, target: PinTarget, pinned: boolean, list: string | null): Promise<void> {
  const current = captureRuntimeInstance();
  const runtimeKey = getRuntimeKey();
  setPendingPin(key, pinned);

  const queue = pinQueues.get(key) ?? { tail: Promise.resolve(), count: 0 };
  queue.count += 1;
  pinQueues.set(key, queue);
  const run = queue.tail.then(async () => {
    try {
      if (!current()) return;
      const updated = await setSessionPinned(target.sessionId, target.directory, pinned, list);
      if (!updated || !current()) return;
      await retireSharedPin(runtimeKey, target.sessionId);
      forgetLegacyPins([key]);
    } finally {
      queue.count -= 1;
      if (queue.count === 0) {
        pinQueues.delete(key);
        setPendingPin(key, null);
      }
    }
  });
  queue.tail = run.catch(() => undefined);
  return run;
}

const migratingRuntimes = new Set<string>();

async function migrateLegacyPins(): Promise<void> {
  const state = useGlobalSessionsStore.getState();
  if (!state.hasLoaded || state.status !== 'ready') return;
  const runtimeKey = getRuntimeKey();
  const pins = getLegacyPins(runtimeKey);
  if (pins.length === 0 || migratingRuntimes.has(runtimeKey)) return;
  migratingRuntimes.add(runtimeKey);
  try {
    for (const pin of pins) {
      if (getRuntimeKey() !== runtimeKey) return;
      const session = useGlobalSessionsStore.getState().entityById.get(pin.sessionId);
      if (!session || pinQueues.has(pin.key)) continue;
      try {
        if (isSessionPinnedInMetadata(session)) {
          await retireSharedPin(runtimeKey, pin.sessionId);
          forgetLegacyPins([pin.key]);
        } else {
          await writeSessionPin(pin.key, { sessionId: pin.sessionId, directory: session.directory ?? pin.directory }, true, null);
        }
      } catch (error) {
        console.warn('[session-pins] could not move a local pin to the server', error);
      }
    }
  } finally {
    migratingRuntimes.delete(runtimeKey);
  }
}

useSidebarStateStore.subscribe((state, previous) => {
  if (state.baseSnapshot !== previous.baseSnapshot && state.baseSnapshot?.pinnedSessionIds.length) void migrateLegacyPins();
});

useGlobalSessionsStore.subscribe((state, previous) => {
  if (state.hasLoaded && state.status === 'ready' && (previous.status !== 'ready' || !previous.hasLoaded || state.activeSessions !== previous.activeSessions)) {
    void migrateLegacyPins();
  }
});
void migrateLegacyPins();
