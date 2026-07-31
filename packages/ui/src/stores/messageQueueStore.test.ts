import { describe, expect, test } from 'bun:test';

import type {
    FollowUpQueueAPI,
    FollowUpQueueItem,
    FollowUpQueueMutationRequest,
    FollowUpQueueMutationResult,
    FollowUpQueueOperation,
    FollowUpQueueSnapshot,
} from '@/lib/api/types';
import {
    FOLLOW_UP_QUEUE_CLAIM_TTL_MS,
    FollowUpQueueConflictError,
    applyFollowUpQueueOperation,
} from '@/lib/followUpQueue';
import { createOpenCodeIdentifier } from '@/lib/opencode/identifier';
import {
    createMessageQueueStore,
    createMessageQueueTarget,
    getMessageQueueKey,
    migrateMessageQueueState,
    parseMessageQueueKey,
    type MessageQueueIdentity,
} from './messageQueueStore';

const createMemoryStorage = (): Storage => {
    const values = new Map<string, string>();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
        removeItem: (key) => {
            values.delete(key);
        },
        clear: () => values.clear(),
        key: (index) => Array.from(values.keys())[index] ?? null,
        get length() {
            return values.size;
        },
    } as Storage;
};

const clone = <T>(value: T): T => structuredClone(value);
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};
const flush = async (): Promise<void> => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const scopeTokenFor = (sessionId: string): string => {
    let hash = 0;
    for (const character of sessionId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
    return hash.toString(16).padStart(64, '0');
};

const item = (id: string, status: 'staged' | 'queued' = 'staged'): FollowUpQueueItem => ({
    id,
    messageId: `msg_${id}`,
    content: `content-${id}`,
    createdAt: 1,
    status,
});

class FakeAuthority {
    now = 1_000;
    loadFailures = 0;
    mutationFailures = 0;
    failAfterApply = false;
    readonly loadCalls: string[] = [];
    readonly mutationCalls: FollowUpQueueMutationRequest[] = [];
    private readonly snapshots = new Map<string, FollowUpQueueSnapshot>();
    private readonly ledger = new Map<string, FollowUpQueueMutationResult>();
    private messageCounter = 0;

    readonly api: FollowUpQueueAPI = {
        supported: true,
        load: async (sessionId) => {
            this.loadCalls.push(sessionId);
            if (this.loadFailures > 0) {
                this.loadFailures -= 1;
                throw new Error('offline');
            }
            return clone(this.getSnapshot(sessionId));
        },
        mutate: async (request) => {
            this.mutationCalls.push(clone(request));
            if (this.mutationFailures > 0) {
                this.mutationFailures -= 1;
                throw new Error('offline');
            }
            const ledgerKey = `${request.sessionId}\n${request.clientMutationId}`;
            const known = this.ledger.get(ledgerKey);
            if (known) {
                return {
                    ...clone(known),
                    snapshot: clone(this.getSnapshot(request.sessionId)),
                    deduplicated: true,
                };
            }
            const current = this.getSnapshot(request.sessionId);
            if (request.baseRevision !== current.revision) {
                throw new FollowUpQueueConflictError(clone(current));
            }
            const applied = applyFollowUpQueueOperation(current, request.operation, {
                now: this.now,
                claimExpiresAt: this.now + FOLLOW_UP_QUEUE_CLAIM_TTL_MS,
                messageId: `msg_${String(++this.messageCounter).padStart(12, '0')}${'H'.repeat(14)}`,
            });
            const snapshot = {
                ...applied.snapshot,
                revision: applied.applied ? current.revision + 1 : current.revision,
            };
            this.snapshots.set(request.sessionId, snapshot);
            const result: FollowUpQueueMutationResult = {
                snapshot: clone(snapshot),
                applied: applied.applied,
                deduplicated: false,
                mutationRevision: applied.applied ? snapshot.revision : null,
            };
            this.ledger.set(ledgerKey, clone(result));
            if (this.failAfterApply) {
                this.failAfterApply = false;
                throw new Error('response lost');
            }
            return result;
        },
    };

    getSnapshot(sessionId: string): FollowUpQueueSnapshot {
        return this.snapshots.get(sessionId) ?? {
            scopeToken: scopeTokenFor(sessionId),
            revision: 0,
            items: [],
        };
    }

    reset(sessionId: string): void {
        this.snapshots.delete(sessionId);
    }

    async mutate(sessionId: string, operation: FollowUpQueueOperation, mutationId = `seed-${this.mutationCalls.length}`): Promise<void> {
        await this.api.mutate({
            sessionId,
            baseRevision: this.getSnapshot(sessionId).revision,
            clientMutationId: mutationId,
            operation,
        });
    }
}

const createClient = (options: {
    authority?: FakeAuthority;
    api?: FollowUpQueueAPI;
    storage?: Storage;
    client?: string;
    getRuntimeKey?: () => string;
    now?: () => number;
    useDefaultMessageId?: boolean;
    verifyStorageWrite?: (key: string, value: string) => boolean;
    runWithLocalLock?: <T>(key: string, task: () => Promise<T> | T) => Promise<T>;
    hasCrossContextLocalLock?: () => boolean;
    subscribeStorage?: (listener: (key: string, newValue: string | null) => void) => () => void;
} = {}) => {
    const authority = options.authority ?? new FakeAuthority();
    const storage = options.storage ?? createMemoryStorage();
    const client = options.client ?? 'client';
    let itemCounter = 0;
    let messageCounter = 0;
    let mutationCounter = 0;
    let claimCounter = 0;
    const store = createMessageQueueStore({
        getAPI: () => options.api ?? authority.api,
        getRuntimeKey: options.getRuntimeKey ?? (() => 'runtime-a'),
        storage,
        now: options.now ?? (() => authority.now),
        createItemId: () => `${client}-item-${++itemCounter}`,
        ...(!options.useDefaultMessageId ? {
            createMessageId: () => `msg_${String(++messageCounter).padStart(12, '0')}${client.replace(/[^a-z0-9]/gi, 'A').padEnd(14, 'A').slice(0, 14)}`,
        } : {}),
        createMutationId: () => `${client}-mutation-${++mutationCounter}`,
        createClaimId: () => `${client}-claim-${++claimCounter}`,
        verifyStorageWrite: options.verifyStorageWrite ?? (() => true),
        ...(options.runWithLocalLock ? { runWithLocalLock: options.runWithLocalLock } : {}),
        ...(options.hasCrossContextLocalLock ? {
            hasCrossContextLocalLock: options.hasCrossContextLocalLock,
        } : {}),
        ...(options.subscribeStorage ? { subscribeStorage: options.subscribeStorage } : {}),
        schedule: (callback) => queueMicrotask(callback),
        scheduleRetry: () => () => {},
    });
    return { authority, storage, store };
};

const watchAndInitialize = async (
    store: ReturnType<typeof createMessageQueueStore>,
    sessionId: MessageQueueIdentity,
): Promise<() => void> => {
    const unwatch = store.getState().watchSession(sessionId);
    await store.getState().initialize();
    return unwatch;
};

describe('host-authoritative follow-up queue client', () => {
    test('supports add, status, reorder, delete, deferred message IDs, and attachment round trips', async () => {
        const { authority, store } = createClient({ useDefaultMessageId: true });
        await watchAndInitialize(store, 'session-one');
        const attachment = {
            id: 'attachment-one',
            file: new File(['payload'], 'a.txt', { type: 'text/plain' }),
            dataUrl: 'data:text/plain;base64,cGF5bG9hZA==',
            mimeType: 'text/plain',
            filename: 'a.txt',
            size: 7,
            source: 'server' as const,
            serverPath: '/workspace/a.txt',
        };

        store.getState().addToQueue('session-one', {
            content: 'first',
            attachments: [attachment],
            additionalParts: [
                { text: 'synthetic context', synthetic: true },
                { text: 'plain additional text' },
            ],
            agentMentionName: 'review',
            sendConfig: { providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'high' },
        });
        store.getState().addToQueue('session-one', { content: 'second' });
        store.getState().addToQueue('session-one', { content: 'third' });
        await store.getState().initialize();

        const initial = store.getState().queuedMessages['session-one'];
        expect(initial).toHaveLength(3);
        expect(initial.every((entry) => entry.messageId === null)).toBe(true);
        expect(initial[0].attachments?.[0].dataUrl).toBe(attachment.dataUrl);
        expect(initial[0].attachments?.[0].filename).toBe(attachment.filename);
        expect(initial[0].attachments?.[0].serverPath).toBe(attachment.serverPath);
        expect(initial[0].attachments?.[0].file).toBeInstanceOf(File);
        expect(initial[0].sendConfig).toEqual({
            providerID: 'provider',
            modelID: 'model',
            agent: 'agent',
            variant: 'high',
        });
        expect(initial[0].additionalParts).toEqual([
            { text: 'synthetic context', synthetic: true },
            { text: 'plain additional text' },
        ]);
        expect(initial[0].agentMentionName).toBe('review');
        expect(authority.getSnapshot('session-one').items[0].additionalParts).toEqual(initial[0].additionalParts);
        expect(authority.getSnapshot('session-one').items[0].agentMentionName).toBe('review');
        expect('file' in (authority.getSnapshot('session-one').items[0].attachments?.[0] ?? {})).toBe(false);

        store.getState().setQueuedStatus('session-one', initial[1].id, 'queued');
        await store.getState().initialize();
        expect(store.getState().queuedMessages['session-one'][1].status).toBe('queued');

        store.getState().reorderQueue('session-one', initial[0].id, initial[2].id);
        await store.getState().initialize();
        expect(store.getState().queuedMessages['session-one'].map((entry) => entry.content)).toEqual([
            'second',
            'third',
            'first',
        ]);

        store.getState().removeFromQueue('session-one', initial[2].id);
        await store.getState().initialize();
        expect(store.getState().queuedMessages['session-one'].map((entry) => entry.content)).toEqual(['second', 'first']);
    });

    test('assigns an OpenCode message ID at first claim and reuses it after release', async () => {
        const { store } = createClient();
        await watchAndInitialize(store, 'session-claim-id');
        const queued = await store.getState().addToQueue('session-claim-id', {
            content: 'send after idle',
            status: 'queued',
        });
        expect(queued.messageId).toBeNull();

        const first = await store.getState().claim('session-claim-id', queued.id, 'auto');
        expect(/^msg_[\da-f]{12}[0-9A-Za-z]{14}$/.test(first?.item.messageId ?? '')).toBe(true);
        const assignedMessageId = first?.item.messageId;
        expect(await store.getState().release(
            'session-claim-id',
            queued.id,
            first!.claimId,
            'staged',
        )).toBe(true);

        const second = await store.getState().claim('session-claim-id', queued.id, 'manual');
        expect(second?.item.messageId).toBe(assignedMessageId);
    });

    test('propagates a mobile add to a desktop client through a targeted revision hint', async () => {
        const authority = new FakeAuthority();
        const mobile = createClient({ authority, client: 'mobile' }).store;
        const desktop = createClient({ authority, client: 'desktop' }).store;
        await watchAndInitialize(mobile, 'session-one');
        await watchAndInitialize(desktop, 'session-one');
        await watchAndInitialize(desktop, 'session-two');
        authority.loadCalls.length = 0;

        mobile.getState().addToQueue('session-one', { content: 'from mobile' });
        await mobile.getState().initialize();
        const snapshot = authority.getSnapshot('session-one');
        desktop.getState().handleRevisionHint(snapshot.scopeToken, snapshot.revision, {
            runtimeKey: desktop.getState().runtimeKey,
            generation: desktop.getState().generation,
        });
        await flush();

        expect(desktop.getState().queuedMessages['session-one'][0].content).toBe('from mobile');
        expect(authority.loadCalls).toEqual(['session-one']);
    });

    test('queues a revision hint that arrives before the first authoritative load finishes', async () => {
        const authority = new FakeAuthority();
        const initial = clone(authority.getSnapshot('session-one'));
        let resolveInitial!: (snapshot: FollowUpQueueSnapshot) => void;
        const initialLoad = new Promise<FollowUpQueueSnapshot>((resolve) => {
            resolveInitial = resolve;
        });
        let loadCount = 0;
        const api: FollowUpQueueAPI = {
            supported: true,
            load: async () => {
                loadCount += 1;
                return loadCount === 1 ? initialLoad : clone(authority.getSnapshot('session-one'));
            },
            mutate: authority.api.mutate,
        };
        const { store } = createClient({ authority, api, client: 'early-hint' });
        store.getState().watchSession('session-one');
        const initialize = store.getState().initialize();

        await authority.mutate('session-one', { type: 'add', item: item('remote-during-load') });
        const latest = authority.getSnapshot('session-one');
        store.getState().handleRevisionHint(latest.scopeToken, latest.revision, {
            runtimeKey: store.getState().runtimeKey,
            generation: store.getState().generation,
        });
        resolveInitial(initial);
        await initialize;
        await flush();
        await flush();

        expect(loadCount).toBe(2);
        expect(store.getState().queuedMessages['session-one'].map((entry) => entry.id)).toEqual([
            'remote-during-load',
        ]);
    });

    test('keeps the previous and optimistic projections when authoritative loads fail', async () => {
        const authority = new FakeAuthority();
        await authority.mutate('session-one', { type: 'add', item: item('existing') });
        const first = createClient({ authority, client: 'first' }).store;
        await watchAndInitialize(first, 'session-one');
        authority.loadFailures = 1;
        await first.getState().refreshSession('session-one');
        expect(first.getState().queuedMessages['session-one'].map((entry) => entry.id)).toEqual(['existing']);

        const failingAuthority = new FakeAuthority();
        failingAuthority.loadFailures = 2;
        const second = createClient({ authority: failingAuthority, client: 'second' }).store;
        second.getState().addToQueue('session-two', { content: 'offline optimistic' });
        await watchAndInitialize(second, 'session-two');
        expect(second.getState().queuedMessages['session-two'][0].content).toBe('offline optimistic');
        expect(failingAuthority.getSnapshot('session-two').items).toEqual([]);
    });

    test('persists concurrent tab outboxes as independent mutation records', async () => {
        const storage = createMemoryStorage();
        const offlineApi: FollowUpQueueAPI = {
            supported: true,
            load: async () => { throw new Error('offline'); },
            mutate: async () => { throw new Error('offline'); },
        };
        const first = createClient({ api: offlineApi, storage, client: 'tab-first' }).store;
        const second = createClient({ api: offlineApi, storage, client: 'tab-second' }).store;
        await watchAndInitialize(first, 'session-tabs');
        await watchAndInitialize(second, 'session-tabs');
        void first.getState().addToQueue('session-tabs', { content: 'first tab' }).catch(() => {});
        void second.getState().addToQueue('session-tabs', { content: 'second tab' }).catch(() => {});
        await flush();
        expect(Array.from({ length: storage.length }, (_, index) => storage.key(index))
            .filter((key) => key?.startsWith('oc.followUpQueue.outbox.v1'))).toHaveLength(2);

        const authority = new FakeAuthority();
        const restarted = createClient({ authority, storage, client: 'tab-restart' }).store;
        await watchAndInitialize(restarted, 'session-tabs');
        await flush();

        expect(authority.getSnapshot('session-tabs').items.map((entry) => entry.content).sort()).toEqual([
            'first tab',
            'second tab',
        ]);
        expect(Array.from({ length: storage.length }, (_, index) => storage.key(index))
            .filter((key) => key?.startsWith('oc.followUpQueue.outbox.v1'))).toEqual([]);
    });

    test('migrates an embedded lane outbox before clearing the legacy pending array', async () => {
        const storage = createMemoryStorage();
        storage.setItem('oc.followUpQueue.v1:runtime-a:session-embedded', JSON.stringify({
            version: 1,
            baseSnapshot: null,
            localItems: [],
            localRevision: 0,
            legacyItemIds: [],
            pending: [{
                clientMutationId: 'embedded-mutation',
                operation: { type: 'add', item: item('embedded') },
                projectionNow: 1,
            }],
        }));
        const authority = new FakeAuthority();
        const { store } = createClient({ authority, storage, client: 'embedded-restart' });

        await watchAndInitialize(store, 'session-embedded');

        expect(authority.getSnapshot('session-embedded').items.map((entry) => entry.id)).toEqual(['embedded']);
        const lane = JSON.parse(storage.getItem('oc.followUpQueue.v1:runtime-a:session-embedded') ?? '{}');
        expect(lane.pending).toEqual([]);
        expect(Array.from({ length: storage.length }, (_, index) => storage.key(index))
            .filter((key) => key?.startsWith('oc.followUpQueue.outbox.v1'))).toEqual([]);
    });

    test('does not accept a follow-up when its local outbox cannot be persisted durably', async () => {
        const storage = createMemoryStorage();
        const { store } = createClient({
            storage,
            verifyStorageWrite: (key) => {
                storage.removeItem(key);
                return false;
            },
        });
        await watchAndInitialize(store, 'session-one');

        expect(() => store.getState().addToQueue('session-one', { content: 'must remain in composer' }))
            .toThrow('Failed to persist follow-up queue operation');
        expect(store.getState().queuedMessages['session-one'] ?? []).toEqual([]);
    });

    test('restores the previous durable lane when a later outbox write cannot be verified', async () => {
        const storage = createMemoryStorage();
        let verifyWrites = true;
        let previous: string | null = null;
        const { store } = createClient({
            storage,
            verifyStorageWrite: (key) => {
                if (verifyWrites) return true;
                if (previous === null) storage.removeItem(key);
                else storage.setItem(key, previous);
                return false;
            },
        });
        await watchAndInitialize(store, 'session-one');
        const laneKey = Array.from({ length: storage.length }, (_, index) => storage.key(index))
            .find((key): key is string => Boolean(key?.includes('session-one')));
        expect(laneKey).toBeDefined();
        previous = storage.getItem(laneKey!);

        verifyWrites = false;
        expect(() => store.getState().addToQueue('session-one', { content: 'must not replace the outbox' }))
            .toThrow('Failed to persist follow-up queue operation');
        expect(storage.getItem(laneKey!)).toBe(previous);
    });

    test('accepts an authoritative revision reset on first load and terminal reset hints', async () => {
        const storage = createMemoryStorage();
        const originalAuthority = new FakeAuthority();
        await originalAuthority.mutate('session-one', { type: 'add', item: item('old-authority') });
        const original = createClient({ authority: originalAuthority, storage, client: 'original' }).store;
        await watchAndInitialize(original, 'session-one');
        expect(original.getState().queuedMessages['session-one']).toHaveLength(1);

        const replacementAuthority = new FakeAuthority();
        const replacement = createClient({ authority: replacementAuthority, storage, client: 'replacement' }).store;
        await watchAndInitialize(replacement, 'session-one');
        expect(replacement.getState().queuedMessages['session-one']).toEqual([]);

        await replacementAuthority.mutate('session-one', { type: 'add', item: item('before-terminal-reset') });
        await replacement.getState().refreshSession('session-one');
        replacementAuthority.reset('session-one');
        replacement.getState().handleRevisionHint(scopeTokenFor('session-one'), 2);
        replacement.getState().handleRevisionHint(scopeTokenFor('session-one'), 0, undefined, true);
        await flush();
        expect(replacement.getState().queuedMessages['session-one']).toEqual([]);
    });

    test('drops deleted session lanes from memory and runtime-scoped storage', async () => {
        const storage = createMemoryStorage();
        const { store } = createClient({ storage });
        await watchAndInitialize(store, 'session-one');
        await store.getState().addToQueue('session-one', { content: 'delete with session' });
        expect(store.getState().queuedMessages['session-one']).toHaveLength(1);

        store.getState().dropSession('session-one');

        expect(store.getState().queuedMessages['session-one']).toBe(undefined);
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
        expect(keys.some((key) => key?.includes('session-one') && !key.endsWith(':deleted'))).toBe(false);
        expect(keys.some((key) => key?.includes('session-one') && key.endsWith(':deleted'))).toBe(true);
    });

    test('applies delayed deletion to a newer transport generation of the same runtime', async () => {
        const storage = createMemoryStorage();
        const { store } = createClient({ storage });
        await watchAndInitialize(store, 'session-one');
        await store.getState().addToQueue('session-one', { content: 'delete after transport switch' });
        const oldContext = {
            runtimeKey: store.getState().runtimeKey,
            generation: store.getState().generation,
        };

        store.getState().switchRuntime(oldContext.runtimeKey);
        expect(store.getState().queuedMessages['session-one']).toHaveLength(1);
        store.getState().dropSession('session-one', oldContext);

        expect(store.getState().queuedMessages['session-one']).toBe(undefined);
    });

    test('removes the persisted lane and retries its tombstone after an initial quota failure', async () => {
        const backing = createMemoryStorage();
        let tombstoneAttempts = 0;
        const storage = {
            getItem: (key: string) => backing.getItem(key),
            setItem: (key: string, value: string) => {
                if (key.endsWith(':deleted') && tombstoneAttempts++ === 0) {
                    throw new DOMException('Quota exceeded', 'QuotaExceededError');
                }
                backing.setItem(key, value);
            },
            removeItem: (key: string) => backing.removeItem(key),
            clear: () => backing.clear(),
            key: (index: number) => backing.key(index),
            get length() {
                return backing.length;
            },
        } as Storage;
        const { store } = createClient({ storage });
        await watchAndInitialize(store, 'session-quota-delete');
        await store.getState().addToQueue('session-quota-delete', { content: 'remove despite quota' });

        store.getState().dropSession('session-quota-delete');

        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
        expect(keys.some((key) => key?.includes('session-quota-delete') && !key.endsWith(':deleted'))).toBe(false);
        expect(keys.some((key) => key?.includes('session-quota-delete') && key.endsWith(':deleted'))).toBe(true);
    });

    test('removes an unmaterialized legacy queue when its session is deleted', () => {
        const storage = createMemoryStorage();
        storage.setItem('message-queue-store', JSON.stringify({
            state: {
                queuedMessages: {
                    'session-legacy-delete': [{ id: 'legacy-item', content: 'legacy' }],
                },
            },
        }));
        const { store } = createClient({ storage, getRuntimeKey: () => 'runtime-startup' });

        store.getState().dropSession('session-legacy-delete', { runtimeKey: 'runtime-other', generation: 0 });
        expect(JSON.parse(storage.getItem('message-queue-store') ?? '{}')
            .state.queuedMessages['session-legacy-delete']).toHaveLength(1);
        store.getState().dropSession('session-legacy-delete');

        const legacy = JSON.parse(storage.getItem('message-queue-store') ?? '{}');
        expect(legacy.state.queuedMessages['session-legacy-delete']).toBe(undefined);
    });

    test('serializes local fallback claims across clients and disables unsafe automatic claims', async () => {
        const storage = createMemoryStorage();
        const unsupported: FollowUpQueueAPI = {
            supported: false,
            load: async () => null,
            mutate: async () => null,
        };
        let lockTail = Promise.resolve();
        const runWithLocalLock = <T>(_key: string, task: () => Promise<T> | T): Promise<T> => {
            const result = lockTail.then(task, task);
            lockTail = result.then(() => undefined, () => undefined);
            return result;
        };
        const first = createClient({
            api: unsupported,
            storage,
            client: 'local-first',
            runWithLocalLock,
            hasCrossContextLocalLock: () => true,
        }).store;
        const second = createClient({
            api: unsupported,
            storage,
            client: 'local-second',
            runWithLocalLock,
            hasCrossContextLocalLock: () => true,
        }).store;
        await watchAndInitialize(first, 'session-local');
        await watchAndInitialize(second, 'session-local');
        const queued = await first.getState().addToQueue('session-local', {
            content: 'local claim',
            status: 'queued',
        });

        const claims = await Promise.all([
            first.getState().claim('session-local', queued.id, 'auto'),
            second.getState().claim('session-local', queued.id, 'auto'),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);

        const unsafe = createClient({ api: unsupported, storage: createMemoryStorage(), client: 'unsafe' }).store;
        await watchAndInitialize(unsafe, 'session-unsafe');
        const unsafeItem = await unsafe.getState().addToQueue('session-unsafe', {
            content: 'manual only',
            status: 'queued',
        });
        expect(await unsafe.getState().claim('session-unsafe', unsafeItem.id, 'auto')).toBeNull();
    });

    test('materializes every tab outbox under one lock when host support is unavailable', async () => {
        const storage = createMemoryStorage();
        const unsupportedResult = deferred<null>();
        const probingApi: FollowUpQueueAPI = {
            supported: true,
            load: async () => unsupportedResult.promise,
            mutate: async () => null,
        };
        let lockTail = Promise.resolve();
        const runWithLocalLock = <T>(_key: string, task: () => Promise<T> | T): Promise<T> => {
            const result = lockTail.then(task, task);
            lockTail = result.then(() => undefined, () => undefined);
            return result;
        };
        const first = createClient({
            api: probingApi,
            storage,
            client: 'fallback-first',
            runWithLocalLock,
            hasCrossContextLocalLock: () => true,
        }).store;
        const second = createClient({
            api: probingApi,
            storage,
            client: 'fallback-second',
            runWithLocalLock,
            hasCrossContextLocalLock: () => true,
        }).store;
        first.getState().watchSession('session-fallback-tabs');
        second.getState().watchSession('session-fallback-tabs');
        const firstAdd = first.getState().addToQueue('session-fallback-tabs', { content: 'fallback first' });
        const secondAdd = second.getState().addToQueue('session-fallback-tabs', { content: 'fallback second' });

        unsupportedResult.resolve(null);
        await Promise.all([firstAdd, secondAdd]);
        const unsupported: FollowUpQueueAPI = {
            supported: false,
            load: async () => null,
            mutate: async () => null,
        };
        const restarted = createClient({
            api: unsupported,
            storage,
            client: 'fallback-restart',
            runWithLocalLock,
            hasCrossContextLocalLock: () => true,
        }).store;
        await watchAndInitialize(restarted, 'session-fallback-tabs');

        expect(restarted.getState().queuedMessages['session-fallback-tabs'].map((entry) => entry.content).sort())
            .toEqual(['fallback first', 'fallback second']);
        expect(Array.from({ length: storage.length }, (_, index) => storage.key(index))
            .filter((key) => key?.startsWith('oc.followUpQueue.outbox.v1'))).toEqual([]);
    });

    test('rejects a deterministic queue limit before creating an outbox entry', async () => {
        const authority = new FakeAuthority();
        for (let index = 0; index < 256; index += 1) {
            await authority.mutate('session-one', {
                type: 'add',
                item: item(`limit-${index}`),
            });
        }
        const { store } = createClient({ authority });
        await watchAndInitialize(store, 'session-one');

        expect(() => store.getState().addToQueue('session-one', { content: 'one too many' })).toThrow();
        expect(store.getState().queuedMessages['session-one']).toHaveLength(256);
    });

    test('installs the latest conflict snapshot and replays the same semantic intent', async () => {
        const authority = new FakeAuthority();
        const { store } = createClient({ authority, client: 'conflict' });
        await watchAndInitialize(store, 'session-one');
        await authority.mutate('session-one', { type: 'add', item: item('remote') }, 'remote-add');

        store.getState().addToQueue('session-one', { content: 'local' });
        await store.getState().initialize();

        expect(store.getState().queuedMessages['session-one'].map((entry) => entry.id)).toEqual([
            'remote',
            'conflict-item-1',
        ]);
        const clientCalls = authority.mutationCalls.filter((call) => call.clientMutationId === 'conflict-mutation-1');
        expect(clientCalls).toHaveLength(2);
        expect(clientCalls[0].operation).toEqual(clientCalls[1].operation);
        expect(clientCalls[0].baseRevision).toBe(0);
        expect(clientCalls[1].baseRevision).toBe(1);
    });

    test('drops a late load after a runtime switch and restores runtime-scoped caches', async () => {
        let runtimeKey = 'runtime-a';
        let resolveRuntimeA!: (snapshot: FollowUpQueueSnapshot) => void;
        const runtimeASnapshot = new Promise<FollowUpQueueSnapshot>((resolve) => {
            resolveRuntimeA = resolve;
        });
        const api: FollowUpQueueAPI = {
            supported: true,
            load: async (_sessionId, options) => {
                if (options?.expectedRuntimeKey === 'runtime-a') return runtimeASnapshot;
                return { scopeToken: 'b'.repeat(64), revision: 1, items: [item('runtime-b-item')] };
            },
            mutate: async () => null,
        };
        const storage = createMemoryStorage();
        const { store } = createClient({ api, storage, getRuntimeKey: () => runtimeKey });
        const unwatch = store.getState().watchSession('session-one');
        const firstLoad = store.getState().initialize();

        runtimeKey = 'runtime-b';
        store.getState().switchRuntime(runtimeKey);
        await store.getState().refreshSession('session-one');
        resolveRuntimeA({ scopeToken: 'a'.repeat(64), revision: 1, items: [item('runtime-a-item')] });
        await firstLoad;

        expect(store.getState().runtimeKey).toBe('runtime-b');
        expect(store.getState().queuedMessages['session-one'].map((entry) => entry.id)).toEqual(['runtime-b-item']);
        unwatch();
    });

    test('replays a persisted outbox with the same mutation ID after restart', async () => {
        const authority = new FakeAuthority();
        const storage = createMemoryStorage();
        const first = createClient({ authority, storage, client: 'offline' }).store;
        await watchAndInitialize(first, 'session-one');
        authority.failAfterApply = true;

        first.getState().addToQueue('session-one', { content: 'durable outbox' });
        await first.getState().initialize();
        expect(authority.getSnapshot('session-one').items).toHaveLength(1);

        const second = createClient({ authority, storage, client: 'restart' }).store;
        await watchAndInitialize(second, 'session-one');

        expect(second.getState().queuedMessages['session-one']).toHaveLength(1);
        const replayed = authority.mutationCalls.filter((call) => call.clientMutationId === 'offline-mutation-1');
        expect(replayed).toHaveLength(2);
        expect(replayed[1].operation).toEqual(replayed[0].operation);
        expect(authority.getSnapshot('session-one').items).toHaveLength(1);
    });

    test('resumes a transiently failed outbox when transport becomes ready', async () => {
        const authority = new FakeAuthority();
        const { store } = createClient({ authority, client: 'transport' });
        await watchAndInitialize(store, 'session-one');
        authority.mutationFailures = 1;
        store.getState().addToQueue('session-one', { content: 'retry on reconnect' });
        await store.getState().initialize();
        expect(authority.getSnapshot('session-one').items).toEqual([]);

        const context = { runtimeKey: store.getState().runtimeKey, generation: store.getState().generation };
        store.getState().handleTransportReady(context);
        await store.getState().refreshSession('session-one');

        expect(authority.getSnapshot('session-one').items[0].content).toBe('retry on reconnect');
    });

    test('allows only one client claim, supports expiry replacement, release, and completion', async () => {
        const authority = new FakeAuthority();
        await authority.mutate('session-one', { type: 'add', item: item('claimed', 'queued') });
        const first = createClient({ authority, client: 'first' }).store;
        const second = createClient({ authority, client: 'second' }).store;
        await watchAndInitialize(first, 'session-one');
        await watchAndInitialize(second, 'session-one');

        const [firstClaim, secondClaim] = await Promise.all([
            first.getState().claim('session-one', 'claimed', 'auto'),
            second.getState().claim('session-one', 'claimed', 'auto'),
        ]);
        const winner = firstClaim ? first : second;
        const loser = firstClaim ? second : first;
        const winningClaim = firstClaim ?? secondClaim;
        expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
        expect(winningClaim).not.toBeNull();

        expect(await winner.getState().release('session-one', 'claimed', winningClaim!.claimId, 'staged')).toBe(true);
        expect(authority.getSnapshot('session-one').items[0].status).toBe('staged');
        expect(authority.getSnapshot('session-one').items[0].claim).toBe(undefined);

        winner.getState().setQueuedStatus('session-one', 'claimed', 'queued');
        await winner.getState().initialize();
        await loser.getState().refreshSession('session-one');
        const expiringClaim = await winner.getState().claim('session-one', 'claimed', 'auto');
        expect(expiringClaim).not.toBeNull();
        authority.now += FOLLOW_UP_QUEUE_CLAIM_TTL_MS + 1;
        await loser.getState().refreshSession('session-one');
        const replacement = await loser.getState().claim('session-one', 'claimed', 'manual');
        expect(replacement).not.toBeNull();
        expect(replacement?.claimId).not.toBe(expiringClaim?.claimId);

        expect(await loser.getState().complete('session-one', 'claimed', replacement!.claimId)).toBe(true);
        expect(authority.getSnapshot('session-one').items).toEqual([]);
    });

    test('does not complete an old claim against a newly selected runtime', async () => {
        let runtimeKey = 'runtime-a';
        const authority = new FakeAuthority();
        await authority.mutate('session-one', { type: 'add', item: item('runtime-claim', 'queued') });
        const { store } = createClient({ authority, getRuntimeKey: () => runtimeKey });
        await watchAndInitialize(store, 'session-one');
        const claim = await store.getState().claim('session-one', 'runtime-claim', 'auto');
        expect(claim).not.toBeNull();
        const callsBeforeSwitch = authority.mutationCalls.length;

        runtimeKey = 'runtime-b';
        store.getState().switchRuntime(runtimeKey);

        expect(await store.getState().complete(
            'session-one',
            'runtime-claim',
            claim!.claimId,
            claim!.context,
        )).toBe(false);
        expect(authority.mutationCalls).toHaveLength(callsBeforeSwitch);
        expect(authority.getSnapshot('session-one').items[0].claim?.id).toBe(claim?.claimId);
    });

    test('drops a host-rejected add without generating an infinite re-add loop', async () => {
        let mutationCalls = 0;
        const emptySnapshot = { scopeToken: 'a'.repeat(64), revision: 1, items: [] };
        const terminalAPI: FollowUpQueueAPI = {
            supported: true,
            load: async () => clone(emptySnapshot),
            mutate: async () => {
                mutationCalls += 1;
                return {
                    snapshot: clone(emptySnapshot),
                    applied: false,
                    deduplicated: false,
                    mutationRevision: null,
                };
            },
        };
        const { store } = createClient({ api: terminalAPI });
        await watchAndInitialize(store, 'session-one');

        await expect(store.getState().addToQueue('session-one', { content: 'rejected' })).rejects.toThrow();
        await store.getState().initialize();

        expect(mutationCalls).toBe(1);
        expect(store.getState().queuedMessages['session-one'] ?? []).toEqual([]);
    });

    test('uses a runtime-scoped device-local fallback when the capability is unsupported', async () => {
        let runtimeKey = 'runtime-a';
        const unsupported: FollowUpQueueAPI = {
            supported: false,
            load: async () => null,
            mutate: async () => null,
        };
        const storage = createMemoryStorage();
        const { store } = createClient({ api: unsupported, storage, getRuntimeKey: () => runtimeKey });
        await watchAndInitialize(store, 'session-one');
        store.getState().addToQueue('session-one', {
            content: 'runtime a local',
            additionalParts: [{ text: 'runtime a context', synthetic: true }],
            agentMentionName: 'local-agent',
        });
        await store.getState().initialize();
        expect(store.getState().supported).toBe(false);
        expect(store.getState().queuedMessages['session-one'][0].content).toBe('runtime a local');

        runtimeKey = 'runtime-b';
        store.getState().switchRuntime(runtimeKey);
        expect(store.getState().queuedMessages['session-one'] ?? []).toEqual([]);

        runtimeKey = 'runtime-a';
        store.getState().switchRuntime(runtimeKey);
        expect(store.getState().queuedMessages['session-one'][0].content).toBe('runtime a local');
        expect(store.getState().queuedMessages['session-one'][0].additionalParts).toEqual([
            { text: 'runtime a context', synthetic: true },
        ]);
        expect(store.getState().queuedMessages['session-one'][0].agentMentionName).toBe('local-agent');
    });

    test('migrates the concrete unscoped queue only for the startup runtime and deletes it after host confirmation', async () => {
        const authority = new FakeAuthority();
        const storage = createMemoryStorage();
        storage.setItem('message-queue-store', JSON.stringify({
            state: {
                queuedMessages: {
                    'session-one': [{
                        id: 'legacy-item',
                        content: 'legacy content',
                        createdAt: 10,
                        status: 'queued',
                        attachments: [{
                            id: 'legacy-attachment',
                            file: {},
                            dataUrl: 'data:text/plain;base64,bGVnYWN5',
                            mimeType: 'text/plain',
                            filename: 'legacy.txt',
                            size: 6,
                            source: 'local',
                        }],
                    }],
                },
                followUpBehavior: 'queue',
            },
            version: 2,
        }));
        authority.mutationFailures = 1;
        const first = createClient({ authority, storage, client: 'migration' }).store;
        await watchAndInitialize(first, 'session-one');
        expect(JSON.parse(storage.getItem('message-queue-store') ?? '{}').state.queuedMessages['session-one']).toHaveLength(1);

        const restarted = createClient({ authority, storage, client: 'migration-restart' }).store;
        await watchAndInitialize(restarted, 'session-one');
        const migrated = authority.getSnapshot('session-one').items[0];
        expect(migrated.id).toBe('legacy-item');
        expect(migrated.messageId).not.toBeNull();
        expect(migrated.messageId?.startsWith('msg_')).toBe(true);
        expect('file' in (migrated.attachments?.[0] ?? {})).toBe(false);
        expect(JSON.parse(storage.getItem('message-queue-store') ?? '{}').state.queuedMessages['session-one']).toBe(undefined);
    });

    test('orders a legacy add before an edit or delete issued during initial bootstrap', async () => {
        const authority = new FakeAuthority();
        const storage = createMemoryStorage();
        storage.setItem('message-queue-store', JSON.stringify({
            state: {
                queuedMessages: {
                    'session-one': [{
                        id: 'legacy-race',
                        content: 'legacy race',
                        createdAt: 10,
                        status: 'staged',
                    }],
                },
            },
            version: 2,
        }));
        let resolveLoad!: (snapshot: FollowUpQueueSnapshot) => void;
        const initialLoad = new Promise<FollowUpQueueSnapshot>((resolve) => {
            resolveLoad = resolve;
        });
        const api: FollowUpQueueAPI = {
            supported: true,
            load: async () => initialLoad,
            mutate: authority.api.mutate,
        };
        const { store } = createClient({ api, authority, storage, client: 'legacy-race' });
        const unwatch = store.getState().watchSession('session-one');
        const initialize = store.getState().initialize();
        expect(store.getState().popToInput('session-one', 'legacy-race')?.content).toBe('legacy race');

        resolveLoad(clone(authority.getSnapshot('session-one')));
        await initialize;
        await flush();

        expect(authority.mutationCalls.map((call) => call.operation.type)).toEqual(['add', 'remove']);
        expect(authority.getSnapshot('session-one').items).toEqual([]);
        unwatch();
    });
});

describe('OpenCode queue message identifier', () => {
    test('uses the Identifier.ascending message shape', () => {
        expect(/^msg_[\da-f]{12}[0-9A-Za-z]{14}$/.test(createOpenCodeIdentifier('msg'))).toBe(true);
    });
});

describe('message queue target ownership', () => {
    const unsupported: FollowUpQueueAPI = {
        supported: false,
        load: async () => null,
        mutate: async () => null,
    };

    test('isolates colliding session IDs by directory within one runtime', async () => {
        const storage = createMemoryStorage();
        const { store } = createClient({
            api: unsupported,
            storage,
            hasCrossContextLocalLock: () => true,
        });
        const first = createMessageQueueTarget('session-1', '/repo-a', 'runtime-a')!;
        const second = createMessageQueueTarget('session-1', '/repo-b', 'runtime-a')!;

        await store.getState().addToQueue(first, { content: 'from A' });
        await store.getState().addToQueue(second, { content: 'from B' });

        expect(store.getState().getQueueForTarget(first)[0]?.content).toBe('from A');
        expect(store.getState().getQueueForTarget(second)[0]?.content).toBe('from B');

        const restarted = createClient({
            api: unsupported,
            storage,
            hasCrossContextLocalLock: () => true,
        }).store;
        await watchAndInitialize(restarted, second);
        await watchAndInitialize(restarted, first);
        expect(restarted.getState().getQueueForTarget(first)[0]?.content).toBe('from A');
        expect(restarted.getState().getQueueForTarget(second)[0]?.content).toBe('from B');
    });

    test('round trips a composite queue key', () => {
        const target = createMessageQueueTarget('session-1', '/repo', 'runtime-a')!;
        expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target);
    });

    test('quarantines legacy session-only queues instead of assigning them to a target', () => {
        const migrated = migrateMessageQueueState({
            queuedMessages: {
                'session-1': [{ id: 'queued-1', content: 'legacy', createdAt: 1 }],
            },
        }, 1);

        expect(migrated.queuedMessages).toEqual({});
        expect(migrated.quarantinedLegacyMessages['session-1']?.[0]?.content).toBe('legacy');
    });
});
