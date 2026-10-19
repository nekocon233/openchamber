import { useCallback, useSyncExternalStore } from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** Explicit choices only: changing which plan is final never writes a default. */
export const createPlanExpansionState = (capacity = 4000) => {
    const choices = new Map<string, boolean>();
    const listeners = new Map<string, Set<() => void>>();
    const prune = () => {
        if (choices.size <= capacity) return;
        for (const key of choices.keys()) {
            if (!listeners.has(key)) choices.delete(key);
            if (choices.size <= capacity) break;
        }
    };
    return {
        read: (key: string) => choices.get(key),
        subscribe(key: string, listener: () => void) {
            const current = listeners.get(key) ?? new Set<() => void>();
            current.add(listener);
            listeners.set(key, current);
            return () => {
                current.delete(listener);
                if (!current.size) listeners.delete(key);
                prune();
            };
        },
        toggle(key: string, defaultExpanded: boolean) {
            const next = !(choices.get(key) ?? defaultExpanded);
            choices.delete(key);
            choices.set(key, next);
            for (const listener of listeners.get(key) ?? []) listener();
            prune();
        },
    };
};

const state = createPlanExpansionState();

export const usePlanExpansion = (sessionID: string, messageID: string, callID: string, defaultExpanded: boolean) => {
    const key = JSON.stringify([getRuntimeKey(), sessionID, messageID, callID]);
    const subscribe = useCallback((listener: () => void) => state.subscribe(key, listener), [key]);
    const snapshot = useCallback(() => state.read(key), [key]);
    const choice = useSyncExternalStore(subscribe, snapshot, snapshot);
    const toggle = useCallback(() => state.toggle(key, defaultExpanded), [key, defaultExpanded]);
    return { expanded: choice ?? defaultExpanded, toggle };
};
