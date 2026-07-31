import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./utils/permissionAutoAccept";
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

type PermissionPolicySnapshot = {
    sessions: PermissionAutoAcceptMap;
    defaultEnabled: boolean;
    revision?: number;
};

const normalizeRevision = (value: unknown): number | undefined => (
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
);

interface PermissionStore {
    autoAccept: PermissionAutoAcceptMap;
    defaultEnabled: boolean;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    legacyCandidate: PermissionAutoAcceptMap | null;
    legacyRuntimeKey: string | null;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: PermissionPolicySnapshot, expectedRuntimeKey?: string) => void;
    reset: () => void;
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (
        sessionId: string,
        enabled: boolean,
        options?: { preservePendingDraftIntent?: boolean },
    ) => Promise<void>;
}

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const payload = await response.json() as Partial<PermissionPolicySnapshot>;
    if (!payload.sessions || typeof payload.sessions !== "object") {
        throw new Error("Invalid permission auto-accept response");
    }
    const sessions: PermissionAutoAcceptMap = {};
    for (const [sessionId, enabled] of Object.entries(payload.sessions)) {
        if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
    }
    return {
        sessions,
        defaultEnabled: payload.defaultEnabled === true,
        revision: normalizeRevision(payload.revision),
    };
};

const requestSnapshot = async (path: string, init?: RequestInit) => readSnapshot(await runtimeFetch(path, init));

const isAutoAccepting = (
    autoAccept: PermissionAutoAcceptMap,
    defaultEnabled: boolean,
    sessionById: ReadonlyMap<string, Session>,
    sessionId: string,
) => autoRespondsPermission({ autoAccept, defaultEnabled, sessions: [], sessionById, sessionID: sessionId });

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

const normalizeSessions = (value: unknown): PermissionAutoAcceptMap => {
    const sessions: PermissionAutoAcceptMap = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return sessions;
    for (const [sessionId, enabled] of Object.entries(value)) {
        if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
    }
    return sessions;
};

export const usePermissionStore = create<PermissionStore>()(persist((set, get) => ({
    autoAccept: {},
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
        if (Object.keys(snapshot.sessions).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId || typeof enabled !== "boolean") continue;
                snapshot = await requestSnapshot(
                    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled }),
                    },
                );
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
        set({ autoAccept: {}, defaultEnabled: false, loaded: false, saving: false, lastAppliedRevision: -1 });
    },

    applySnapshot: (snapshot, expectedRuntimeKey) => {
        if (expectedRuntimeKey && expectedRuntimeKey !== getRuntimeKey()) return;
        const sessions = normalizeSessions(snapshot.sessions);
        const revision = normalizeRevision(snapshot.revision);
        set((state) => {
            if (revision === undefined && state.lastAppliedRevision >= 0) return state;
            if (revision !== undefined && revision < state.lastAppliedRevision) return state;
            return {
                autoAccept: sessions,
                defaultEnabled: snapshot.defaultEnabled === true,
                loaded: true,
                ...(revision !== undefined ? { lastAppliedRevision: revision } : {}),
            };
        });
    },

    isSessionAutoAccepting: (sessionId) => {
        if (!sessionId) return false;
        const { autoAccept, defaultEnabled, loaded } = get();
        if (!loaded) return false;
        return isAutoAccepting(autoAccept, defaultEnabled, getAllSyncSessionMap(), sessionId);
    },

    setSessionAutoAccept: (sessionId, enabled, options) => {
        if (!sessionId) return Promise.resolve();
        const operation = beginOperation();
        const operationKey = sessionPolicyOperationKey(operation, sessionId);
        const preservePendingDraftIntent = options?.preservePendingDraftIntent === true;
        const superseded = preservePendingDraftIntent
            ? null
            : supersedePendingDraftPermissionPolicy(sessionId, operation.runtimeKey);
        const pendingToken = !preservePendingDraftIntent && !enabled
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
                const snapshot = await requestSnapshot(
                    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled, directory }),
                    },
                );
                if (!isCurrentOperation(operation)) return;
                if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
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
                if (isCurrentOperation(operation) && isVSCodeRuntime() && enabled) {
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
        const state = persisted && typeof persisted === "object" ? persisted as Record<string, unknown> : {};
        if (version < 2) {
            const legacyCandidate = normalizeSessions(state.autoAccept);
            return {
                legacyCandidate: Object.keys(legacyCandidate).length > 0 ? legacyCandidate : null,
                legacyRuntimeKey: null,
            };
        }
        return state;
    },
    partialize: (state) => ({
        legacyCandidate: state.legacyCandidate,
        legacyRuntimeKey: state.legacyRuntimeKey,
    }),
}));
