import { create } from 'zustand';
import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';

export const isAutoReviewAvailable = (): boolean => !isVSCodeRuntime();

const runSchema = z.object({
  originalSessionID: z.string().min(1),
  reviewSessionID: z.string().min(1),
  directory: z.string().min(1),
  status: z.enum(['running', 'clean', 'disputed', 'limit', 'failed', 'stopped', 'completed', 'error']),
  step: z.enum(['handoff', 'review', 'implement']).optional(),
  round: z.number().optional(),
  maxRounds: z.number().optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  error: z.string().optional(),
  dispute: z.string().optional(),
  runtimeKey: z.string().default(''),
  phase: z.enum(['waiting_for_reviewer', 'waiting_for_implementer']).optional(),
  iteration: z.number().default(0),
  maxIterations: z.number().default(0),
  lastForwardedMessageID: z.string().optional(),
  expectedAssistantParentID: z.string().optional(),
  waitAfterCreatedAt: z.number().optional(),
});

export type AutoReviewRun = z.infer<typeof runSchema>;

const snapshotSchema = z.object({ revision: z.number(), runs: z.array(runSchema) });
const mutationSchema = z.object({ revision: z.number(), run: runSchema.nullable() });
const errorBodySchema = z.object({ error: z.string() });

export const autoReviewUpdatedEventSchema = z.object({
  type: z.literal('openchamber:auto-review.updated'),
  properties: z.object({
    revision: z.number(),
    originalSessionID: z.string().min(1),
    directory: z.string().min(1),
    run: runSchema.nullable(),
    spaceId: z.string().optional(),
  }),
});

export type AutoReviewUpdatedEvent = z.infer<typeof autoReviewUpdatedEventSchema>;

type AutoReviewStartInput = {
  originalSessionID: string;
  reviewSessionID: string;
  directory: string;
  handoff?: { text: string; instructions: string };
  prompts: {
    reviewStart: string;
    reviewRules: string;
    feedbackToImplementer: string;
    responseToReviewer: string;
  };
};

const ownerOf = (directory: string | null | undefined): string => (directory ? spaceIdOfDirectory(directory) : null) ?? '';
const runKey = (owner: string, sessionID: string): string => `${owner}\n${sessionID}`;

const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RuntimeFetchOptions): Promise<T> => {
  const response = await runtimeFetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorBodySchema.safeParse(body).data?.error ?? `Auto-review request failed (${response.status})`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('Invalid auto-review response');
  return parsed.data;
};

const runPath = (originalSessionID: string) => `/api/auto-review/runs/${encodeURIComponent(originalSessionID)}`;

const appliedRevisions = new Map<string, number>();
const snapshotRevisions = new Map<string, number>();

interface AutoReviewState {
  runs: Record<string, AutoReviewRun>;
  runsByOriginalSessionID: Record<string, AutoReviewRun>;
  upsertRun: (run: AutoReviewRun) => void;
  updateRun: (originalSessionID: string, updater: (run: AutoReviewRun) => AutoReviewRun) => void;
  stopRun: (originalSessionID: string) => void;
  completeRun: (originalSessionID: string) => void;
  stopRunningRunsForRuntime: (runtimeKey: string) => void;
  isRunningForSession: (sessionID: string) => boolean;
  hydrate: () => Promise<void>;
  refreshSpace: (spaceId: string) => Promise<void>;
  applyUpdate: (update: AutoReviewUpdatedEvent['properties'], expectedRuntimeKey: string) => void;
  startRun: (input: AutoReviewStartInput) => Promise<void>;
  removeRun: (originalSessionID: string, directory: string) => Promise<void>;
  resetForRuntimeSwitch: () => void;
}

export const useAutoReviewStore = create<AutoReviewState>()((set, get) => {
  const applyRun = (owner: string, revision: number, originalSessionID: string, directory: string, run: AutoReviewRun | null) => {
    if (ownerOf(directory) !== owner) return;
    if (run && (run.originalSessionID !== originalSessionID || ownerOf(run.directory) !== owner)) return;
    if ((snapshotRevisions.get(owner) ?? -1) > revision) return;
    const key = runKey(owner, originalSessionID);
    if ((appliedRevisions.get(key) ?? -1) > revision) return;
    appliedRevisions.set(key, revision);
    set((state) => {
      const runs = { ...state.runs };
      const runsByOriginalSessionID = { ...state.runsByOriginalSessionID };
      if (run) {
        runs[key] = run;
        runsByOriginalSessionID[originalSessionID] = run;
      } else {
        delete runs[key];
        delete runsByOriginalSessionID[originalSessionID];
      }
      return { runs, runsByOriginalSessionID };
    });
  };

  const applySnapshot = (owner: string, snapshot: z.infer<typeof snapshotSchema>, runtimeKey: string) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if ((snapshotRevisions.get(owner) ?? -1) > snapshot.revision) return;
    snapshotRevisions.set(owner, snapshot.revision);
    const isNewer = (key: string) => (appliedRevisions.get(key) ?? -1) > snapshot.revision;
    set((state) => {
      const runs: Record<string, AutoReviewRun> = {};
      const runsByOriginalSessionID: Record<string, AutoReviewRun> = { ...state.runsByOriginalSessionID };
      for (const [key, run] of Object.entries(state.runs)) {
        if (ownerOf(run.directory) !== owner || isNewer(key)) runs[key] = run;
      }
      for (const run of snapshot.runs) {
        const key = runKey(owner, run.originalSessionID);
        if (ownerOf(run.directory) !== owner || isNewer(key)) continue;
        appliedRevisions.set(key, snapshot.revision);
        runs[key] = run;
        runsByOriginalSessionID[run.originalSessionID] = run;
      }
      return { runs, runsByOriginalSessionID };
    });
  };

  const readOwner = async (owner: string) => {
    if (!isAutoReviewAvailable()) return;
    const runtimeKey = getRuntimeKey();
    const snapshot = await requestJson(snapshotSchema, '/api/auto-review', {
      directory: owner ? `/spaces/${owner}` : null,
      signal: AbortSignal.timeout(15_000),
    });
    applySnapshot(owner, snapshot, runtimeKey);
  };

  return {
    runs: {},
    runsByOriginalSessionID: {},

    upsertRun: (run) => set((state) => ({
      runs: { ...state.runs, [runKey(ownerOf(run.directory), run.originalSessionID)]: run },
      runsByOriginalSessionID: { ...state.runsByOriginalSessionID, [run.originalSessionID]: run },
    })),

    updateRun: (originalSessionID, updater) => set((state) => {
      const current = state.runsByOriginalSessionID[originalSessionID];
      if (!current) return state;
      const updated = updater(current);
      return {
        runs: { ...state.runs, [runKey(ownerOf(updated.directory), originalSessionID)]: updated },
        runsByOriginalSessionID: { ...state.runsByOriginalSessionID, [originalSessionID]: updated },
      };
    }),

    stopRun: (originalSessionID) => set((state) => {
      const current = state.runsByOriginalSessionID[originalSessionID];
      if (!current) return state;
      const updated: AutoReviewRun = { ...current, status: 'stopped' };
      return {
        runs: { ...state.runs, [runKey(ownerOf(updated.directory), originalSessionID)]: updated },
        runsByOriginalSessionID: { ...state.runsByOriginalSessionID, [originalSessionID]: updated },
      };
    }),

    completeRun: (originalSessionID) => set((state) => {
      const current = state.runsByOriginalSessionID[originalSessionID];
      if (!current) return state;
      const updated: AutoReviewRun = { ...current, status: 'completed' };
      return {
        runs: { ...state.runs, [runKey(ownerOf(updated.directory), originalSessionID)]: updated },
        runsByOriginalSessionID: { ...state.runsByOriginalSessionID, [originalSessionID]: updated },
      };
    }),

    stopRunningRunsForRuntime: (runtimeKey) => set((state) => {
      const runsByOriginalSessionID = { ...state.runsByOriginalSessionID };
      const runs = { ...state.runs };
      for (const [id, run] of Object.entries(runsByOriginalSessionID)) {
        if (run.status === 'running' && (!run.runtimeKey || run.runtimeKey === runtimeKey)) {
          const stopped: AutoReviewRun = { ...run, status: 'stopped' };
          runsByOriginalSessionID[id] = stopped;
          runs[runKey(ownerOf(run.directory), id)] = stopped;
        }
      }
      return { runs, runsByOriginalSessionID };
    }),

    isRunningForSession: (sessionID) => {
      const state = get();
      for (const run of Object.values(state.runsByOriginalSessionID)) {
        if (run.status === 'running' && (run.originalSessionID === sessionID || run.reviewSessionID === sessionID)) {
          return true;
        }
      }
      for (const run of Object.values(state.runs)) {
        if (run.status === 'running' && (run.originalSessionID === sessionID || run.reviewSessionID === sessionID)) {
          return true;
        }
      }
      return false;
    },

    hydrate: () => readOwner(''),

    refreshSpace: async (spaceId) => {
      await readOwner(spaceId).catch(() => undefined);
    },

    applyUpdate: (update, expectedRuntimeKey) => {
      if (expectedRuntimeKey !== getRuntimeKey()) return;
      applyRun(update.spaceId ?? '', update.revision, update.originalSessionID, update.directory, update.run);
    },

    startRun: async (input) => {
      const runtimeKey = getRuntimeKey();
      const result = await requestJson(mutationSchema, '/api/auto-review/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        directory: input.directory,
      });
      if (runtimeKey !== getRuntimeKey()) return;
      applyRun(ownerOf(input.directory), result.revision, input.originalSessionID, input.directory, result.run);
    },

    removeRun: async (originalSessionID, directory) => {
      const runtimeKey = getRuntimeKey();
      const owner = ownerOf(directory);
      const key = runKey(owner, originalSessionID);
      const previous = get().runs[key];
      set((state) => {
        const runs = { ...state.runs };
        const runsByOriginalSessionID = { ...state.runsByOriginalSessionID };
        delete runs[key];
        delete runsByOriginalSessionID[originalSessionID];
        return { runs, runsByOriginalSessionID };
      });
      try {
        const result = await requestJson(mutationSchema, runPath(originalSessionID), { method: 'DELETE', directory });
        if (runtimeKey !== getRuntimeKey()) return;
        applyRun(owner, result.revision, originalSessionID, directory, result.run);
      } catch (error) {
        if (runtimeKey !== getRuntimeKey()) return;
        if (previous) {
          set((state) => ({
            runs: { ...state.runs, [key]: previous },
            runsByOriginalSessionID: { ...state.runsByOriginalSessionID, [originalSessionID]: previous },
          }));
        }
        await readOwner(owner).catch(() => undefined);
        throw error;
      }
    },

    resetForRuntimeSwitch: () => {
      appliedRevisions.clear();
      snapshotRevisions.clear();
      set({ runs: {}, runsByOriginalSessionID: {} });
    },
  };
});

export const selectAutoReviewRun = (sessionID: string | null | undefined, directory: string | null | undefined) => (
  (state: AutoReviewState): AutoReviewRun | null => (sessionID ? state.runs[runKey(ownerOf(directory), sessionID)] ?? state.runsByOriginalSessionID[sessionID] ?? null : null)
);

export const selectAutoReviewRunning = (sessionID: string | null | undefined, directory: string | null | undefined) => {
  const selectRun = selectAutoReviewRun(sessionID, directory);
  return (state: AutoReviewState): boolean => selectRun(state)?.status === 'running';
};

export const applyAutoReviewUpdatedEvent = (event: AutoReviewUpdatedEvent, expectedRuntimeKey: string): void => {
  if (!isAutoReviewAvailable()) return;
  useAutoReviewStore.getState().applyUpdate(event.properties, expectedRuntimeKey);
};
