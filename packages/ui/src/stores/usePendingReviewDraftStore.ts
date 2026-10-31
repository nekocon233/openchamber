import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const attemptSchema = z.object({ signature: z.string().max(1_000_000), fingerprint: z.string().max(1_000_000), key: z.string().min(1) });
const persistedSchema = z.object({
  texts: z.record(z.string(), z.string().max(65536).catch('')).default({}),
  attempts: z.record(z.string(), z.array(attemptSchema).max(128).catch([])).default({}),
});
type Persisted = z.infer<typeof persistedSchema>;
interface PendingReviewDraftStore extends Persisted {
  busy: Record<string, boolean>;
  setText: (key: string, text: string) => boolean;
  clearText: (key: string) => void;
  begin: (key: string) => boolean;
  end: (key: string) => void;
  setAttempt: (key: string, attempt: z.infer<typeof attemptSchema>) => boolean;
  clearAttempt: (key: string, signature: string) => void;
}

/** Unsaved text and uncertain request keys survive reloads; GitHub owns saved comments. */
export const usePendingReviewDraftStore = create<PendingReviewDraftStore>()(persist((set, get) => ({
  texts: {}, attempts: {}, busy: {},
  setText: (key, text) => {
    const state = get();
    if (text === state.texts[key]) return true;
    const total = Object.values(state.texts).reduce((sum, value) => sum + value.length, 0) - (state.texts[key]?.length ?? 0) + text.length;
    if (text.length > 65536 || total > 1_000_000 || (!Object.hasOwn(state.texts, key) && Object.keys(state.texts).length >= 256)) return false;
    set({ texts: { ...state.texts, [key]: text } });
    return true;
  },
  clearText: key => set(state => {
    const texts = { ...state.texts }; delete texts[key]; return { texts };
  }),
  begin: key => {
    if (get().busy[key]) return false;
    set(state => ({ busy: { ...state.busy, [key]: true } }));
    return true;
  },
  end: key => set(state => {
    const busy = { ...state.busy }; delete busy[key]; return { busy };
  }),
  setAttempt: (key, attempt) => {
    const state = get();
    const existing = state.attempts[key] ?? [];
    if (existing.some(value => value.signature === attempt.signature)) return true;
    const all = Object.values(state.attempts).flat();
    if (all.length >= 128 || all.reduce((sum, value) => sum + value.fingerprint.length + value.signature.length, 0) + attempt.fingerprint.length + attempt.signature.length > 1_000_000) return false;
    set({ attempts: { ...state.attempts, [key]: [...existing, attempt] } });
    return true;
  },
  clearAttempt: (key, signature) => set(state => {
    const attempts = { ...state.attempts };
    const remaining = (attempts[key] ?? []).filter(value => value.signature !== signature);
    if (remaining.length) attempts[key] = remaining;
    else delete attempts[key];
    return { attempts };
  }),
}), {
  name: 'openchamber-pending-review-drafts', version: 1, storage: createDeferredSafeJSONStorage<Persisted>(),
  partialize: state => ({ texts: state.texts, attempts: state.attempts }),
  merge: (stored, current) => {
    const parsed = persistedSchema.safeParse(stored);
    return parsed.success ? { ...current, ...parsed.data } : current;
  },
}));
