import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type {
    FollowUpQueueAPI,
    FollowUpQueueAttachment,
    FollowUpQueueItem,
    FollowUpQueueMutationResult,
    FollowUpQueueOperation,
    FollowUpQueueSnapshot,
    FollowUpQueueStatus,
} from '@/lib/api/types';
import {
    FOLLOW_UP_QUEUE_CLAIM_TTL_MS,
    FollowUpQueueConflictError,
    FollowUpQueueRequestError,
    FollowUpQueueUnsupportedError,
    applyFollowUpQueueOperation,
    followUpQueueItemsEqual,
    parseFollowUpQueueItem,
    parseFollowUpQueueOperation,
    parseFollowUpQueueSnapshot,
} from '@/lib/followUpQueue';
import { createOpenCodeIdentifier } from '@/lib/opencode/identifier';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from './types/sessionTypes';
import { getSafeStorage } from './utils/safeStorage';

export type FollowUpBehavior = 'steer' | 'queue';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

export const normalizeFollowUpBehavior = (
    value: unknown,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    if (value === 'immediate') return 'steer';
    if (isFollowUpBehavior(value)) return value;
    if (legacyQueueModeEnabled === false) return 'steer';
    if (legacyQueueModeEnabled === true) return 'queue';
    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

export type QueuedMessageStatus = FollowUpQueueStatus;

export interface QueuedMessage extends Omit<FollowUpQueueItem, 'attachments'> {
    attachments?: AttachedFile[];
}

export type QueueClaimHandle = {
    claimId: string;
    item: QueuedMessage;
    context: MessageQueueRuntimeContext;
};

export type MessageQueueRuntimeContext = {
    runtimeKey: string;
    generation: number;
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    runtimeKey: string;
    generation: number;
    supported: boolean | null;
}

interface MessageQueueActions {
    initialize: () => Promise<void>;
    watchSession: (sessionId: string) => () => void;
    refreshSession: (sessionId: string) => Promise<void>;
    addToQueue: (
        sessionId: string,
        message: Omit<QueuedMessage, 'id' | 'messageId' | 'createdAt' | 'status' | 'claim'> & { status?: QueuedMessageStatus },
    ) => Promise<QueuedMessage>;
    removeFromQueue: (sessionId: string, messageId: string) => void;
    setQueuedStatus: (sessionId: string, messageId: string, status: QueuedMessageStatus) => void;
    reorderQueue: (sessionId: string, fromId: string, toId: string) => void;
    popToInput: (sessionId: string, messageId: string) => QueuedMessage | null;
    clearQueue: (sessionId: string) => void;
    clearAllQueues: () => void;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForSession: (sessionId: string) => QueuedMessage[];
    claim: (sessionId: string, itemId: string, mode: 'manual' | 'auto') => Promise<QueueClaimHandle | null>;
    complete: (sessionId: string, itemId: string, claimId: string, context?: MessageQueueRuntimeContext) => Promise<boolean>;
    release: (
        sessionId: string,
        itemId: string,
        claimId: string,
        status: QueuedMessageStatus,
        context?: MessageQueueRuntimeContext,
    ) => Promise<boolean>;
    handleRevisionHint: (
        scopeToken: string,
        revision: number,
        context?: MessageQueueRuntimeContext,
        reset?: boolean,
    ) => void;
    handleTransportReady: (context?: MessageQueueRuntimeContext) => void;
    dropSession: (sessionId: string, context?: MessageQueueRuntimeContext) => void;
    switchRuntime: (runtimeKey: string) => void;
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PendingOperation = {
    clientMutationId: string;
    operation: FollowUpQueueOperation;
    projectionNow: number;
    outboxOrder: number;
    claimExpiresAt?: number;
    orphaned: boolean;
    resolve?: (result: FollowUpQueueMutationResult) => void;
    reject?: (error: Error) => void;
};

type QueueLane = {
    runtimeKey: string;
    generation: number;
    sessionId: string;
    baseSnapshot: FollowUpQueueSnapshot | null;
    localItems: FollowUpQueueItem[];
    localRevision: number;
    legacyItemIds: string[];
    pending: PendingOperation[];
    embeddedPending: StoredQueueLane['pending'];
    hintedRevision: number;
    loadedForGeneration: boolean;
    loadInFlight: Promise<void> | null;
    drainInFlight: Promise<void> | null;
    retryDelayMs: number;
    cancelRetry: (() => void) | null;
    refreshScheduled: boolean;
    refreshQueued: boolean;
    resetHinted: boolean;
    visibleItems: FollowUpQueueItem[];
    visibleMessages: QueuedMessage[];
};

type StoredQueueLane = {
    version: 1;
    baseSnapshot: FollowUpQueueSnapshot | null;
    localItems: FollowUpQueueItem[];
    localRevision: number;
    legacyItemIds: string[];
    pending: Array<{
        clientMutationId: string;
        operation: FollowUpQueueOperation;
        projectionNow: number;
        claimExpiresAt?: number;
    }>;
};

type MessageQueueStoreDependencies = {
    getAPI: () => FollowUpQueueAPI | null;
    getRuntimeKey: () => string;
    storage: Storage;
    now: () => number;
    createItemId: () => string;
    createMessageId: () => string;
    createMutationId: () => string;
    createClaimId: () => string;
    verifyStorageWrite: (key: string, value: string) => boolean;
    runWithLocalLock: <T>(key: string, task: () => Promise<T> | T) => Promise<T>;
    hasCrossContextLocalLock: () => boolean;
    subscribeStorage: (listener: (key: string, newValue: string | null) => void) => () => void;
    schedule: (callback: () => void) => void;
    scheduleRetry: (callback: () => void, delayMs: number) => () => void;
};

const LANE_STORAGE_PREFIX = 'oc.followUpQueue.v1';
const OUTBOX_STORAGE_PREFIX = 'oc.followUpQueue.outbox.v1';
const SETTINGS_STORAGE_KEY = 'oc.followUpQueue.settings.v1';
const LEGACY_STORAGE_KEY = 'message-queue-store';
const LEGACY_OWNER_KEY = 'oc.followUpQueue.legacyOwner.v1';
const LOCAL_SCOPE_TOKEN = '0'.repeat(64);
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

const normalizeRuntimeKey = (value: string): string => value.trim() || 'default';
const laneStorageKey = (runtimeKey: string, sessionId: string): string => (
    `${LANE_STORAGE_PREFIX}:${encodeURIComponent(normalizeRuntimeKey(runtimeKey))}:${encodeURIComponent(sessionId)}`
);
const laneDeletionKey = (runtimeKey: string, sessionId: string): string => (
    `${laneStorageKey(runtimeKey, sessionId)}:deleted`
);
const outboxStoragePrefix = (runtimeKey: string, sessionId: string): string => (
    `${OUTBOX_STORAGE_PREFIX}:${encodeURIComponent(normalizeRuntimeKey(runtimeKey))}:${encodeURIComponent(sessionId)}:`
);
const outboxStorageKey = (runtimeKey: string, sessionId: string, clientMutationId: string): string => (
    `${outboxStoragePrefix(runtimeKey, sessionId)}${encodeURIComponent(clientMutationId)}`
);

const randomId = (prefix: string): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getQueueStorage = (): Storage => {
    if (typeof window !== 'undefined') {
        try {
            return window.localStorage;
        } catch {
            // Non-browser tests and restricted webviews use the safe fallback.
        }
    }
    return getSafeStorage();
};

const defaultDependencies: MessageQueueStoreDependencies = {
    getAPI: () => getRegisteredRuntimeAPIs()?.followUpQueue ?? null,
    getRuntimeKey,
    storage: getQueueStorage(),
    now: Date.now,
    createItemId: () => randomId('queue'),
    createMessageId: () => createOpenCodeIdentifier('msg'),
    createMutationId: () => randomId('follow-up'),
    createClaimId: () => randomId('claim'),
    verifyStorageWrite: (key, value) => {
        if (typeof window === 'undefined') return true;
        try {
            return window.localStorage.getItem(key) === value;
        } catch {
            return false;
        }
    },
    runWithLocalLock: async (key, task) => {
        if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            return navigator.locks.request(`openchamber:follow-up-queue:${key}`, task);
        }
        return task();
    },
    hasCrossContextLocalLock: () => Boolean(
        typeof navigator !== 'undefined' && navigator.locks?.request
    ),
    subscribeStorage: (listener) => {
        if (typeof window === 'undefined') return () => {};
        let localStorage: Storage;
        try {
            localStorage = window.localStorage;
        } catch {
            return () => {};
        }
        const onStorage = (event: StorageEvent) => {
            if (event.storageArea !== localStorage || !event.key) return;
            listener(event.key, event.newValue);
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    },
    schedule: (callback) => queueMicrotask(callback),
    scheduleRetry: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
    },
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isAbortError = (error: unknown): boolean => (
    error instanceof DOMException && error.name === 'AbortError'
    || (isRecord(error) && error.name === 'AbortError')
);

const cloneAttachmentDTO = (attachment: FollowUpQueueAttachment): FollowUpQueueAttachment => ({ ...attachment });

const toAttachmentDTO = (attachment: AttachedFile): FollowUpQueueAttachment => ({
    id: attachment.id,
    dataUrl: attachment.dataUrl,
    mimeType: attachment.mimeType,
    filename: attachment.filename,
    size: attachment.size,
    source: attachment.source,
    ...(attachment.serverPath !== undefined ? { serverPath: attachment.serverPath } : {}),
    ...(attachment.vscodePath !== undefined ? { vscodePath: attachment.vscodePath } : {}),
    ...(attachment.vscodeSource !== undefined ? { vscodeSource: attachment.vscodeSource } : {}),
});

const createPlaceholderFile = (attachment: FollowUpQueueAttachment): File => {
    if (typeof File === 'function') return new File([], attachment.filename, { type: attachment.mimeType });
    return {
        name: attachment.filename,
        type: attachment.mimeType,
        size: 0,
        lastModified: 0,
    } as File;
};

const toQueuedMessage = (item: FollowUpQueueItem): QueuedMessage => {
    const { attachments, ...rest } = item;
    return {
        ...rest,
        ...(attachments ? {
            attachments: attachments.map((attachment) => ({
                ...cloneAttachmentDTO(attachment),
                file: createPlaceholderFile(attachment),
            })),
        } : {}),
        ...(item.sendConfig ? { sendConfig: { ...item.sendConfig } } : {}),
        ...(item.claim ? { claim: { ...item.claim } } : {}),
    };
};

const itemListsEqual = (left: FollowUpQueueItem[], right: FollowUpQueueItem[]): boolean => (
    left === right
    || (left.length === right.length && left.every((item, index) => followUpQueueItemsEqual(item, right[index])))
);

const parseStoredLane = (raw: string | null): StoredQueueLane | null => {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as unknown;
        if (
            !isRecord(value)
            || value.version !== 1
            || (value.baseSnapshot !== null && !isRecord(value.baseSnapshot))
            || !Array.isArray(value.localItems)
            || !Number.isSafeInteger(value.localRevision)
            || Number(value.localRevision) < 0
            || !Array.isArray(value.legacyItemIds)
            || !value.legacyItemIds.every((entry) => typeof entry === 'string')
            || !Array.isArray(value.pending)
        ) return null;

        const localItems = value.localItems.map((item, index) => parseFollowUpQueueItem(item, { field: `localItems[${index}]` }));
        const pending = value.pending.map((entry, index) => {
            if (
                !isRecord(entry)
                || typeof entry.clientMutationId !== 'string'
                || !entry.clientMutationId
                || !Number.isSafeInteger(entry.projectionNow)
                || Number(entry.projectionNow) < 0
            ) throw new Error(`Invalid pending operation ${index}`);
            const operation = parseFollowUpQueueOperation(entry.operation);
            const claimExpiresAt = entry.claimExpiresAt === undefined
                ? undefined
                : Number(entry.claimExpiresAt);
            if (
                (claimExpiresAt !== undefined && (!Number.isSafeInteger(claimExpiresAt) || claimExpiresAt < 0))
                || (operation.type === 'claim' && claimExpiresAt === undefined)
            ) throw new Error(`Invalid pending operation ${index}`);
            return {
                clientMutationId: entry.clientMutationId,
                operation,
                projectionNow: Number(entry.projectionNow),
                ...(claimExpiresAt !== undefined ? { claimExpiresAt } : {}),
            };
        });
        return {
            version: 1,
            baseSnapshot: value.baseSnapshot === null ? null : parseFollowUpQueueSnapshot(value.baseSnapshot),
            localItems,
            localRevision: Number(value.localRevision),
            legacyItemIds: [...value.legacyItemIds] as string[],
            pending,
        };
    } catch {
        return null;
    }
};

const parseStoredOutboxEntry = (raw: string | null): PendingOperation | null => {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as unknown;
        if (
            !isRecord(value)
            || value.version !== 1
            || typeof value.clientMutationId !== 'string'
            || !value.clientMutationId
            || !Number.isSafeInteger(value.projectionNow)
            || Number(value.projectionNow) < 0
            || !Number.isSafeInteger(value.outboxOrder)
            || Number(value.outboxOrder) < 1
        ) return null;
        const operation = parseFollowUpQueueOperation(value.operation);
        const claimExpiresAt = value.claimExpiresAt === undefined
            ? undefined
            : Number(value.claimExpiresAt);
        if (
            (claimExpiresAt !== undefined && (!Number.isSafeInteger(claimExpiresAt) || claimExpiresAt < 0))
            || (operation.type === 'claim' && claimExpiresAt === undefined)
        ) return null;
        return {
            clientMutationId: value.clientMutationId,
            operation,
            projectionNow: Number(value.projectionNow),
            outboxOrder: Number(value.outboxOrder),
            ...(claimExpiresAt !== undefined ? { claimExpiresAt } : {}),
            orphaned: true,
        };
    } catch {
        return null;
    }
};

const readLegacyEnvelope = (storage: Storage): Record<string, unknown> | null => {
    try {
        const value = JSON.parse(storage.getItem(LEGACY_STORAGE_KEY) ?? 'null') as unknown;
        if (!isRecord(value) || !isRecord(value.state)) return null;
        return value;
    } catch {
        return null;
    }
};

const readInitialFollowUpBehavior = (storage: Storage): FollowUpBehavior => {
    try {
        const settings = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as unknown;
        if (isRecord(settings)) return normalizeFollowUpBehavior(settings.followUpBehavior);
    } catch {
        // Fall through to the concrete legacy persisted consumer.
    }
    const legacy = readLegacyEnvelope(storage)?.state;
    if (!isRecord(legacy)) return DEFAULT_FOLLOW_UP_BEHAVIOR;
    return normalizeFollowUpBehavior(legacy.followUpBehavior, legacy.queueModeEnabled as boolean | null | undefined);
};

const toLegacyAttachment = (value: unknown): FollowUpQueueAttachment | null => {
    if (!isRecord(value)) return null;
    const attachment = {
        id: value.id,
        dataUrl: value.dataUrl,
        mimeType: value.mimeType,
        filename: value.filename,
        size: value.size,
        source: value.source,
        ...(value.serverPath !== undefined ? { serverPath: value.serverPath } : {}),
        ...(value.vscodePath !== undefined ? { vscodePath: value.vscodePath } : {}),
        ...(value.vscodeSource !== undefined ? { vscodeSource: value.vscodeSource } : {}),
    };
    try {
        const parsed = parseFollowUpQueueItem({
            id: 'attachment-probe-item',
            messageId: 'attachment-probe-message',
            content: '',
            attachments: [attachment],
            createdAt: 0,
            status: 'staged',
        });
        return parsed.attachments?.[0] ?? null;
    } catch {
        return null;
    }
};

const runtimeChangedError = (): Error => new Error('Follow-up queue operation cancelled because the runtime changed');

export const createMessageQueueStore = (
    overrides: Partial<MessageQueueStoreDependencies> = {},
) => {
    const dependencies = { ...defaultDependencies, ...overrides };
    const startupRuntimeKey = normalizeRuntimeKey(dependencies.getRuntimeKey());
    const lanes = new Map<string, QueueLane>();
    const watchCounts = new Map<string, number>();
    let activeController = new AbortController();
    let runtimeSupported: boolean | null = dependencies.getAPI()?.supported === false ? false : null;
    let outboxSequence = 0;
    let settleUnsupportedInFlight: Promise<void> | null = null;
    let handleStorageChange: (key: string, newValue: string | null) => void = () => {};

    const useStore = create<MessageQueueStore>((set, get) => {
        const contextIsCurrent = (context: MessageQueueRuntimeContext): boolean => (
            get().runtimeKey === context.runtimeKey
            && get().generation === context.generation
            && normalizeRuntimeKey(dependencies.getRuntimeKey()) === context.runtimeKey
        );

        const laneIsCurrent = (lane: QueueLane): boolean => (
            lanes.get(lane.sessionId) === lane
            && contextIsCurrent({ runtimeKey: lane.runtimeKey, generation: lane.generation })
        );

        const persistLane = (lane: QueueLane): boolean => {
            const stored: StoredQueueLane = {
                version: 1,
                baseSnapshot: lane.baseSnapshot,
                localItems: lane.localItems,
                localRevision: lane.localRevision,
                legacyItemIds: lane.legacyItemIds,
                pending: lane.embeddedPending,
            };
            try {
                const key = laneStorageKey(lane.runtimeKey, lane.sessionId);
                if (dependencies.storage.getItem(laneDeletionKey(lane.runtimeKey, lane.sessionId)) === '1') {
                    return false;
                }
                const serialized = JSON.stringify(stored);
                dependencies.storage.setItem(key, serialized);
                if (dependencies.verifyStorageWrite(key, serialized)) return true;
                return false;
            } catch {
                return false;
            }
        };

        const persistOutboxEntry = (lane: QueueLane, entry: PendingOperation): boolean => {
            const key = outboxStorageKey(lane.runtimeKey, lane.sessionId, entry.clientMutationId);
            const serialized = JSON.stringify({
                version: 1,
                clientMutationId: entry.clientMutationId,
                operation: entry.operation,
                projectionNow: entry.projectionNow,
                outboxOrder: entry.outboxOrder,
                ...(entry.claimExpiresAt !== undefined ? { claimExpiresAt: entry.claimExpiresAt } : {}),
            });
            try {
                if (dependencies.storage.getItem(laneDeletionKey(lane.runtimeKey, lane.sessionId)) === '1') {
                    return false;
                }
                dependencies.storage.setItem(key, serialized);
                if (dependencies.verifyStorageWrite(key, serialized)) return true;
                dependencies.storage.removeItem(key);
                return false;
            } catch {
                try {
                    dependencies.storage.removeItem(key);
                } catch {
                    // The caller still fails closed instead of accepting an unverified outbox.
                }
                return false;
            }
        };

        const removeOutboxEntry = (lane: QueueLane, clientMutationId: string): void => {
            try {
                dependencies.storage.removeItem(outboxStorageKey(
                    lane.runtimeKey,
                    lane.sessionId,
                    clientMutationId,
                ));
            } catch {
                // A restart may replay the same mutation ID, which the host deduplicates.
            }
        };

        const readOutboxEntries = (runtimeKey: string, sessionId: string): PendingOperation[] => {
            const prefix = outboxStoragePrefix(runtimeKey, sessionId);
            const entries: PendingOperation[] = [];
            const seen = new Set<string>();
            try {
                const keys = Array.from(
                    { length: dependencies.storage.length },
                    (_, index) => dependencies.storage.key(index),
                ).filter((key): key is string => Boolean(key?.startsWith(prefix))).sort();
                for (const key of keys) {
                    const entry = parseStoredOutboxEntry(dependencies.storage.getItem(key));
                    if (!entry || seen.has(entry.clientMutationId)) continue;
                    seen.add(entry.clientMutationId);
                    entries.push(entry);
                    outboxSequence = Math.max(outboxSequence, entry.outboxOrder);
                }
            } catch {
                // Readable entries remain available on the next initialization attempt.
            }
            return entries.sort((left, right) => (
                left.projectionNow - right.projectionNow
                || left.outboxOrder - right.outboxOrder
                || left.clientMutationId.localeCompare(right.clientMutationId)
            ));
        };

        const removeSessionOutbox = (runtimeKey: string, sessionId: string): void => {
            const prefix = outboxStoragePrefix(runtimeKey, sessionId);
            try {
                const keys = Array.from(
                    { length: dependencies.storage.length },
                    (_, index) => dependencies.storage.key(index),
                ).filter((key): key is string => Boolean(key?.startsWith(prefix)));
                for (const key of keys) dependencies.storage.removeItem(key);
            } catch {
                // The deletion tombstone prevents any surviving entry from being replayed.
            }
        };

        const readLegacyItems = (lane: QueueLane): FollowUpQueueItem[] => {
            if (lane.runtimeKey !== startupRuntimeKey) return [];
            let owner: string | null = null;
            try {
                owner = dependencies.storage.getItem(LEGACY_OWNER_KEY);
                if (!owner) {
                    dependencies.storage.setItem(LEGACY_OWNER_KEY, startupRuntimeKey);
                    owner = startupRuntimeKey;
                }
            } catch {
                return [];
            }
            if (owner !== startupRuntimeKey) return [];
            const envelope = readLegacyEnvelope(dependencies.storage);
            const state = envelope?.state;
            if (!isRecord(state) || !isRecord(state.queuedMessages)) return [];
            const rawItems = state.queuedMessages[lane.sessionId];
            if (!Array.isArray(rawItems)) return [];

            const items: FollowUpQueueItem[] = [];
            const seenIds = new Set<string>();
            const seenMessageIds = new Set<string>();
            for (const raw of rawItems) {
                if (!isRecord(raw) || typeof raw.content !== 'string') continue;
                const attachments = Array.isArray(raw.attachments)
                    ? raw.attachments.map(toLegacyAttachment).filter((entry): entry is FollowUpQueueAttachment => entry !== null)
                    : undefined;
                const id = typeof raw.id === 'string' && raw.id ? raw.id : dependencies.createItemId();
                const messageId = typeof raw.messageId === 'string' && raw.messageId
                    ? raw.messageId
                    : dependencies.createMessageId();
                if (seenIds.has(id) || seenMessageIds.has(messageId)) continue;
                const candidate = {
                    id,
                    messageId,
                    content: raw.content,
                    ...(attachments && attachments.length > 0 ? { attachments } : {}),
                    createdAt: Number.isSafeInteger(raw.createdAt) && Number(raw.createdAt) >= 0
                        ? Number(raw.createdAt)
                        : dependencies.now(),
                    status: raw.status === 'queued' ? 'queued' : 'staged',
                    ...(isRecord(raw.sendConfig) ? { sendConfig: raw.sendConfig } : {}),
                };
                try {
                    const item = parseFollowUpQueueItem(candidate, { allowClaim: false });
                    seenIds.add(item.id);
                    seenMessageIds.add(item.messageId);
                    items.push(item);
                } catch {
                    // Invalid legacy data remains in its original key and is never deleted.
                }
            }
            return items;
        };

        const removeLegacySession = (sessionId: string): void => {
            const envelope = readLegacyEnvelope(dependencies.storage);
            const state = envelope?.state;
            if (!envelope || !isRecord(state) || !isRecord(state.queuedMessages)) return;
            const queues = { ...state.queuedMessages };
            delete queues[sessionId];
            try {
                dependencies.storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
                    ...envelope,
                    state: { ...state, queuedMessages: queues },
                }));
            } catch {
                // The runtime-scoped cache remains authoritative for retry.
            }
        };

        const removeConfirmedLegacySession = (lane: QueueLane): void => {
            removeLegacySession(lane.sessionId);
        };

        const deriveSnapshot = (lane: QueueLane): FollowUpQueueSnapshot => {
            let snapshot: FollowUpQueueSnapshot = lane.baseSnapshot ?? {
                scopeToken: LOCAL_SCOPE_TOKEN,
                revision: lane.localRevision,
                items: [],
            };
            if (lane.localItems.length > 0) {
                for (const item of lane.localItems) {
                    try {
                        snapshot = applyFollowUpQueueOperation(snapshot, { type: 'add', item }).snapshot;
                    } catch {
                        // Host identity wins while conflicting local migration data stays persisted.
                    }
                }
            }
            for (const pending of lane.pending) {
                try {
                    snapshot = applyFollowUpQueueOperation(snapshot, pending.operation, {
                        now: pending.projectionNow,
                        claimExpiresAt: pending.claimExpiresAt,
                    }).snapshot;
                } catch {
                    // The host will reject an intent that cannot be replayed semantically.
                }
            }
            return snapshot;
        };

        const publishLane = (lane: QueueLane): void => {
            if (!laneIsCurrent(lane)) return;
            const nextItems = deriveSnapshot(lane).items;
            if (itemListsEqual(lane.visibleItems, nextItems)) return;
            lane.visibleItems = nextItems;
            lane.visibleMessages = nextItems.map(toQueuedMessage);
            set((state) => ({
                queuedMessages: {
                    ...state.queuedMessages,
                    [lane.sessionId]: lane.visibleMessages,
                },
            }));
        };

        const adoptLegacyItems = (lane: QueueLane): void => {
            if (lane.legacyItemIds.length > 0) return;
            const legacyItems = readLegacyItems(lane);
            if (legacyItems.length === 0) return;
            const knownIds = new Set([
                ...lane.localItems.map((item) => item.id),
                ...(lane.baseSnapshot?.items.map((item) => item.id) ?? []),
                ...lane.pending.flatMap((entry) => entry.operation.type === 'add' ? [entry.operation.item.id] : []),
            ]);
            const adopted = legacyItems.filter((item) => !knownIds.has(item.id));
            lane.localItems.push(...adopted);
            lane.legacyItemIds = legacyItems.map((item) => item.id);
            persistLane(lane);
        };

        const createLane = (sessionId: string): QueueLane => {
            const runtimeKey = get().runtimeKey;
            const deleted = dependencies.storage.getItem(laneDeletionKey(runtimeKey, sessionId)) === '1';
            const stored = deleted
                ? null
                : parseStoredLane(dependencies.storage.getItem(laneStorageKey(runtimeKey, sessionId)));
            const durablePending = deleted ? [] : readOutboxEntries(runtimeKey, sessionId);
            const knownMutationIds = new Set(durablePending.map((entry) => entry.clientMutationId));
            const embeddedPending: StoredQueueLane['pending'] = [];
            const migratedPending: PendingOperation[] = [];
            const lane: QueueLane = {
                runtimeKey,
                generation: get().generation,
                sessionId,
                baseSnapshot: stored?.baseSnapshot ?? null,
                localItems: stored?.localItems ?? [],
                localRevision: stored?.localRevision ?? 0,
                legacyItemIds: stored?.legacyItemIds ?? [],
                pending: durablePending,
                embeddedPending,
                hintedRevision: stored?.baseSnapshot?.revision ?? -1,
                loadedForGeneration: false,
                loadInFlight: null,
                drainInFlight: null,
                retryDelayMs: INITIAL_RETRY_MS,
                cancelRetry: null,
                refreshScheduled: false,
                refreshQueued: false,
                resetHinted: false,
                visibleItems: [],
                visibleMessages: [],
            };
            lanes.set(sessionId, lane);
            if (!deleted) {
                for (const entry of stored?.pending ?? []) {
                    if (knownMutationIds.has(entry.clientMutationId)) continue;
                    const candidate: PendingOperation = {
                        ...entry,
                        outboxOrder: ++outboxSequence,
                        orphaned: true,
                    };
                    migratedPending.push(candidate);
                    if (persistOutboxEntry(lane, candidate)) {
                        knownMutationIds.add(candidate.clientMutationId);
                    } else {
                        embeddedPending.push(entry);
                    }
                }
                lane.pending.push(...migratedPending);
            }
            adoptLegacyItems(lane);
            persistLane(lane);
            return lane;
        };

        const getLane = (sessionId: string): QueueLane => lanes.get(sessionId) ?? createLane(sessionId);

        const cancelRetry = (lane: QueueLane): void => {
            lane.cancelRetry?.();
            lane.cancelRetry = null;
        };

        const clearCurrentSessionLane = (sessionId: string): void => {
            const lane = lanes.get(sessionId);
            if (lane) {
                cancelRetry(lane);
                for (const pending of lane.pending) {
                    pending.reject?.(new Error('Follow-up queue operation cancelled because the session was deleted'));
                }
                lanes.delete(sessionId);
            }
            watchCounts.delete(sessionId);
            set((state) => {
                if (!(sessionId in state.queuedMessages)) return state;
                const queuedMessages = { ...state.queuedMessages };
                delete queuedMessages[sessionId];
                return { queuedMessages };
            });
        };

        const scheduleRetry = (lane: QueueLane): void => {
            if (!laneIsCurrent(lane) || lane.cancelRetry || runtimeSupported === false) return;
            if ((watchCounts.get(lane.sessionId) ?? 0) === 0 && lane.pending.length === 0) return;
            const delayMs = lane.retryDelayMs;
            lane.retryDelayMs = Math.min(lane.retryDelayMs * 2, MAX_RETRY_MS);
            lane.cancelRetry = dependencies.scheduleRetry(() => {
                lane.cancelRetry = null;
                if (!laneIsCurrent(lane)) return;
                void initializeLane(lane);
            }, delayMs);
        };

        const localResult = (
            lane: QueueLane,
            entry: PendingOperation,
        ): FollowUpQueueMutationResult => {
            const before: FollowUpQueueSnapshot = {
                scopeToken: LOCAL_SCOPE_TOKEN,
                revision: lane.localRevision,
                items: lane.localItems,
            };
            const applied = applyFollowUpQueueOperation(before, entry.operation, {
                now: entry.projectionNow,
                claimExpiresAt: entry.claimExpiresAt,
            });
            if (applied.applied) lane.localRevision += 1;
            lane.localItems = applied.snapshot.items;
            return {
                snapshot: { ...applied.snapshot, revision: lane.localRevision },
                applied: applied.applied,
                deduplicated: false,
                mutationRevision: applied.applied ? lane.localRevision : null,
            };
        };

        const applyLocalOperation = (
            lane: QueueLane,
            entry: PendingOperation,
        ): Promise<FollowUpQueueMutationResult> => dependencies.runWithLocalLock(
            laneStorageKey(lane.runtimeKey, lane.sessionId),
            async () => {
                if (!laneIsCurrent(lane) || runtimeSupported !== false) throw runtimeChangedError();
                const stored = parseStoredLane(dependencies.storage.getItem(
                    laneStorageKey(lane.runtimeKey, lane.sessionId),
                ));
                if (stored && stored.pending.length === 0 && stored.localRevision >= lane.localRevision) {
                    lane.localItems = stored.localItems;
                    lane.localRevision = stored.localRevision;
                }
                const previousItems = lane.localItems;
                const previousRevision = lane.localRevision;
                const result = localResult(lane, entry);
                if (!persistLane(lane)) {
                    lane.localItems = previousItems;
                    lane.localRevision = previousRevision;
                    throw new Error('Failed to persist follow-up queue operation');
                }
                publishLane(lane);
                return result;
            },
        );

        const settleUnsupported = (): Promise<void> => {
            if (settleUnsupportedInFlight) return settleUnsupportedInFlight;
            runtimeSupported = false;
            set({ supported: false });
            const request = (async () => {
                for (const lane of lanes.values()) {
                    if (!laneIsCurrent(lane)) continue;
                    await dependencies.runWithLocalLock(
                        laneStorageKey(lane.runtimeKey, lane.sessionId),
                        async () => {
                            if (!laneIsCurrent(lane)) return;
                            cancelRetry(lane);
                            const ownPending = [...lane.pending];
                            const stored = parseStoredLane(dependencies.storage.getItem(
                                laneStorageKey(lane.runtimeKey, lane.sessionId),
                            ));
                            if (
                                stored?.baseSnapshot
                                && (!lane.baseSnapshot || stored.baseSnapshot.revision >= lane.baseSnapshot.revision)
                            ) lane.baseSnapshot = stored.baseSnapshot;
                            if (stored && stored.localRevision >= lane.localRevision) {
                                lane.localItems = stored.localItems;
                                lane.localRevision = stored.localRevision;
                            }
                            const durablePending = readOutboxEntries(lane.runtimeKey, lane.sessionId);
                            const embeddedPending = (stored?.pending ?? []).map((entry) => ({
                                ...entry,
                                outboxOrder: ++outboxSequence,
                                orphaned: true,
                            }));
                            const pendingById = new Map<string, PendingOperation>();
                            for (const entry of [...durablePending, ...embeddedPending]) {
                                if (!pendingById.has(entry.clientMutationId)) {
                                    pendingById.set(entry.clientMutationId, entry);
                                }
                            }
                            const previous = {
                                baseSnapshot: lane.baseSnapshot,
                                localItems: lane.localItems,
                                localRevision: lane.localRevision,
                                loadedForGeneration: lane.loadedForGeneration,
                                pending: lane.pending,
                                embeddedPending: lane.embeddedPending,
                            };
                            lane.pending = [...pendingById.values()].sort((left, right) => (
                                left.projectionNow - right.projectionNow
                                || left.outboxOrder - right.outboxOrder
                                || left.clientMutationId.localeCompare(right.clientMutationId)
                            ));
                            const projected = deriveSnapshot(lane);
                            lane.baseSnapshot = null;
                            lane.localItems = projected.items;
                            lane.localRevision = Math.max(lane.localRevision, projected.revision);
                            lane.loadedForGeneration = true;
                            lane.pending = [];
                            lane.embeddedPending = [];
                            if (!persistLane(lane)) {
                                lane.baseSnapshot = previous.baseSnapshot;
                                lane.localItems = previous.localItems;
                                lane.localRevision = previous.localRevision;
                                lane.loadedForGeneration = previous.loadedForGeneration;
                                lane.pending = previous.pending;
                                lane.embeddedPending = previous.embeddedPending;
                                publishLane(lane);
                                return;
                            }
                            for (const entry of durablePending) {
                                removeOutboxEntry(lane, entry.clientMutationId);
                            }
                            const result: FollowUpQueueMutationResult = {
                                snapshot: {
                                    scopeToken: LOCAL_SCOPE_TOKEN,
                                    revision: lane.localRevision,
                                    items: lane.localItems,
                                },
                                applied: true,
                                deduplicated: false,
                                mutationRevision: lane.localRevision,
                            };
                            for (const entry of ownPending) entry.resolve?.(result);
                            publishLane(lane);
                        },
                    );
                }
            })();
            settleUnsupportedInFlight = request;
            void request.finally(() => {
                if (settleUnsupportedInFlight === request) settleUnsupportedInFlight = null;
            });
            return request;
        };

        const reconcileLocalItems = (lane: QueueLane, snapshot: FollowUpQueueSnapshot): void => {
            const legacyIds = new Set(lane.legacyItemIds);
            const allLegacyConfirmed = lane.legacyItemIds.length > 0 && lane.legacyItemIds.every((id) => {
                const local = lane.localItems.find((item) => item.id === id);
                const remote = snapshot.items.find((item) => item.id === id);
                return Boolean(local && remote && followUpQueueItemsEqual(local, remote));
            });
            if (allLegacyConfirmed) {
                removeConfirmedLegacySession(lane);
                lane.localItems = lane.localItems.filter((item) => !legacyIds.has(item.id));
                lane.legacyItemIds = [];
            }
            lane.localItems = lane.localItems.filter((local) => {
                if (legacyIds.has(local.id) && !allLegacyConfirmed) return true;
                const remote = snapshot.items.find(
                    (item) => item.id === local.id || item.messageId === local.messageId,
                );
                return !remote || !followUpQueueItemsEqual(local, remote);
            });
        };

        const ensureLocalAdds = (lane: QueueLane): void => {
            if (runtimeSupported !== true || !lane.baseSnapshot) return;
            const additions: PendingOperation[] = [];
            for (const item of lane.localItems) {
                const remote = lane.baseSnapshot.items.find(
                    (candidate) => candidate.id === item.id || candidate.messageId === item.messageId,
                );
                if (remote && followUpQueueItemsEqual(remote, item)) continue;
                const alreadyPending = lane.pending.some(
                    (entry) => entry.operation.type === 'add'
                        && (entry.operation.item.id === item.id || entry.operation.item.messageId === item.messageId),
                );
                if (alreadyPending) continue;
                additions.push({
                    clientMutationId: dependencies.createMutationId(),
                    operation: { type: 'add', item },
                    projectionNow: dependencies.now(),
                    outboxOrder: ++outboxSequence,
                    orphaned: true,
                });
            }
            if (additions.length > 0) {
                const persisted = additions.filter((entry) => persistOutboxEntry(lane, entry));
                lane.pending = [...persisted, ...lane.pending];
                persistLane(lane);
                publishLane(lane);
            }
        };

        const installSnapshot = (
            lane: QueueLane,
            snapshot: FollowUpQueueSnapshot,
            options: { allowRevisionReset?: boolean } = {},
        ): boolean => {
            if (!laneIsCurrent(lane)) return false;
            const revisionReset = Boolean(
                options.allowRevisionReset
                && lane.baseSnapshot
                && snapshot.revision < lane.baseSnapshot.revision
            );
            if (
                !options.allowRevisionReset
                && lane.baseSnapshot
                && snapshot.revision < lane.baseSnapshot.revision
            ) return false;
            lane.baseSnapshot = snapshot;
            lane.loadedForGeneration = true;
            lane.hintedRevision = revisionReset
                ? snapshot.revision
                : Math.max(lane.hintedRevision, snapshot.revision);
            lane.retryDelayMs = INITIAL_RETRY_MS;
            cancelRetry(lane);
            reconcileLocalItems(lane, snapshot);
            persistLane(lane);
            publishLane(lane);
            return true;
        };

        const refreshLane = async (lane: QueueLane): Promise<void> => {
            if (lane.loadInFlight) {
                lane.refreshQueued = true;
                return lane.loadInFlight;
            }
            if (!laneIsCurrent(lane)) return;
            const api = dependencies.getAPI();
            if (!api) return;
            if (!api.supported) {
                await settleUnsupported();
                return;
            }
            const context = { runtimeKey: lane.runtimeKey, generation: lane.generation };
            const allowRevisionReset = !lane.loadedForGeneration || lane.resetHinted;
            lane.resetHinted = false;
            const request = (async () => {
                try {
                    const snapshot = await api.load(lane.sessionId, {
                        signal: activeController.signal,
                        expectedRuntimeKey: lane.runtimeKey,
                    });
                    if (!contextIsCurrent(context) || !laneIsCurrent(lane)) return;
                    if (!snapshot) {
                        await settleUnsupported();
                        return;
                    }
                    runtimeSupported = true;
                    set({ supported: true });
                    installSnapshot(lane, snapshot, { allowRevisionReset });
                    ensureLocalAdds(lane);
                    if (snapshot.revision < lane.hintedRevision) scheduleRetry(lane);
                } catch (error) {
                    if (!contextIsCurrent(context) || !laneIsCurrent(lane) || isAbortError(error)) return;
                    if (error instanceof FollowUpQueueUnsupportedError) {
                        await settleUnsupported();
                        return;
                    }
                    scheduleRetry(lane);
                }
            })();
            lane.loadInFlight = request;
            await request.finally(() => {
                if (lane.loadInFlight === request) lane.loadInFlight = null;
                if (lane.refreshQueued && laneIsCurrent(lane)) {
                    lane.refreshQueued = false;
                    void refreshLane(lane);
                }
            });
        };

        const removePending = (lane: QueueLane, entry: PendingOperation): boolean => {
            const index = lane.pending.indexOf(entry);
            if (index < 0) return false;
            lane.pending.splice(index, 1);
            lane.embeddedPending = lane.embeddedPending.filter(
                (candidate) => candidate.clientMutationId !== entry.clientMutationId,
            );
            removeOutboxEntry(lane, entry.clientMutationId);
            persistLane(lane);
            publishLane(lane);
            return true;
        };

        const enqueueOrphanRelease = (lane: QueueLane, entry: PendingOperation, result: FollowUpQueueMutationResult): void => {
            if (!entry.orphaned || entry.operation.type !== 'claim') return;
            const operation = entry.operation;
            const item = result.snapshot.items.find((candidate) => candidate.id === operation.itemId);
            if (item?.claim?.id !== operation.claimId) return;
            const release: PendingOperation = {
                clientMutationId: dependencies.createMutationId(),
                operation: {
                    type: 'release',
                    itemId: item.id,
                    claimId: operation.claimId,
                    status: item.status,
                },
                projectionNow: dependencies.now(),
                outboxOrder: ++outboxSequence,
                orphaned: true,
            };
            if (persistOutboxEntry(lane, release)) lane.pending.unshift(release);
        };

        const drainLane = async (lane: QueueLane): Promise<void> => {
            if (lane.drainInFlight) return lane.drainInFlight;
            const request = (async () => {
                let conflictCount = 0;
                while (lane.pending.length > 0 && laneIsCurrent(lane)) {
                    if (runtimeSupported === false) return;
                    if (!lane.baseSnapshot) {
                        await refreshLane(lane);
                        if (!lane.baseSnapshot || runtimeSupported !== true) return;
                    }
                    const entry = lane.pending[0];
                    const api = dependencies.getAPI();
                    if (!api?.supported) {
                        await settleUnsupported();
                        return;
                    }
                    try {
                        const result = await api.mutate({
                            sessionId: lane.sessionId,
                            baseRevision: lane.baseSnapshot.revision,
                            clientMutationId: entry.clientMutationId,
                            operation: entry.operation,
                        }, {
                            signal: activeController.signal,
                            expectedRuntimeKey: lane.runtimeKey,
                        });
                        if (!laneIsCurrent(lane) || lane.pending[0] !== entry) return;
                        if (!result) {
                            await settleUnsupported();
                            return;
                        }
                        const installed = installSnapshot(lane, result.snapshot);
                        if (!laneIsCurrent(lane)) return;
                        const effectiveResult = installed || !lane.baseSnapshot
                            ? result
                            : { ...result, snapshot: lane.baseSnapshot };
                        const addOperation = entry.operation.type === 'add' ? entry.operation : null;
                        const missingAppliedAdd = addOperation !== null
                            && !effectiveResult.snapshot.items.some((item) => (
                                item.id === addOperation.item.id
                                || item.messageId === addOperation.item.messageId
                            ));
                        removePending(lane, entry);
                        if (missingAppliedAdd && addOperation) {
                            lane.localItems = lane.localItems.filter((item) => (
                                item.id !== addOperation.item.id
                                && item.messageId !== addOperation.item.messageId
                            ));
                            lane.legacyItemIds = lane.legacyItemIds.filter((id) => id !== addOperation.item.id);
                            persistLane(lane);
                            if (!entry.orphaned) {
                                entry.reject?.(new Error('The host rejected the follow-up because the session is no longer active'));
                            }
                            publishLane(lane);
                            conflictCount = 0;
                            continue;
                        }
                        enqueueOrphanRelease(lane, entry, effectiveResult);
                        entry.resolve?.(effectiveResult);
                        conflictCount = 0;
                        ensureLocalAdds(lane);
                        persistLane(lane);
                        publishLane(lane);
                    } catch (error) {
                        if (!laneIsCurrent(lane) || lane.pending[0] !== entry) return;
                        if (isAbortError(error)) return;
                        if (error instanceof FollowUpQueueUnsupportedError) {
                            await settleUnsupported();
                            return;
                        }
                        if (error instanceof FollowUpQueueConflictError) {
                            installSnapshot(lane, error.latestSnapshot, { allowRevisionReset: true });
                            conflictCount += 1;
                            if (conflictCount < 8) continue;
                            scheduleRetry(lane);
                            return;
                        }
                        if (error instanceof FollowUpQueueRequestError && error.permanent) {
                            removePending(lane, entry);
                            entry.reject?.(error);
                            conflictCount = 0;
                            continue;
                        }
                        scheduleRetry(lane);
                        return;
                    }
                }
            })();
            lane.drainInFlight = request;
            await request.finally(() => {
                if (lane.drainInFlight === request) lane.drainInFlight = null;
            });
        };

        const initializeLane = async (lane: QueueLane): Promise<void> => {
            if (!laneIsCurrent(lane)) return;
            if (runtimeSupported === false) {
                await settleUnsupported();
                publishLane(lane);
                return;
            }
            if (!lane.loadedForGeneration) await refreshLane(lane);
            if (runtimeSupported === true) {
                ensureLocalAdds(lane);
                await drainLane(lane);
            }
        };

        const enqueueOperation = (
            sessionId: string,
            operation: FollowUpQueueOperation,
        ): Promise<FollowUpQueueMutationResult> => {
            const lane = getLane(sessionId);
            const projectionNow = dependencies.now();
            const entry: PendingOperation = {
                clientMutationId: dependencies.createMutationId(),
                operation,
                projectionNow,
                outboxOrder: ++outboxSequence,
                ...(operation.type === 'claim' ? {
                    claimExpiresAt: projectionNow + FOLLOW_UP_QUEUE_CLAIM_TTL_MS,
                } : {}),
                orphaned: false,
            };
            applyFollowUpQueueOperation(deriveSnapshot(lane), operation, {
                now: entry.projectionNow,
                claimExpiresAt: entry.claimExpiresAt,
            });

            if (runtimeSupported === false) {
                return settleUnsupported().then(() => applyLocalOperation(lane, entry));
            }

            let resolveEntry!: (result: FollowUpQueueMutationResult) => void;
            let rejectEntry!: (error: Error) => void;
            const completion = new Promise<FollowUpQueueMutationResult>((resolve, reject) => {
                resolveEntry = resolve;
                rejectEntry = reject;
            });
            entry.resolve = resolveEntry;
            entry.reject = rejectEntry;
            if (!persistOutboxEntry(lane, entry)) {
                throw new Error('Failed to persist follow-up queue operation');
            }
            lane.pending.push(entry);
            persistLane(lane);
            publishLane(lane);
            void initializeLane(lane);
            return completion;
        };

        const fireAndPersist = (sessionId: string, operation: FollowUpQueueOperation): void => {
            void enqueueOperation(sessionId, operation).catch(() => {});
        };

        const switchRuntime = (runtimeKey: string): void => {
            const normalized = normalizeRuntimeKey(runtimeKey);
            activeController.abort();
            activeController = new AbortController();
            for (const lane of lanes.values()) {
                cancelRetry(lane);
                for (const pending of lane.pending) pending.reject?.(runtimeChangedError());
            }
            lanes.clear();
            runtimeSupported = dependencies.getAPI()?.supported === false ? false : null;
            set((state) => ({
                runtimeKey: normalized,
                generation: state.generation + 1,
                supported: runtimeSupported,
                queuedMessages: {},
            }));
            for (const [sessionId, count] of watchCounts) {
                if (count <= 0) continue;
                const lane = getLane(sessionId);
                publishLane(lane);
                void initializeLane(lane);
            }
        };

        return {
            queuedMessages: {},
            followUpBehavior: readInitialFollowUpBehavior(dependencies.storage),
            runtimeKey: startupRuntimeKey,
            generation: 0,
            supported: runtimeSupported,

            initialize: async () => {
                const runtimeKey = normalizeRuntimeKey(dependencies.getRuntimeKey());
                if (runtimeKey !== get().runtimeKey) {
                    switchRuntime(runtimeKey);
                    return;
                }
                const work: Promise<void>[] = [];
                for (const [sessionId, count] of watchCounts) {
                    if (count > 0) work.push(initializeLane(getLane(sessionId)));
                }
                await Promise.all(work);
            },

            watchSession: (sessionId) => {
                if (!sessionId) return () => {};
                watchCounts.set(sessionId, (watchCounts.get(sessionId) ?? 0) + 1);
                const lane = getLane(sessionId);
                publishLane(lane);
                void initializeLane(lane);
                let active = true;
                return () => {
                    if (!active) return;
                    active = false;
                    const next = Math.max(0, (watchCounts.get(sessionId) ?? 1) - 1);
                    if (next === 0) watchCounts.delete(sessionId);
                    else watchCounts.set(sessionId, next);
                    const currentLane = lanes.get(sessionId);
                    if (next === 0 && currentLane?.pending.length === 0) cancelRetry(currentLane);
                };
            },

            refreshSession: async (sessionId) => {
                const lane = getLane(sessionId);
                await refreshLane(lane);
                if (runtimeSupported === true) await drainLane(lane);
            },

            addToQueue: (sessionId, message) => {
                const item = parseFollowUpQueueItem({
                    id: dependencies.createItemId(),
                    messageId: dependencies.createMessageId(),
                    content: message.content,
                    ...(message.attachments && message.attachments.length > 0 ? {
                        attachments: message.attachments.map(toAttachmentDTO),
                    } : {}),
                    createdAt: dependencies.now(),
                    status: message.status ?? 'staged',
                    ...(message.sendConfig ? { sendConfig: { ...message.sendConfig } } : {}),
                }, { allowClaim: false });
                return enqueueOperation(sessionId, { type: 'add', item }).then((result) => {
                    const persisted = result.snapshot.items.find((candidate) => (
                        candidate.id === item.id && candidate.messageId === item.messageId
                    ));
                    if (!persisted) throw new Error('The host rejected the follow-up');
                    return toQueuedMessage(persisted);
                });
            },

            removeFromQueue: (sessionId, messageId) => {
                fireAndPersist(sessionId, { type: 'remove', itemId: messageId });
            },

            setQueuedStatus: (sessionId, messageId, status) => {
                fireAndPersist(sessionId, { type: 'set-status', itemId: messageId, status });
            },

            reorderQueue: (sessionId, fromId, toId) => {
                if (fromId === toId) return;
                const items = get().queuedMessages[sessionId] ?? [];
                const fromIndex = items.findIndex((item) => item.id === fromId);
                const toIndex = items.findIndex((item) => item.id === toId);
                if (fromIndex < 0 || toIndex < 0) return;
                const reordered = items.slice();
                const [moved] = reordered.splice(fromIndex, 1);
                reordered.splice(toIndex, 0, moved);
                const movedIndex = reordered.findIndex((item) => item.id === fromId);
                fireAndPersist(sessionId, {
                    type: 'move',
                    itemId: fromId,
                    beforeId: reordered[movedIndex + 1]?.id ?? null,
                });
            },

            popToInput: (sessionId, messageId) => {
                const message = (get().queuedMessages[sessionId] ?? []).find((item) => item.id === messageId) ?? null;
                if (message) fireAndPersist(sessionId, { type: 'remove', itemId: messageId });
                return message;
            },

            clearQueue: (sessionId) => {
                for (const item of get().queuedMessages[sessionId] ?? []) {
                    fireAndPersist(sessionId, { type: 'remove', itemId: item.id });
                }
            },

            clearAllQueues: () => {
                for (const [sessionId, items] of Object.entries(get().queuedMessages)) {
                    for (const item of items) fireAndPersist(sessionId, { type: 'remove', itemId: item.id });
                }
            },

            setFollowUpBehavior: (behavior) => {
                set({ followUpBehavior: behavior });
                try {
                    dependencies.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ followUpBehavior: behavior }));
                } catch {
                    // Desktop settings remain the second persistence authority.
                }
                void updateDesktopSettings({ followUpBehavior: behavior });
            },

            getQueueForSession: (sessionId) => get().queuedMessages[sessionId] ?? [],

            claim: async (sessionId, itemId, mode) => {
                const context = { runtimeKey: get().runtimeKey, generation: get().generation };
                if (
                    mode === 'auto'
                    && runtimeSupported === false
                    && !dependencies.hasCrossContextLocalLock()
                ) return null;
                const claimId = dependencies.createClaimId();
                const result = await enqueueOperation(sessionId, { type: 'claim', itemId, claimId, mode });
                if (!contextIsCurrent(context)) return null;
                const item = result.snapshot.items.find((candidate) => candidate.id === itemId);
                if (item?.claim?.id !== claimId) return null;
                return { claimId, item: toQueuedMessage(item), context };
            },

            complete: async (sessionId, itemId, claimId, context) => {
                if (context && !contextIsCurrent(context)) return false;
                const result = await enqueueOperation(sessionId, { type: 'complete', itemId, claimId });
                if (context && !contextIsCurrent(context)) return false;
                return !result.snapshot.items.some((item) => item.id === itemId);
            },

            release: async (sessionId, itemId, claimId, status, context) => {
                if (context && !contextIsCurrent(context)) return false;
                const result = await enqueueOperation(sessionId, { type: 'release', itemId, claimId, status });
                if (context && !contextIsCurrent(context)) return false;
                const item = result.snapshot.items.find((candidate) => candidate.id === itemId);
                return Boolean(item && !item.claim && item.status === status);
            },

            handleRevisionHint: (scopeToken, revision, context, reset = false) => {
                if (context && !contextIsCurrent(context)) return;
                if (!/^[\da-f]{64}$/.test(scopeToken) || !Number.isSafeInteger(revision) || revision < 0) return;
                for (const lane of lanes.values()) {
                    if (!laneIsCurrent(lane) || (watchCounts.get(lane.sessionId) ?? 0) === 0) continue;
                    const unknownScope = lane.baseSnapshot === null;
                    if (!unknownScope && lane.baseSnapshot?.scopeToken !== scopeToken) continue;
                    if (!reset && !unknownScope && (lane.baseSnapshot?.revision ?? -1) >= revision) continue;
                    if (reset) {
                        lane.loadedForGeneration = false;
                        lane.hintedRevision = revision;
                        lane.resetHinted = true;
                    }
                    if (unknownScope) {
                        if (lane.loadInFlight) lane.refreshQueued = true;
                    } else if (!reset) {
                        lane.hintedRevision = Math.max(lane.hintedRevision, revision);
                    }
                    if (lane.refreshScheduled) continue;
                    lane.refreshScheduled = true;
                    dependencies.schedule(() => {
                        lane.refreshScheduled = false;
                        if (!laneIsCurrent(lane)) return;
                        if (
                            lane.baseSnapshot
                            && lane.baseSnapshot.scopeToken === scopeToken
                            && lane.baseSnapshot.revision >= lane.hintedRevision
                            && !lane.resetHinted
                        ) return;
                        void refreshLane(lane);
                    });
                }
            },

            handleTransportReady: (context) => {
                if (context && !contextIsCurrent(context)) return;
                const api = dependencies.getAPI();
                if (!api) return;
                if (!api.supported) {
                    void settleUnsupported();
                    return;
                }
                runtimeSupported = null;
                set({ supported: null });
                for (const lane of lanes.values()) {
                    if (!laneIsCurrent(lane)) continue;
                    cancelRetry(lane);
                    lane.retryDelayMs = INITIAL_RETRY_MS;
                    lane.loadedForGeneration = false;
                    if ((watchCounts.get(lane.sessionId) ?? 0) > 0 || lane.pending.length > 0 || lane.localItems.length > 0) {
                        void initializeLane(lane);
                    }
                }
            },

            dropSession: (sessionId, context) => {
                const runtimeKey = context?.runtimeKey ?? get().runtimeKey;
                let tombstoneWritten = false;
                try {
                    dependencies.storage.setItem(laneDeletionKey(runtimeKey, sessionId), '1');
                    tombstoneWritten = true;
                } catch {
                    // Removing the larger lane can free enough quota for a retry below.
                }
                try {
                    dependencies.storage.removeItem(laneStorageKey(runtimeKey, sessionId));
                } catch {
                    // In-memory cleanup still prevents deleted content from remaining visible.
                }
                removeSessionOutbox(runtimeKey, sessionId);
                if (!tombstoneWritten) {
                    try {
                        dependencies.storage.setItem(laneDeletionKey(runtimeKey, sessionId), '1');
                    } catch {
                        // The lane was still removed independently where storage allowed it.
                    }
                }
                if (runtimeKey === startupRuntimeKey) removeLegacySession(sessionId);
                if (runtimeKey !== get().runtimeKey) return;
                clearCurrentSessionLane(sessionId);
            },

            switchRuntime,
        };

        handleStorageChange = (key, newValue) => {
            if (runtimeSupported !== false) return;
            const deletedLane = [...lanes.values()].find((candidate) => (
                laneIsCurrent(candidate)
                && laneDeletionKey(candidate.runtimeKey, candidate.sessionId) === key
            ));
            if (deletedLane && newValue === '1') {
                removeLegacySession(deletedLane.sessionId);
                clearCurrentSessionLane(deletedLane.sessionId);
                return;
            }
            if (newValue === null) return;
            const lane = [...lanes.values()].find((candidate) => (
                laneIsCurrent(candidate)
                && laneStorageKey(candidate.runtimeKey, candidate.sessionId) === key
            ));
            if (!lane) return;
            const stored = parseStoredLane(newValue);
            if (!stored || stored.pending.length > 0 || stored.localRevision < lane.localRevision) return;
            lane.localItems = stored.localItems;
            lane.localRevision = stored.localRevision;
            publishLane(lane);
        };
    });

    dependencies.subscribeStorage((key, newValue) => handleStorageChange(key, newValue));

    return useStore;
};

export const useMessageQueueStore = createMessageQueueStore();

export const handleFollowUpQueueGlobalEvent = (
    value: unknown,
    context?: MessageQueueRuntimeContext,
): void => {
    if (!isRecord(value)) return;
    if (value.type === 'openchamber:notification-stream-ready') {
        useMessageQueueStore.getState().handleTransportReady(context);
        return;
    }
    if (value.type !== 'openchamber:follow-up-queue.changed' || !isRecord(value.properties)) return;
    if (typeof value.properties.scopeToken !== 'string' || typeof value.properties.revision !== 'number') return;
    useMessageQueueStore.getState().handleRevisionHint(
        value.properties.scopeToken,
        value.properties.revision,
        context,
        value.properties.reset === true,
    );
};

export const notifyFollowUpQueueTransportReady = (context?: MessageQueueRuntimeContext): void => {
    useMessageQueueStore.getState().handleTransportReady(context);
};
