import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { workspaceRepositoryIdentity, workspaceViewKey } from './useWorkspaceViewStateStore';
import type { GitHubReference, SourceControlReadContext } from '@/lib/api/types';

export const workspaceReplyDraftKey = (runtimeKey: string, context: SourceControlReadContext,
  target: Pick<GitHubReference, 'kind' | 'number'> & { sourceRepo: { owner: string; repo: string } }) => {
  const owner = context.provider === 'github' ? target.sourceRepo.owner.toLowerCase() : target.sourceRepo.owner;
  const repo = context.provider === 'github' ? target.sourceRepo.repo.toLowerCase() : target.sourceRepo.repo;
  return workspaceViewKey(runtimeKey, context.directory, 'reply', workspaceRepositoryIdentity(context), target.kind, owner, repo, target.number);
};

const draftSchema = z.object({ base: z.string(), value: z.string(), submissionId: z.string().optional().catch(undefined) });
const pendingInputSchema = z.object({ id: z.string().min(1), value: z.string() });
export type PendingWorkspaceInput = z.infer<typeof pendingInputSchema>;
const pendingInputId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), part => part.toString(16)).join('-');
type WorkspaceInputDraft = z.infer<typeof draftSchema>;

interface WorkspaceDraftStore {
  drafts: Record<string, WorkspaceInputDraft>;
  pendingInputs: Record<string, PendingWorkspaceInput[]>;
  stageInput: (owner: string, value: string) => string;
  confirmInput: (owner: string, id: string) => void;
  restoreInput: (owner: string, id: string) => void;
  write: (owner: string, value: string, base: string) => void;
  acknowledge: (owner: string, savedValue: string) => void;
  discard: (owner: string) => void;
  rebase: (owner: string, base: string) => void;
}

const parseDrafts = (value: unknown): Record<string, WorkspaceInputDraft> => {
  const drafts: Record<string, WorkspaceInputDraft> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drafts;
  for (const [key, entry] of Object.entries(value)) {
    const parsed = draftSchema.safeParse(entry);
    if (key && parsed.success && parsed.data.value !== parsed.data.base) drafts[key] = parsed.data;
  }
  return drafts;
};

const parsePendingInputs = (value: unknown): Record<string, PendingWorkspaceInput[]> => {
  const result: Record<string, PendingWorkspaceInput[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [owner, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    const valid = entries.flatMap(entry => {
      const parsed = pendingInputSchema.safeParse(entry); return parsed.success ? [parsed.data] : [];
    });
    if (valid.length) result[owner] = valid;
  }
  return result;
};

/** Unconfirmed input stays local until its owning save acknowledges that exact text. */
export const useWorkspaceDraftStore = create<WorkspaceDraftStore>()(persist((set) => ({
  drafts: {},
  pendingInputs: {},
  stageInput: (owner, value) => {
    const id = pendingInputId();
    set(state => {
      const drafts = { ...state.drafts };
      if (drafts[owner]?.value === value) delete drafts[owner];
      return { drafts, pendingInputs: { ...state.pendingInputs, [owner]: [...(state.pendingInputs[owner] ?? []), { id, value }] } };
    });
    return id;
  },
  confirmInput: (owner, id) => set(state => {
    const queue = state.pendingInputs[owner] ?? [];
    const restored = state.drafts[owner]?.submissionId === id;
    if (!restored && !queue.some(input => input.id === id)) return state;
    const pendingInputs = { ...state.pendingInputs };
    const remaining = queue.filter(input => input.id !== id);
    if (remaining.length) pendingInputs[owner] = remaining; else delete pendingInputs[owner];
    const drafts = restored ? { ...state.drafts } : state.drafts;
    if (restored) delete drafts[owner];
    return { pendingInputs, drafts };
  }),
  restoreInput: (owner, id) => set(state => {
    const queue = state.pendingInputs[owner] ?? [];
    const input = queue.find(input => input.id === id);
    if (!input) return state;
    const remaining = queue.filter(input => input.id !== id);
    const current = state.drafts[owner];
    if (current?.value) remaining.push({ id: current.submissionId ?? pendingInputId(), value: current.value });
    const pendingInputs = { ...state.pendingInputs };
    if (remaining.length) pendingInputs[owner] = remaining; else delete pendingInputs[owner];
    return { pendingInputs, drafts: { ...state.drafts, [owner]: { base: '', value: input.value, submissionId: input.id } } };
  }),
  write: (owner, value, base) => set(state => {
    const previous = state.drafts[owner];
    const baseline = previous?.base ?? base;
    if (previous?.value === value) return state;
    const drafts = { ...state.drafts };
    if (value === baseline) delete drafts[owner];
    else drafts[owner] = { base: baseline, value };
    return { drafts };
  }),
  acknowledge: (owner, savedValue) => set(state => {
    const draft = state.drafts[owner];
    if (!draft) return state;
    const drafts = { ...state.drafts };
    if (draft.value === savedValue) delete drafts[owner];
    else drafts[owner] = { ...draft, base: savedValue };
    return { drafts };
  }),
  discard: owner => set(state => {
    if (!Object.hasOwn(state.drafts, owner)) return state;
    const drafts = { ...state.drafts }; delete drafts[owner]; return { drafts };
  }),
  rebase: (owner, base) => set(state => {
    const draft = state.drafts[owner];
    if (!draft || draft.base === base) return state;
    return { drafts: { ...state.drafts, [owner]: { ...draft, base } } };
  }),
}), {
  name: 'openchamber.workspace-input-drafts.v1',
  storage: createDeferredSafeJSONStorage(),
  partialize: state => ({ drafts: state.drafts, pendingInputs: state.pendingInputs }),
  merge: (saved: unknown, current) => saved && typeof saved === 'object' && 'drafts' in saved
    ? { ...current, drafts: parseDrafts(saved.drafts), pendingInputs: parsePendingInputs('pendingInputs' in saved ? saved.pendingInputs : undefined) } : current,
}));
