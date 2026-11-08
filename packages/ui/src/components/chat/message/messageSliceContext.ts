import { createContext } from 'react';
import type { Part } from '@/lib/opencode/model';

import type { MessageSlice } from '../lib/turns/timelineRows';

/**
 * The part of its message a transcript row draws, when a long answer spans
 * several rows (`timelineRows.ts`); null draws the whole message.
 */
export const MessageSliceContext = createContext<MessageSlice | null>(null);

/** Select the row's parts without changing the complete message used by actions. */
export const sliceMessageParts = (parts: Part[], slice: MessageSlice | null): Part[] => {
    if (!slice) return parts;
    const start = slice.from ? parts.findIndex((part) => part.id === slice.from?.partId) : 0;
    const end = slice.to ? parts.findIndex((part) => part.id === slice.to?.partId) : parts.length;
    if (start < 0 || end < 0) return [];
    return parts.slice(start, slice.to && slice.to.offset > 0 ? end + 1 : end).map((part) => {
        if (part.type !== 'text') return part;
        const from = slice.from?.partId === part.id ? slice.from.offset : 0;
        const to = slice.to?.partId === part.id ? slice.to.offset : part.text.length;
        return from === 0 && to === part.text.length ? part : { ...part, text: part.text.slice(from, to) };
    });
};
