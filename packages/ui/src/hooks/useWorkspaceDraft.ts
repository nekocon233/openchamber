import React from 'react';
import { useWorkspaceDraftStore } from '@/stores/useWorkspaceDraftStore';

/** Recovery does not restart an autosave. A new edit or explicit confirmation does. */
export function useWorkspaceDraft(owner: string | null, latest = '', ready = true) {
  const stored = useWorkspaceDraftStore(state => owner ? state.drafts[owner] : undefined);
  const [local, setLocal] = React.useState(latest);
  const [editing, setEditing] = React.useState<string | null>(null);
  const resumed = owner !== null && editing === owner;
  const conflict = Boolean(stored && ready && !resumed && stored.base !== latest && stored.value !== latest);
  const value = owner ? stored?.value ?? latest : local;
  const setValue = React.useCallback((update: React.SetStateAction<string>) => {
    if (!owner) { setLocal(update); return; }
    const current = useWorkspaceDraftStore.getState().drafts[owner];
    const next = typeof update === 'function' ? update(current?.value ?? latest) : update;
    if (!conflict) setEditing(owner);
    useWorkspaceDraftStore.getState().write(owner, next, latest);
  }, [conflict, latest, owner]);
  const acknowledge = React.useCallback((saved: string) => {
    if (owner) useWorkspaceDraftStore.getState().acknowledge(owner, saved);
  }, [owner]);
  const useLatest = React.useCallback(() => {
    if (owner) useWorkspaceDraftStore.getState().discard(owner);
    setLocal(latest); setEditing(null);
  }, [latest, owner]);
  const resume = React.useCallback(() => {
    if (owner) {
      useWorkspaceDraftStore.getState().rebase(owner, latest);
      setEditing(owner);
    }
  }, [latest, owner]);
  // `latest` may be an optimistic projection. Only the owning save may
  // acknowledge text; clearing on equality here loses it on rollback.
  return { value, setValue, acknowledge, conflict, useLatest, resume, canSave: ready && (!owner || resumed), recovered: Boolean(stored && !resumed), dirty: Boolean(stored) };
}
