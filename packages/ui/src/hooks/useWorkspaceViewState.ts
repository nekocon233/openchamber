import React from 'react';
import { flushDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { readWorkspaceViewState, useWorkspaceViewStateStore, WORKSPACE_VIEW_DEFAULTS, type WorkspaceViewKind, type WorkspaceViewStates } from '@/stores/useWorkspaceViewStateStore';

export const WorkspaceViewScope = React.createContext<string | null>(null);
export const WorkspaceViewVisible = React.createContext(true);
export const useWorkspaceChildKey = (...identity: (string | number | null)[]) => {
  const scope = React.useContext(WorkspaceViewScope);
  return scope ? JSON.stringify([scope, ...identity]) : null;
};

/** A leaf subscription, with React state for callers that have no persistent owner. */
export function useWorkspaceViewState<K extends WorkspaceViewKind, F extends keyof WorkspaceViewStates[K]>(
  kind: K, owner: string | null, field: F, initial?: WorkspaceViewStates[K][F] | (() => WorkspaceViewStates[K][F]),
): [WorkspaceViewStates[K][F], React.Dispatch<React.SetStateAction<WorkspaceViewStates[K][F]>>] {
  type Value = WorkspaceViewStates[K][F];
  const [local, setLocal] = React.useState<Value>(() => typeof initial === 'function' ? (initial as () => Value)() : initial === undefined ? WORKSPACE_VIEW_DEFAULTS[kind][field] : initial);
  const localRef = React.useRef(local);
  localRef.current = local;
  const stored = useWorkspaceViewStateStore(state => owner ? readWorkspaceViewState(state, kind, owner)[field] : undefined);
  const setValue = React.useCallback((update: React.SetStateAction<Value>) => {
    if (!owner) { setLocal(update); return; }
    useWorkspaceViewStateStore.getState().update(kind, owner, previous => {
      const oldValue = previous[field] === undefined ? localRef.current : previous[field];
      const value = typeof update === 'function' ? (update as (previous: Value) => Value)(oldValue) : update;
      return Object.is(value, oldValue) ? previous : { ...previous, [field]: value };
    });
  }, [field, kind, owner]);
  return [stored === undefined ? local : stored, setValue];
}

/** Sets are used by diff navigation; their durable representation is a string array. */
export function useWorkspacePathSet(owner: string | null, field: 'expandedFiles' | 'collapsedDirectories'): [Set<string>, React.Dispatch<React.SetStateAction<Set<string>>>] {
  const [paths, setPaths] = useWorkspaceViewState('changes', owner, field);
  const value = React.useMemo(() => new Set(paths), [paths]);
  const setValue = React.useCallback((update: React.SetStateAction<Set<string>>) => setPaths(previous => {
    const oldSet = new Set(previous);
    const next = typeof update === 'function' ? update(oldSet) : update;
    if (next === oldSet || (next.size === previous.length && previous.every(path => next.has(path)))) return previous;
    return Array.from(next);
  }), [setPaths]);
  return [value, setValue];
}

/** Writes scroll state on rest, hide and teardown; hydration never records a hidden zero. */
export function useWorkspaceScroll(
  ref: React.RefObject<HTMLElement | null>, owner: string | null, ready: boolean, visible = true, anchorAttribute?: string,
) {
  const scopeVisible = React.useContext(WorkspaceViewVisible);
  const cancelRestore = React.useRef<(() => void) | null>(null);
  const interaction = React.useRef({ owner, changed: false });
  if (interaction.current.owner !== owner || !visible || !scopeVisible) interaction.current = { owner, changed: false };
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !owner || !visible || !scopeVisible) return;
    const store = useWorkspaceViewStateStore.getState();
    const saved = readWorkspaceViewState(store, 'scroll', owner);
    let restoring = !interaction.current.changed && (saved.top !== 0 || saved.left !== 0 || saved.anchor !== null);
    let dirty = false;
    let position = { top: saved.top, left: saved.left };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const children = () => anchorAttribute ? Array.from(node.querySelectorAll<HTMLElement>(`[${anchorAttribute}]`)) : [];
    const restore = () => {
      if (!restoring || !ready) return;
      const anchor = saved.anchor && children().find(child => child.getAttribute(anchorAttribute!) === saved.anchor);
      node.scrollTop = anchor ? node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset : saved.top;
      node.scrollLeft = saved.left;
    };
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!dirty || restoring) return;
      dirty = false;
      const top = node.getBoundingClientRect().top;
      const rows = children();
      const anchor = node.clientHeight > 0 && Math.abs(node.scrollTop - position.top) < 1
        ? rows.find(child => child.getBoundingClientRect().bottom > top) : undefined;
      const snapshot = { top: Math.max(0, position.top), left: position.left,
        anchor: anchor?.getAttribute(anchorAttribute!) ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
      useWorkspaceViewStateStore.getState().update('scroll', owner, previous =>
        Object.entries(snapshot).every(([key, value]) => Reflect.get(previous, key) === value) ? previous : snapshot);
      flushDeferredSafeStorage();
    };
    const interact = () => { restoring = false; interaction.current.changed = true; };
    cancelRestore.current = interact;
    const scroll = () => {
      if (restoring) return;
      dirty = true;
      position = { top: node.scrollTop, left: node.scrollLeft };
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', scroll, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.addEventListener(event, interact, { passive: true });
    window.addEventListener('pagehide', flush, { capture: true });
    window.addEventListener('beforeunload', flush, { capture: true });
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('freeze', flush);
    return () => {
      flush(); observer.disconnect();
      if (cancelRestore.current === interact) cancelRestore.current = null;
      node.removeEventListener('scroll', scroll);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.removeEventListener(event, interact);
      window.removeEventListener('pagehide', flush, { capture: true });
      window.removeEventListener('beforeunload', flush, { capture: true });
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('freeze', flush);
    };
  }, [anchorAttribute, owner, ready, ref, scopeVisible, visible]);
  return React.useCallback(() => cancelRestore.current?.(), []);
}
