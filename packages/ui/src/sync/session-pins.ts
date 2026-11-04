import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';

type PinTarget = { directory: string; sessionId: string };

export function toggleSessionPin(target: PinTarget): Promise<void> {
  useSessionPinnedStore.getState().toggle(target);
  return Promise.resolve();
}

export function setSessionPinList(target: PinTarget, pinned: boolean, _list: string | null): Promise<void> {
  const currentlyPinned = isSessionPinned(useSessionPinnedStore.getState().ids, target.directory, target.sessionId);
  if (currentlyPinned !== pinned) {
    useSessionPinnedStore.getState().toggle(target);
  }
  return Promise.resolve();
}
