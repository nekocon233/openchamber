import { create } from 'zustand';

import type { ComposerReference } from './composerReferences';

export type ComposerReferenceHandoff =
    | { kind: 'session'; sessionId: string }
    | { kind: 'draft'; workDraftId: string; runtimeKey: string }
    | { kind: 'any' };

type PendingComposerReferences = {
    pending: Array<{ references: ComposerReference[]; target: ComposerReferenceHandoff }>;
    references: ComposerReference[];
    push: (references: readonly ComposerReference[], target?: ComposerReferenceHandoff) => void;
    /** Takes the entries meant for this composer, and only those; the rest wait for theirs. */
    consume: (target?: ComposerReferenceHandoff) => ComposerReference[];
};

const sameComposerReferenceTarget = (a: ComposerReferenceHandoff, b: ComposerReferenceHandoff): boolean => {
    if (a.kind === 'any' || b.kind === 'any') return true;
    if (a.kind === 'session') return b.kind === 'session' && a.sessionId === b.sessionId;
    if (b.kind !== 'draft') return false;
    return a.workDraftId === b.workDraftId && a.runtimeKey === b.runtimeKey;
};

export const resolveComposerReferenceHandoffTarget = (input: {
    columnPinned: boolean;
    btwActive: boolean;
    currentSessionId: string | null;
    draftOpen: boolean;
    workDraftId: string | null;
    runtimeKey: string;
}): ComposerReferenceHandoff | null => {
    if (input.columnPinned || input.btwActive) return null;
    if (input.currentSessionId) return { kind: 'session', sessionId: input.currentSessionId };
    if (!input.draftOpen || !input.workDraftId) return null;
    return { kind: 'draft', workDraftId: input.workDraftId, runtimeKey: input.runtimeKey };
};

export const usePendingComposerReferences = create<PendingComposerReferences>()((set, get) => ({
    pending: [],
    references: [],
    push: (references, target = { kind: 'any' }) => {
        if (references.length === 0) return;
        set((state) => {
            const nextPending = [...state.pending, { references: [...references], target }];
            return {
                pending: nextPending,
                references: nextPending.flatMap((entry) => entry.references),
            };
        });
    },
    consume: (target = { kind: 'any' }) => {
        const { pending } = get();
        const taken = pending.filter((entry) => sameComposerReferenceTarget(entry.target, target));
        if (taken.length === 0) return [];
        const remaining = pending.filter((entry) => !sameComposerReferenceTarget(entry.target, target));
        set({
            pending: remaining,
            references: remaining.flatMap((entry) => entry.references),
        });
        return taken.flatMap((entry) => entry.references);
    },
}));
