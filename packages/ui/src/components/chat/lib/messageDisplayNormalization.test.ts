import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';

import { getCompactionKind, getNormalizedMessageForDisplay } from './messageDisplayNormalization';
import type { ChatMessageEntry } from './turns/types';

const userInfo = (id: string): Message => ({
    id,
    sessionID: 'ncl_session',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'claude-native', modelID: 'opus' },
});

const compaction = (id: string, auto: boolean): ChatMessageEntry => ({
    info: userInfo(id),
    parts: [{ id: `${id}_p0`, sessionID: 'ncl_session', messageID: id, type: 'compaction', auto }],
});

describe('compaction display', () => {
    test('marks a compaction the CLI made by itself apart from one the user asked for', () => {
        const automatic = getNormalizedMessageForDisplay(compaction('ncl_k_1', true));
        const manual = getNormalizedMessageForDisplay(compaction('ncl_k_2', false));
        expect(getCompactionKind(automatic)).toBe('auto');
        expect(getCompactionKind(manual)).toBe('manual');
        // Code that finds compactions by their text still does.
        expect(automatic.parts).toHaveLength(1);
        expect(automatic.parts[0]).toMatchObject({ type: 'text', text: '/compact' });
    });

    test('leaves every other message unmarked', () => {
        const prompt = getNormalizedMessageForDisplay({
            info: userInfo('ncl_u_1'),
            parts: [{ id: 'ncl_u_1_p0', sessionID: 'ncl_session', messageID: 'ncl_u_1', type: 'text', text: '/compact' }],
        });
        expect(getCompactionKind(prompt)).toBeNull();
    });
});
