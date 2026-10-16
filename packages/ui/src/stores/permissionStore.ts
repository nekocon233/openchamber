import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import type { Session } from "@/lib/opencode/model";
import {
    permissionPolicyWireSchema,
    policySnapshotFromWire,
    resolvePermissionMode,
    type PermissionMode,
    type PermissionModeMap,
    type PermissionPolicySnapshot,
} from "./utils/permissionAutoAccept";
import { getAllSyncSessionMap } from "@/sync/sync-refs";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { isVSCodeRuntime } from "@/lib/desktop";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import {
    clearPendingDraftPermissionPolicy,
    setPendingDraftPermissionPolicy,
    supersedePendingDraftPermissionPolicy,
    useSessionUIStore,
} from "@/sync/session-ui-store";
import { opencodeClient } from "@/lib/opencode/client";
import { getRuntimeKey } from "@/lib/runtime-switch";

interface PermissionStore {
    modes: PermissionModeMap;
    /** What the authority answers for a session outside the policy. */
    defaultEnabled: boolean;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    legacyCandidate: Record<string, boolean> | null;
    legacyRuntimeKey: string | null;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: PermissionPolicySnapshot, expectedRuntimeKey?: string) => void;
    reset: () => void;
    getSessionMode: (sessionId: string) => PermissionMode;
    setSessionMode: (
        sessionId: string,
        mode: PermissionMode,
        options?: { preservePendingDraftIntent?: boolean },
    ) => Promise<void>;
}

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const parsed = permissionPolicyWireSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid permission auto-accept response");
    return policySnapshotFromWire(parsed.data);
};

const requestSnapshot = async (path: string, init?: RequestInit) => readSnapshot(await runtimeFetch(path, init));

// `enabled` rides along for servers from before the modes and for VS Code's
// bridge, which know only on/off.
const putSessionMode = (sessionId: string, mode: PermissionMode, directory?: string) => requestSnapshot(
    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
    {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled: mode !== "ask", directory }),
    },
);

const modeOf = (
    modes: PermissionModeMap,
    defaultEnabled: boolean,
    sessionById: ReadonlyMap<string, Session>,
    sessionId: string,
) => resolvePermissionMode({
    modes,
    sessions: [],
    sessionById,
    sessionID: sessionId,
    fallback: defaultEnabled ? "auto" : "ask",
});

type PermissionOperation = { generation: number; runtimeKey: string; sequence: number };
let generation = 0;
let operationSequence = 0;
let latestStartedSequence = 0;
const pendingSavingOperations = new Set<number>();
const sessionPolicyMutationQueues = new Map<string, Promise<void>>();
const latestExplicitPolicyOperation = new Map<string, number>();

const sessionPolicyOperationKey = (operation: PermissionOperation, sessionId: string): string => (
    `${operation.generation}\n${operation.runtimeKey}\n${sessionId}`
);

const enqueueSessionPolicyMutation = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = sessionPolicyMutationQueues.get(key);
    const result = previous ? previous.catch(() => undefined).then(run) : run();
    const tail = result.then(() => undefined, () => undefined);
    sessionPolicyMutationQueues.set(key, tail);
    return result.finally(() => {
        if (sessionPolicyMutationQueues.get(key) === tail) sessionPolicyMutationQueues.delete(key);
    });
};

const beginOperation = (): PermissionOperation => {
    const operation = { generation, runtimeKey: getRuntimeKey(), sequence: ++operationSequence };
    latestStartedSequence = operation.sequence;
    return operation;
};

const isCurrentOperation = (operation: PermissionOperation) => (
    operation.generation === generation && operation.runtimeKey === getRuntimeKey()
);

const legacySessionsSchema = z.record(z.string().min(1), z.boolean());

/** Version 1 kept the policy itself in localStorage as an on/off map. */
const persistedV1Schema = z.object({
    autoAccept: legacySessionsSchema.catch({}).default({}),
}).catch({ autoAccept: {} });

/** Version 2 keeps only a not-yet-migrated version 1 policy. */
const persistedV2Schema = z.object({
    legacyCandidate: legacySessionsSchema.nullable().catch(null).default(null),
    legacyRuntimeKey: z.string().nullable().catch(null).default(null),
}).catch({ legacyCandidate: null, legacyRuntimeKey: null });

export const usePermissionStore = create<PermissionStore>()(persist((set, get) => ({
    modes: {},
    defaultEnabled: false,
    loaded: false,
    saving: false,
    lastAppliedRevision: -1,
    legacyCandidate: null,
    legacyRuntimeKey: null,

    hydrate: async () => {
        const operation = beginOperation();
        const legacyCandidate = get().legacyCandidate;
        let legacyRuntimeKey = get().legacyRuntimeKey;
        if (legacyCandidate && !legacyRuntimeKey) {
            legacyRuntimeKey = operation.runtimeKey;
            set({ legacyRuntimeKey });
        }
        let snapshot = await requestSnapshot("/api/permission-auto-accept");
        if (!isCurrentOperation(operation)) return;
        const legacyEntries = legacyRuntimeKey === operation.runtimeKey
            ? Object.entries(legacyCandidate ?? {})
            : [];
        if (Object.keys(snapshot.modes).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId) continue;
                snapshot = await putSessionMode(sessionId, enabled ? "auto" : "ask");
                if (!isCurrentOperation(operation)) return;
            }
        }
        if (!isCurrentOperation(operation)) return;
        if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
        get().applySnapshot(snapshot, operation.runtimeKey);
        if (legacyRuntimeKey === operation.runtimeKey) {
            set({ legacyCandidate: null, legacyRuntimeKey: null });
        }
    },

    reset: () => {
        generation += 1;
        latestStartedSequence = 0;
        pendingSavingOperations.clear();
        set({ modes: {}, defaultEnabled: false, loaded: false, saving: false, lastAppliedRevision: -1 });
    },

    applySnapshot: (snapshot, expectedRuntimeKey) => {
        if (expectedRuntimeKey && expectedRuntimeKey !== getRuntimeKey()) return;
        const { revision, defaultEnabled } = snapshot;
        const applied = { modes: snapshot.modes, defaultEnabled, loaded: true };
        set((state) => {
            if (revision === undefined) {
                return state.lastAppliedRevision >= 0 ? state : applied;
            }
            if (revision < state.lastAppliedRevision) return state;
            return { ...applied, lastAppliedRevision: revision };
        });
    },

    getSessionMode: (sessionId) => {
        if (!sessionId) return "ask";
        const { modes, defaultEnabled } = get();
        return modeOf(modes, defaultEnabled, getAllSyncSessionMap(), sessionId);
    },

    setSessionMode: (sessionId, mode, options) => {
        if (!sessionId) return Promise.resolve();
        const operation = beginOperation();
        const operationKey = sessionPolicyOperationKey(operation, sessionId);
        const preservePendingDraftIntent = options?.preservePendingDraftIntent === true;
        // A draft that opted out registers its intent before the request, so a
        // failed write still reaches the session the draft is about to create.
        const superseded = preservePendingDraftIntent
            ? null
            : supersedePendingDraftPermissionPolicy(sessionId, operation.runtimeKey);
        const pendingToken = !preservePendingDraftIntent && mode === "ask"
            ? setPendingDraftPermissionPolicy(sessionId, false, operation.runtimeKey)
            : null;
        if (!preservePendingDraftIntent) {
            latestExplicitPolicyOperation.set(operationKey, operation.sequence);
        }
        pendingSavingOperations.add(operation.sequence);
        set({ saving: true });
        return enqueueSessionPolicyMutation(operationKey, async () => {
            try {
                if (superseded) await superseded.catch(() => undefined);
                if (!isCurrentOperation(operation)) return;
                const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
                    ?? opencodeClient.getDirectory()
                    ?? undefined;
                const snapshot = await putSessionMode(sessionId, mode, directory);
                if (!isCurrentOperation(operation)) return;
                if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
                // A newer explicit choice already replaced this one; applying the
                // older answer here would undo it.
                if (
                    !preservePendingDraftIntent
                    && latestExplicitPolicyOperation.get(operationKey) !== operation.sequence
                ) return;
                get().applySnapshot(snapshot, operation.runtimeKey);
                if (!preservePendingDraftIntent) {
                    clearPendingDraftPermissionPolicy(
                        sessionId,
                        operation.runtimeKey,
                        pendingToken ?? undefined,
                    );
                }
                if (isCurrentOperation(operation) && isVSCodeRuntime() && mode !== "ask") {
                    const { reconcileVSCodePendingPermissions } = await import("@/sync/vscode-permission-auto-accept");
                    if (isCurrentOperation(operation)) {
                        void reconcileVSCodePendingPermissions(directory).catch(() => undefined);
                    }
                }
            } finally {
                if (
                    !preservePendingDraftIntent
                    && latestExplicitPolicyOperation.get(operationKey) === operation.sequence
                ) {
                    latestExplicitPolicyOperation.delete(operationKey);
                }
                if (isCurrentOperation(operation)) {
                    pendingSavingOperations.delete(operation.sequence);
                    set({ saving: pendingSavingOperations.size > 0 });
                }
            }
        });
    },

}), {
    name: "permission-store",
    storage: createDeferredSafeJSONStorage(),
    version: 2,
    migrate: (persisted, version) => {
        if (version < 2) {
            const legacyCandidate = persistedV1Schema.parse(persisted ?? {}).autoAccept;
            return {
                legacyCandidate: Object.keys(legacyCandidate).length > 0 ? legacyCandidate : null,
                legacyRuntimeKey: null,
            };
        }
        return persistedV2Schema.parse(persisted ?? {});
    },
    partialize: (state) => ({
        legacyCandidate: state.legacyCandidate,
        legacyRuntimeKey: state.legacyRuntimeKey,
    }),
}));
