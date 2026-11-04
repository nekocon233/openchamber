import { create } from 'zustand';

import type { ComposerReference } from './composerReferences';

/** Where a flow outside the composer wants its chips to land. */
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

/**
 * Where this composer can take a handoff. A pinned column and an expanded
 * `/btw` panel are not the main draft: a chip attached there would be written
 * to an identity nothing renders, so the handoff waits for the main composer.
 */
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

/**
 * Issues and PRs a flow outside the composer hands to a draft: the source
 * board attaches to the current session, the New Worktree dialog to the draft
 * it created. The target is part of the handoff, so a chip can no longer be
 * consumed by whichever composer happens to render first.
 */
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
