import { useEffect, useRef, type RefObject } from 'react';
import type { FileDiff as PierreFileDiff, FileDiffMetadata } from '@pierre/diffs';
import { waitForDiffReady } from './diffDom';
import { resolveContextExpansionRequest } from './contextExpansion';
import type { ContextExpansionRequest, DiffAnnotation } from './types';

interface ContextExpansionInput {
  diffContainerRef: RefObject<HTMLDivElement | null>;
  diffInstanceRef: RefObject<PierreFileDiff<DiffAnnotation> | null>;
  requestTrailingExpansionRef: RefObject<() => void>;
  fileDiff: FileDiffMetadata | undefined;
  expandOnDemand: boolean;
  expandLoading: boolean;
  onExpandContextRequest: ((request: ContextExpansionRequest) => void) | undefined;
  pendingContextExpansion: ContextExpansionRequest | null;
  persistenceRef: { readonly current: { whenRestored(data: FileDiffMetadata): Promise<boolean> } | null };
}

export const useContextExpansion = ({
  diffContainerRef,
  diffInstanceRef,
  requestTrailingExpansionRef,
  fileDiff,
  expandOnDemand,
  expandLoading,
  onExpandContextRequest,
  pendingContextExpansion,
  persistenceRef,
}: ContextExpansionInput): void => {
  useEffect(() => {
    requestTrailingExpansionRef.current = () => {
      if (expandLoading) return;
      onExpandContextRequest?.({ gap: 'after-last-hunk' });
    };
  }, [expandLoading, onExpandContextRequest, requestTrailingExpansionRef]);

  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container) return;
    return waitForDiffReady(container, () => {
      const host = container.querySelector('diffs-container');
      if (!(host instanceof HTMLElement)) return;
      host.toggleAttribute('data-oc-expand-on-demand', expandOnDemand);
      host.toggleAttribute('data-oc-expand-loading', expandLoading);
    });
  }, [diffContainerRef, expandLoading, expandOnDemand, fileDiff]);

  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container || !expandOnDemand || expandLoading || !fileDiff || !onExpandContextRequest) return;

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const request = resolveContextExpansionRequest(event.composedPath(), fileDiff);
      if (!request) return;
      event.preventDefault();
      event.stopPropagation();
      onExpandContextRequest(request);
    };

    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [diffContainerRef, expandLoading, expandOnDemand, fileDiff, onExpandContextRequest]);

  const appliedContextExpansionRef = useRef<ContextExpansionRequest | null>(null);
  useEffect(() => {
    if (!pendingContextExpansion || !fileDiff || fileDiff.isPartial) return;
    if (appliedContextExpansionRef.current === pendingContextExpansion) return;
    const container = diffContainerRef.current;
    if (!container) return;

    let cancelled = false;
    const release = waitForDiffReady(container, () => {
      const instance = diffInstanceRef.current;
      if (!instance || instance.fileDiff !== fileDiff) return;
      if (appliedContextExpansionRef.current === pendingContextExpansion) return;
      void (async () => {
        // A restored region already includes the initial expansion request.
        // Waiting for its content check prevents expanding it twice on reload.
        const restored = await (persistenceRef.current?.whenRestored(fileDiff) ?? Promise.resolve(false));
        if (cancelled || diffInstanceRef.current !== instance || instance.fileDiff !== fileDiff
          || appliedContextExpansionRef.current === pendingContextExpansion) return;
        appliedContextExpansionRef.current = pendingContextExpansion;
        if (restored) return;
        if (pendingContextExpansion.gap === 'after-last-hunk') {
          instance.expandHunk(fileDiff.hunks.length, 'up');
          return;
        }
        const hunkIndex = fileDiff.hunks.findIndex((hunk) =>
          hunk.additionStart <= pendingContextExpansion.additionStart
          && pendingContextExpansion.additionStart < hunk.additionStart + Math.max(hunk.additionCount, 1));
        if (hunkIndex >= 0) instance.expandHunk(hunkIndex, pendingContextExpansion.direction);
      })();
    });
    return () => { cancelled = true; release(); };
  }, [diffContainerRef, diffInstanceRef, fileDiff, pendingContextExpansion, persistenceRef]);
};
