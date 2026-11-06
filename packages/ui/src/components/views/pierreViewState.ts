import { FileDiff, VirtualizedFileDiff, type FileDiffMetadata, type HunkExpansionRegion } from '@pierre/diffs';
import { readWorkspaceViewState, useWorkspaceViewStateStore } from '@/stores/useWorkspaceViewStateStore';
import { flushDeferredSafeStorage } from '@/stores/utils/safeStorage';

type Regions = [number, number, number][];

// Pierre exposes expansion through its protected renderer. Keep this adapter
// typed at that boundary instead of reaching into private fields from React.
export class PersistentFileDiff<T> extends FileDiff<T> {
  contextRegions() { return this.hunksRenderer.getExpandedHunksMap(); }
  restoreRegions(regions: Map<number, HunkExpansionRegion>) { this.hunksRenderer.setExpandedHunksMap(regions); }
}
export class PersistentVirtualizedFileDiff<T> extends VirtualizedFileDiff<T> {
  contextRegions() { return this.hunksRenderer.getExpandedHunksMap(); }
  restoreRegions(regions: Map<number, HunkExpansionRegion>) { this.hunksRenderer.setExpandedHunksMap(regions); }
}

type PersistentDiff<T> = PersistentFileDiff<T> | PersistentVirtualizedFileDiff<T>;

const fingerprint = async (data: FileDiffMetadata): Promise<string> => {
  const hunks = data.hunks.map(hunk => [hunk.additionStart, hunk.additionCount, hunk.deletionStart, hunk.deletionCount]);
  if (data.prevObjectId && data.newObjectId && !/^0+$/.test(data.prevObjectId) && !/^0+$/.test(data.newObjectId)) {
    return JSON.stringify([data.prevObjectId, data.newObjectId, data.isPartial, hunks]);
  }
  const bytes = new TextEncoder().encode(JSON.stringify([data.deletionLines, data.additionLines, data.isPartial, hunks]));
  if (!globalThis.crypto?.subtle) {
    let a = 2166136261, b = 5381;
    for (const byte of bytes) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b, 33) ^ byte; }
    return `${bytes.length}:${a >>> 0}:${b >>> 0}`;
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

/** One visible diff owns its expansion and horizontal scroll, scoped to its exact contents. */
export const createPierreViewState = <T,>(owner: string) => {
  let closed = false;
  type RestoreState = { data: FileDiffMetadata; key: string | null; restored: boolean; matched: boolean; finished: Promise<boolean> };
  let current: RestoreState | null = null;
  let releaseScroll: (() => void) | null = null;
  let listeningTo: ShadowRoot | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { key: string; regions: Regions; horizontal: number } | null = null;

  const flush = () => {
    if (scrollTimer !== undefined) clearTimeout(scrollTimer);
    scrollTimer = undefined;
    const next = pending; pending = null;
    if (!next) return;
    useWorkspaceViewStateStore.getState().update('diffFile', owner, previous => {
      if (previous.fingerprint === next.key && previous.horizontal === next.horizontal
        && JSON.stringify(previous.regions) === JSON.stringify(next.regions)) return previous;
      if (!previous.fingerprint && !next.regions.length && next.horizontal === 0) return previous;
      return { ...previous, fingerprint: next.key, regions: next.regions, horizontal: next.horizontal };
    });
    flushDeferredSafeStorage();
  };
  const remember = (instance: PersistentDiff<T>) => {
    if (!current?.key || closed) return;
    pending = {
      key: current.key,
      regions: Array.from(instance.contextRegions(), ([index, region]): [number, number, number] => [index, region.fromStart, region.fromEnd])
        .filter(([, start, end]) => start > 0 || end > 0),
      horizontal: instance.getCodeScrollLeft(),
    };
  };
  const sync = (instance: PersistentDiff<T>) => {
    const state = current;
    if (!state?.key || closed || instance.fileDiff !== state.data) return;
    const saved = readWorkspaceViewState(useWorkspaceViewStateStore.getState(), 'diffFile', owner);
    if (!state.restored) {
      state.restored = true;
      if (saved.fingerprint === state.key) {
        state.matched = true;
        const maxLines = Math.max(state.data.additionLines.length, state.data.deletionLines.length);
        instance.restoreRegions(new Map(saved.regions.filter(([index]) => index <= state.data.hunks.length)
          .map(([index, fromStart, fromEnd]) => [index, { fromStart: Math.min(Math.floor(fromStart), maxLines), fromEnd: Math.min(Math.floor(fromEnd), maxLines) }])));
        instance.setCodeScrollLeft(saved.horizontal);
        instance.rerender();
        return;
      }
    }
    remember(instance); flush();
  };
  const hide = () => { if (document.visibilityState === 'hidden') flush(); };
  window.addEventListener('pagehide', flush, { capture: true });
  window.addEventListener('beforeunload', flush, { capture: true });
  document.addEventListener('visibilitychange', hide);
  document.addEventListener('freeze', flush);

  return {
    rendered: (node: HTMLElement, instance: FileDiff<T>) => {
      if (closed || !(instance instanceof PersistentFileDiff || instance instanceof PersistentVirtualizedFileDiff) || !instance.fileDiff) return;
      const data = instance.fileDiff;
      if (current?.data !== data) {
        flush();
        const next: RestoreState = { data, key: null, restored: false, matched: false, finished: Promise.resolve(false) };
        current = next;
        next.finished = fingerprint(data).then(key => {
          if (closed || current !== next) return false;
          next.key = key; sync(instance);
          return next.matched;
        }).catch(() => false);
      } else sync(instance);
      const shadow = node.shadowRoot ?? node.querySelector('diffs-container')?.shadowRoot ?? null;
      if (shadow && shadow !== listeningTo) {
        releaseScroll?.(); listeningTo = shadow;
        const scroll = () => {
          remember(instance);
          if (scrollTimer !== undefined) clearTimeout(scrollTimer);
          scrollTimer = setTimeout(flush, 150);
        };
        shadow.addEventListener('scroll', scroll, { capture: true, passive: true });
        releaseScroll = () => shadow.removeEventListener('scroll', scroll, { capture: true });
      }
    },
    whenRestored: (data: FileDiffMetadata) => current?.data === data ? current.finished : Promise.resolve(false),
    dispose: () => {
      flush(); closed = true; releaseScroll?.();
      window.removeEventListener('pagehide', flush, { capture: true });
      window.removeEventListener('beforeunload', flush, { capture: true });
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('freeze', flush);
    },
  };
};
