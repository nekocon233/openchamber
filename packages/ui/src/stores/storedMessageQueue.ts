import type {
  FollowUpQueueItem,
  FollowUpQueueMutationResult,
  FollowUpQueueOperation,
  FollowUpQueueSnapshot,
} from '@/lib/api/types';
import { parseFollowUpQueueItem, parseFollowUpQueueOperation, parseFollowUpQueueSnapshot } from '@/lib/followUpQueue';
import type { FollowUpBehavior, QueuedMessage } from './messageQueueStore';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
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

export interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>;
    sendingIds: Record<string, string[]>;
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    runtimeKey: string;
    generation: number;
    supported: boolean | null;
}

export type PendingOperation = {
    clientMutationId: string;
    operation: FollowUpQueueOperation;
    projectionNow: number;
    outboxOrder: number;
    claimExpiresAt?: number;
    orphaned: boolean;
    resolve?: (result: FollowUpQueueMutationResult) => void;
    reject?: (error: Error) => void;
};

export type StoredQueueLane = {
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

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, QueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

export const migrateMessageQueueState = (
    persistedState: unknown,
    version: number,
): Pick<MessageQueueState, 'queuedMessages' | 'quarantinedLegacyMessages' | 'followUpBehavior'> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : (state.queuedMessages ?? {}),
        quarantinedLegacyMessages: {
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        },
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

export const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const parseStoredLane = (raw: string | null): StoredQueueLane | null => {
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

export const parseStoredOutboxEntry = (raw: string | null): PendingOperation | null => {
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
