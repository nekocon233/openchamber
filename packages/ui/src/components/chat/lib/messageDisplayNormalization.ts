import type { Part } from '@/lib/opencode/model';
import { normalizeParts } from '../message/partUtils';
import type { ChatMessageEntry } from './turns/types';

export const hasCompactionPart = (message: ChatMessageEntry): boolean => {
    return message.parts.some((part) => {
        const type = (part as { type?: unknown } | null | undefined)?.type;
        return type === 'compaction';
    });
};

/** Who compacted the conversation: the user with /compact, or the CLI or OpenCode making room. */
export type CompactionKind = 'auto' | 'manual';

/** The compaction a display message marks, or null for any other message. */
export const getCompactionKind = (message: ChatMessageEntry): CompactionKind | null => {
    // SAFETY: `clientCompaction` is the display-only field set below; the SDK
    // type does not declare it, and the value is checked before use.
    const kind = (message.info as { clientCompaction?: unknown }).clientCompaction;
    return kind === 'auto' || kind === 'manual' ? kind : null;
};

// A compaction shows as a marker in the conversation, not as a message the
// user sent. The text stays `/compact` for the code that finds compactions by
// it; `clientCompaction` tells the renderer which marker to draw.
const normalizeCompactionCommandMessage = (message: ChatMessageEntry): ChatMessageEntry => {
    if (!hasCompactionPart(message)) {
        return message;
    }

    let compaction: CompactionKind | null = null;
    const nextParts = message.parts.map((part): Part => {
        if (part.type !== 'compaction') {
            return part;
        }
        compaction = part.auto ? 'auto' : 'manual';
        return { id: part.id, sessionID: part.sessionID, messageID: part.messageID, type: 'text', text: '/compact' } satisfies Part;
    });

    // Display-only fields on a copy of the SDK record, read back through
    // `clientRole` and `getCompactionKind`.
    const info: ChatMessageEntry['info'] & { clientRole: 'user'; clientCompaction: CompactionKind | null } = {
        ...message.info,
        clientRole: 'user',
        clientCompaction: compaction,
    };
    return { ...message, info, parts: nextParts };
};

const normalizeMessageParts = (message: ChatMessageEntry): ChatMessageEntry => {
    const parts = normalizeParts(message.parts);
    if (parts.length === message.parts.length) {
        return message;
    }
    return {
        ...message,
        parts,
    };
};

const normalizedMessageBySource = new WeakMap<ChatMessageEntry, ChatMessageEntry>();

/**
 * The message a timeline row renders, with malformed parts dropped.
 *
 * Cached by source reference: streaming re-renders resolve an unchanged
 * message without rebuilding it, which also keeps its identity stable for the
 * turn projection.
 */
export const getNormalizedMessageForDisplay = (message: ChatMessageEntry): ChatMessageEntry => {
    const cached = normalizedMessageBySource.get(message);
    if (cached) {
        return cached;
    }

    const normalized = normalizeMessageParts(normalizeCompactionCommandMessage(message));
    normalizedMessageBySource.set(message, normalized);
    return normalized;
};
