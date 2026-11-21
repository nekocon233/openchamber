import { z } from 'zod';
import { contextPartMetadataSchema } from '@/lib/messages/contextParts';
import { getQueuedMessagePreview } from '@/lib/messages/queuedMessagePreview';
import { isNativeSessionId } from '@/lib/native-agents/ids';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { getRuntimeEndpointGeneration, RuntimeContextChangedError } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { createInputHistoryIdentity, createInputHistorySubmission, useInputHistoryStore } from './useInputHistoryStore';
import { createMessageQueueTarget, getMessageQueueKey, parseMessageQueueKey } from './messageQueueStore';
import type { MessageQueueTarget, NewQueuedMessage, QueuedContextPart, QueuedMessage, QueuedMessageGoal } from './messageQueueStore';
import type { FollowUpQueueSendConfig } from '@/lib/api/types';
import type { AttachedFile } from './types/sessionTypes';

const serverSendConfigSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    agent: z.string().optional(),
    variant: z.string().optional(),
});

const serverGoalSchema = z.object({
    objective: z.string().min(1).optional(),
    tokenBudget: z.number().int().positive().nullable(),
});

const serverAttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    source: z.enum(['local', 'server', 'vscode']),
    serverPath: z.string().optional(),
    agentPath: z.string().optional(),
    dataUrl: z.string().optional(),
});

const serverContextPartSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('context'),
        text: z.string(),
        metadata: contextPartMetadataSchema,
        instructions: z.string().optional(),
    }),
    z.object({ kind: z.literal('instruction'), text: z.string() }),
    z.object({ kind: z.literal('synthetic'), text: z.string() }),
]);

const serverItemBaseSchema = z.object({
    id: z.string().min(1),
    createdAt: z.number(),
    content: z.string(),
    text: z.string(),
    agentMention: z.string().optional(),
    attachments: z.array(serverAttachmentSchema),
    context: z.array(serverContextPartSchema).optional(),
    contextPreview: z.string().optional(),
    sendConfig: serverSendConfigSchema,
    goal: serverGoalSchema.optional(),
});

const scheduledTaskSchema = z.object({
    projectId: z.string().min(1), taskId: z.string().min(1),
});
const serverItemSchema = z.union([
    serverItemBaseSchema.extend({ scheduledTask: scheduledTaskSchema, sendConfig: serverSendConfigSchema.partial() }),
    serverItemBaseSchema,
]);

const serverSessionSchema = z.object({
    sessionId: z.string().min(1),
    directory: z.string(),
    items: z.array(serverItemSchema),
    sendingId: z.string().nullable(),
});

const serverSnapshotSchema = z.object({
    revision: z.number(),
    acceptsImports: z.boolean().optional(),
    sessions: z.array(serverSessionSchema),
});

const serverSessionResponseSchema = z.object({
    revision: z.number(),
    session: serverSessionSchema,
    itemId: z.string().optional(),
});

const serverTakeResponseSchema = serverSessionResponseSchema.extend({ item: serverItemSchema });
const serverTakeAllResponseSchema = serverSessionResponseSchema.extend({ items: z.array(serverItemSchema) });

type ServerQueueSession = z.infer<typeof serverSessionSchema>;
type ServerQueueItem = z.infer<typeof serverItemSchema>;
type ServerQueueAttachment = z.infer<typeof serverAttachmentSchema>;

const decodeDataUrl = (dataUrl: string): ArrayBuffer | null => {
    const commaIndex = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || commaIndex === -1) return null;
    const meta = dataUrl.slice(5, commaIndex);
    const payload = dataUrl.slice(commaIndex + 1);
    try {
        if (meta.endsWith(';base64')) {
            const binary = atob(payload);
            const buffer = new ArrayBuffer(binary.length);
            const bytes = new Uint8Array(buffer);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return buffer;
        }
        const encoded = new TextEncoder().encode(decodeURIComponent(payload));
        const buffer = new ArrayBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        return buffer;
    } catch {
        return null;
    }
};

const toAttachedFile = (attachment: ServerQueueAttachment): AttachedFile => {
    const dataUrl = attachment.dataUrl ?? '';
    const bytes = dataUrl ? decodeDataUrl(dataUrl) : null;
    const file: AttachedFile = {
        id: attachment.id,
        file: new File(bytes ? [bytes] : [], attachment.filename, { type: attachment.mimeType }),
        dataUrl,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        size: attachment.size,
        source: attachment.source,
    };
    if (attachment.serverPath) file.serverPath = attachment.serverPath;
    if (attachment.agentPath) file.agentPath = attachment.agentPath;
    return file;
};

const toQueuedMessage = (item: ServerQueueItem): QueuedMessage => {
    const message: QueuedMessage = {
        id: item.id,
        content: item.content,
        text: item.text,
        createdAt: item.createdAt,
        status: 'queued',
        messageId: null,
        deliveryOwner: 'server',
    };
    const selection = serverSendConfigSchema.safeParse(item.sendConfig);
    if (selection.success) message.sendConfig = selection.data;
    if (item.goal) message.goal = item.goal;
    if ('scheduledTask' in item) message.scheduledTask = item.scheduledTask;
    if (item.agentMention) message.agentMention = item.agentMention;
    if (item.attachments.length > 0) message.attachments = item.attachments.map(toAttachedFile);
    if (item.context) message.context = item.context;
    if (item.contextPreview) message.contextPreview = item.contextPreview;
    return message;
};

type ServerQueueAttachmentInput = Omit<ServerQueueAttachment, 'dataUrl'> & { dataUrl: string };

type ServerQueueItemInput = {
    content: string;
    text: string;
    agentMention?: string;
    attachments: ServerQueueAttachmentInput[];
    context: QueuedContextPart[];
    contextPreview?: string;
    sendConfig: FollowUpQueueSendConfig;
    goal?: QueuedMessageGoal;
};

type ServerQueueRequestBody =
    | { directory: string; item: ServerQueueItemInput; importKey?: string }
    | { itemIds: string[] };

const toServerAttachment = (attachment: AttachedFile): ServerQueueAttachmentInput => {
    const input: ServerQueueAttachmentInput = {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        source: attachment.source,
        dataUrl: attachment.dataUrl,
    };
    if (attachment.serverPath) input.serverPath = attachment.serverPath;
    if (attachment.agentPath) input.agentPath = attachment.agentPath;
    return input;
};

const toServerItemInput = (message: NewQueuedMessage, sendConfig: FollowUpQueueSendConfig): ServerQueueItemInput => {
    const item: ServerQueueItemInput = {
        content: message.content,
        text: message.text ?? message.content,
        attachments: (message.attachments ?? []).filter((file) => Boolean(file.dataUrl)).map(toServerAttachment),
        context: message.context ?? [],
        sendConfig,
    };
    if (message.agentMention) item.agentMention = message.agentMention;
    if (message.goal) item.goal = message.goal;
    const contextPreview = getQueuedMessagePreview({ content: '', context: message.context });
    if (contextPreview) item.contextPreview = contextPreview;
    return item;
};

const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RuntimeFetchOptions): Promise<T> => {
    const response = await runtimeFetch(path, init);
    if (!response.ok) {
        const error: Error & { status?: number } = new Error(`Message queue request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid message queue response');
    return parsed.data;
};

const jsonInit = (method: string, body?: ServerQueueRequestBody): RequestInit => {
    if (body === undefined) return { method };
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
};

const sessionPath = (sessionId: string) => `/api/message-queue/sessions/${encodeURIComponent(sessionId)}`;

const queueOwnerOf = (directory: string): string => spaceIdOfDirectory(directory) ?? '';


const readOwnerSnapshot = (owner: string, signal?: AbortSignal) => requestJson(
    serverSnapshotSchema,
    '/api/message-queue',
    { directory: owner ? `/spaces/${owner}` : null, signal },
);

export const readLegacyServerQueueItem = (value: unknown): QueuedMessage | null => {
    if (!value || typeof value !== 'object' || !('content' in value) || typeof value.content !== 'string') return null;
    if ('status' in value && value.status !== 'queued') return null;
    const result = serverItemSchema.safeParse({ text: value.content, attachments: [], ...value });
    return result.success ? toQueuedMessage(result.data) : null;
};

export const messageQueueUpdatedEventSchema = z.object({
    type: z.literal('openchamber:message-queue.updated'),
    properties: z.object({ revision: z.number(), session: serverSessionSchema, spaceId: z.string().optional() }),
});
export type MessageQueueUpdatedEvent = z.infer<typeof messageQueueUpdatedEventSchema>;
export type ServerQueueProjection = {
    queuedMessages: Record<string, QueuedMessage[]>;
    sendingIds: Record<string, string[]>;
};

export function createMessageQueueServer({
    read, update, runtimeKey, generateId, legacyItems,
}: {
    read: () => ServerQueueProjection;
    update: (change: (state: ServerQueueProjection) => ServerQueueProjection) => void;
    runtimeKey: () => string;
    generateId: () => string;
    legacyItems: (runtimeKey: string) => Array<{ target: MessageQueueTarget; item: QueuedMessage; retire: () => void }>;
}) {
    const snapshotRevisions = new Map<string, number>();
    const sessionRevisions = new Map<string, number>();
    let controller = new AbortController();
    let hydration: Promise<void> | null = null;
    let resyncRequested = false;
    let migration: Promise<void> | null = null;
    const sessionRevisionKey = (owner: string, sessionId: string) => JSON.stringify([owner, sessionId]);

    const capture = () => {
        const key = runtimeKey();
        const endpoint = getRuntimeEndpointGeneration();
        const signal = controller.signal;
        return {
            key, signal,
            valid: () => !signal.aborted && key === runtimeKey() && endpoint === getRuntimeEndpointGeneration(),
        };
    };

    const replaceSession = (
        state: ServerQueueProjection,
        key: string,
        owner: string,
        session: ServerQueueSession,
    ): ServerQueueProjection => {
        const next = { queuedMessages: { ...state.queuedMessages }, sendingIds: { ...state.sendingIds } };
        for (const queueKey of new Set([...Object.keys(next.queuedMessages), ...Object.keys(next.sendingIds)])) {
            const target = parseMessageQueueKey(queueKey);
            if (target?.runtimeKey !== key || target.sessionId !== session.sessionId || queueOwnerOf(target.directory) !== owner) continue;
            const retained = next.queuedMessages[queueKey]?.filter((message) => message.deliveryOwner !== 'server') ?? [];
            if (retained.length) next.queuedMessages[queueKey] = retained;
            else delete next.queuedMessages[queueKey];
            delete next.sendingIds[queueKey];
        }
        const target = createMessageQueueTarget(session.sessionId, session.directory, key);
        if (!target) return next;
        const queueKey = getMessageQueueKey(target);
        if (session.items.length) {
            next.queuedMessages[queueKey] = [...(next.queuedMessages[queueKey] ?? []), ...session.items.map(toQueuedMessage)];
        }
        if (session.sendingId) next.sendingIds[queueKey] = [session.sendingId];
        return next;
    };

    const applySession = (session: ServerQueueSession, revision: number, key: string, owner = '') => {
        if (key !== runtimeKey() || isNativeSessionId(session.sessionId) || queueOwnerOf(session.directory) !== owner) return;
        const revisionKey = sessionRevisionKey(owner, session.sessionId);
        if (revision < Math.max(snapshotRevisions.get(owner) ?? -1, sessionRevisions.get(revisionKey) ?? -1)) return;
        sessionRevisions.set(revisionKey, revision);
        update((state) => replaceSession(state, key, owner, session));
    };

    const applySnapshot = (snapshot: z.infer<typeof serverSnapshotSchema>, key: string, owner: string) => {
        if (snapshot.revision < (snapshotRevisions.get(owner) ?? -1)) return;
        snapshotRevisions.set(owner, snapshot.revision);
        const scopes = new Map(snapshot.sessions
            .filter((session) => !isNativeSessionId(session.sessionId) && queueOwnerOf(session.directory) === owner)
            .map((session) => [session.sessionId, session]));
        for (const keyInStore of new Set([...Object.keys(read().queuedMessages), ...Object.keys(read().sendingIds)])) {
            const target = parseMessageQueueKey(keyInStore);
            if (target?.runtimeKey !== key || queueOwnerOf(target.directory) !== owner || scopes.has(target.sessionId)) continue;
            if (!read().queuedMessages[keyInStore]?.some((message) => message.deliveryOwner === 'server') && !read().sendingIds[keyInStore]) continue;
            scopes.set(target.sessionId, { sessionId: target.sessionId, directory: target.directory, items: [], sendingId: null });
        }
        for (const session of scopes.values()) applySession(session, snapshot.revision, key, owner);
    };

    const refresh = async (owner = '') => {
        const context = capture();
        const snapshot = await readOwnerSnapshot(owner, AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]));
        if (context.valid()) applySnapshot(snapshot, context.key, owner);
    };

    const hydrate = (): Promise<void> => {
        if (hydration) return hydration;
        const context = capture();
        const request = (async () => {
            do {
                resyncRequested = false;
                try {
                    await migrateLegacy(context);
                    if (context.valid()) await refresh();
                } catch (error) {
                    if (!context.valid()) return;
                    if (!resyncRequested) throw error;
                }
            } while (resyncRequested && context.valid());
        })();
        hydration = request;
        const release = () => { if (hydration === request) hydration = null; };
        void request.then(release, release);
        return request;
    };

    const mutate = async <T extends z.infer<typeof serverSessionResponseSchema>>(
        target: MessageQueueTarget, path: string, init: RequestInit, schema: z.ZodType<T>,
    ): Promise<T> => {
        const context = capture();
        if (context.key !== target.runtimeKey) throw new RuntimeContextChangedError();
        const result = await requestJson(schema, path, {
            ...init, directory: target.directory,
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
        });
        if (context.valid()) applySession(result.session, result.revision, context.key, queueOwnerOf(target.directory));
        return result;
    };

    function migrateLegacy(context: ReturnType<typeof capture>): Promise<void> {
        if (migration) return migration;
        const request = (async () => {
            const candidates = legacyItems(context.key);
            if (!candidates.length) return;
            const support = new Map<string, boolean>();
            for (const { target, item, retire } of candidates) {
                if (!context.valid()) return;
                if (!item.sendConfig) continue;
                try {
                    const owner = queueOwnerOf(target.directory);
                    if (!support.has(owner)) {
                        const snapshot = await readOwnerSnapshot(owner, AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]));
                        support.set(owner, snapshot.acceptsImports === true);
                    }
                    if (!context.valid() || !support.get(owner)) continue;
                    const result = await mutate(target, `${sessionPath(target.sessionId)}/items`, jsonInit('POST', {
                        directory: target.directory,
                        importKey: `local:${item.id}`,
                        item: toServerItemInput(item, item.sendConfig),
                    }), serverSessionResponseSchema);
                    if (result.itemId?.startsWith('imported-')) retire();
                } catch {
                    // The old record stays in storage until that exact item has been accepted.
                }
            }
        })();
        migration = request;
        const release = () => { if (migration === request) migration = null; };
        void request.then(release, release);
        return request;
    }

    const editRows = (target: MessageQueueTarget, edit: (items: QueuedMessage[]) => QueuedMessage[]) => {
        const key = getMessageQueueKey(target);
        update((state) => {
            const items = edit(state.queuedMessages[key] ?? []);
            const queuedMessages = { ...state.queuedMessages };
            if (items.length) queuedMessages[key] = items;
            else delete queuedMessages[key];
            return { ...state, queuedMessages };
        });
    };

    const add = async (target: MessageQueueTarget, message: NewQueuedMessage): Promise<QueuedMessage> => {
        if (target.runtimeKey !== runtimeKey()) throw new RuntimeContextChangedError();
        if (!message.sendConfig) throw new Error('A queued message needs a provider and model to be delivered later.');
        const context = capture();
        const optimistic: QueuedMessage = {
            ...message, id: generateId(), messageId: null, status: 'queued', createdAt: Date.now(), deliveryOwner: 'server',
        };
        editRows(target, (items) => [...items, optimistic]);
        const historyIdentity = createInputHistoryIdentity(target.runtimeKey, target.directory, target.sessionId);
        const history = createInputHistorySubmission(message.content, message.attachments ?? []);
        try {
            const result = await mutate(target, `${sessionPath(target.sessionId)}/items`, jsonInit('POST', {
                directory: target.directory, item: toServerItemInput(message, message.sendConfig),
            }), serverSessionResponseSchema);
            if (historyIdentity) useInputHistoryStore.getState().appendSubmissions(historyIdentity, [history]);
            const accepted = result.session.items.find((item) => item.id === result.itemId);
            return accepted ? toQueuedMessage(accepted) : optimistic;
        } finally {
            if (context.valid()) editRows(target, (items) => items.filter((item) => item.id !== optimistic.id));
        }
    };

    const mutateAndRefreshOnFailure = (target: MessageQueueTarget, path: string, init: RequestInit) => {
        const context = capture();
        void mutate(target, path, init, serverSessionResponseSchema).catch(() => {
            if (context.valid()) void refresh(queueOwnerOf(target.directory)).catch(() => undefined);
        });
    };

    return {
        add,
        read: refresh,
        hydrate,
        resync: () => {
            if (hydration) resyncRequested = true;
            return hydrate();
        },
        applySession,
        sendNow: async (target: MessageQueueTarget, itemId: string): Promise<void> => {
            await mutate(target, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(itemId)}/send`, jsonInit('POST'), serverSessionResponseSchema);
        },
        take: async (target: MessageQueueTarget, itemId?: string): Promise<QueuedMessage[]> => {
            const context = capture();
            try {
                const path = sessionPath(target.sessionId);
                if (itemId !== undefined) {
                    const result = await mutate(target, `${path}/items/${encodeURIComponent(itemId)}/take`, jsonInit('POST'), serverTakeResponseSchema);
                    return [toQueuedMessage(result.item)];
                }
                const result = await mutate(target, `${path}/take`, jsonInit('POST'), serverTakeAllResponseSchema);
                return result.items.map(toQueuedMessage);
            } catch (error) {
                if (context.valid()) await refresh(queueOwnerOf(target.directory)).catch(() => undefined);
                throw error;
            }
        },
        remove: (target: MessageQueueTarget, itemId: string) => {
            if (target.runtimeKey !== runtimeKey() || read().sendingIds[getMessageQueueKey(target)]?.includes(itemId)) return;
            editRows(target, (items) => items.filter((item) => item.id !== itemId));
            mutateAndRefreshOnFailure(target, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(itemId)}`, jsonInit('DELETE'));
        },
        clear: (target: MessageQueueTarget) => {
            if (target.runtimeKey !== runtimeKey()) return;
            const sending = read().sendingIds[getMessageQueueKey(target)];
            editRows(target, (items) => items.filter((item) => item.deliveryOwner !== 'server' || sending?.includes(item.id)));
            mutateAndRefreshOnFailure(target, sessionPath(target.sessionId), jsonInit('DELETE'));
        },
        reorder: (target: MessageQueueTarget, fromId: string, toId: string) => {
            if (target.runtimeKey !== runtimeKey() || fromId === toId) return;
            const items = read().queuedMessages[getMessageQueueKey(target)] ?? [];
            const ordered = items.filter((item) => item.deliveryOwner === 'server');
            const from = ordered.findIndex((item) => item.id === fromId);
            const to = ordered.findIndex((item) => item.id === toId);
            const moved = ordered[from];
            if (!moved || to < 0) return;
            ordered.splice(from, 1);
            ordered.splice(to, 0, moved);
            editRows(target, (current) => [...current.filter((item) => item.deliveryOwner !== 'server'), ...ordered]);
            mutateAndRefreshOnFailure(target, `${sessionPath(target.sessionId)}/order`, jsonInit('PUT', { itemIds: ordered.map((item) => item.id) }));
        },
        reset: () => {
            controller.abort();
            controller = new AbortController();
            snapshotRevisions.clear();
            sessionRevisions.clear();
            hydration = null;
            migration = null;
            resyncRequested = false;
        },
    };
}
