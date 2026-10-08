import { describe, expect, test } from 'bun:test';
import type { Message, Part, TextPart } from '@/lib/opencode/model';
import { createContextPart } from '@/lib/messages/contextParts';

import { isHiddenUserMessage } from '../message/hiddenUserMessage';
import { normalizeUserDisplayParts } from '../message/normalizeUserDisplayParts';
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

const textPart = (text: string): TextPart => ({
    id: 'ncl_u_1_p0',
    sessionID: 'ncl_session',
    messageID: 'ncl_u_1',
    type: 'text',
    text,
});

const userMessage = (parts: Part[]): ChatMessageEntry => ({ info: userInfo('ncl_u_1'), parts });

describe('user display parts', () => {
    for (const text of ['', ' \n\t ']) {
        test(`hides empty user text ${JSON.stringify(text)} with or without a synthetic marker`, () => {
            for (const synthetic of [undefined, true]) {
                const part: TextPart = { ...textPart(text), synthetic };
                const message = userMessage([part]);

                expect(normalizeUserDisplayParts(message.parts)).toEqual([]);
                expect(isHiddenUserMessage(message)).toBe(true);
                expect(message.parts).toEqual([part]);
            }
        });
    }

    test('hides only a marked automatic plan approval, not a manually typed matching prompt', () => {
        const automatic: TextPart = {
            ...textPart('Implement the plan.'),
            metadata: { openchamberOrigin: 'codex-plan-approval' },
        };
        const manual = { ...textPart('Implement the plan.'), id: 'manual' };
        const message = userMessage([automatic]);

        expect(normalizeUserDisplayParts(message.parts)).toEqual([]);
        expect(isHiddenUserMessage(message)).toBe(true);
        expect(message.parts).toEqual([automatic]);
        expect(normalizeUserDisplayParts([manual])).toEqual([manual]);
        expect(isHiddenUserMessage(userMessage([manual]))).toBe(false);
        expect(normalizeUserDisplayParts([automatic, manual])).toEqual([manual]);
    });

    test('keeps visible text and part identities without changing the original message', () => {
        const empty = { ...textPart(''), synthetic: true };
        const visible = { ...textPart('visible prompt'), id: 'visible' };
        const synthetic = { ...textPart('visible context'), id: 'context', synthetic: true };
        const message = userMessage([empty, visible, synthetic]);
        const displayed = normalizeUserDisplayParts(message.parts);

        expect(displayed).toEqual([visible, synthetic]);
        expect(displayed[0]).toBe(visible);
        expect(displayed[1]).toBe(synthetic);
        expect(isHiddenUserMessage(message)).toBe(false);
        expect(message.parts).toEqual([empty, visible, synthetic]);
    });

    test('keeps attachment-only messages visible', () => {
        const file: Part = {
            id: 'file', sessionID: 'ncl_session', messageID: 'ncl_u_1',
            type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///fixture/notes.txt',
        };
        const message = userMessage([textPart(''), file]);

        expect(normalizeUserDisplayParts(message.parts)).toEqual([file]);
        expect(isHiddenUserMessage(message)).toBe(false);
    });

    test('preserves context metadata even when its text is empty', () => {
        const context: TextPart = {
            ...textPart(''),
            ...createContextPart({ kind: 'file-quote', fileLabel: 'notes.txt', quote: 'quoted text', text: 'comment' }, ''),
        };
        const message = userMessage([context]);

        expect(normalizeUserDisplayParts(message.parts)).toEqual([context]);
        expect(isHiddenUserMessage(message)).toBe(false);
    });

    test('still converts an empty-text issue context to a link attachment', () => {
        const context: TextPart = {
            ...textPart(''),
            ...createContextPart({ kind: 'github-issue', number: 7, title: 'Fixture', url: 'https://example.com/issues/7' }, ''),
        };
        const message = userMessage([context]);

        expect(normalizeUserDisplayParts(message.parts)).toEqual([{
            id: context.id, sessionID: context.sessionID, messageID: context.messageID,
            type: 'file', mime: 'application/vnd.github.issue-link', filename: 'Issue #7: Fixture',
            url: 'https://example.com/issues/7',
        }]);
        expect(isHiddenUserMessage(message)).toBe(false);
        expect(message.parts[0]).toBe(context);
    });

    test('does not let invalid context metadata keep an empty bubble visible', () => {
        const message = userMessage([{
            ...textPart(''),
            metadata: { openchamberContext: { kind: 'github-issue' } },
        }]);

        expect(normalizeUserDisplayParts(message.parts)).toEqual([]);
        expect(isHiddenUserMessage(message)).toBe(true);
    });
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
        for (const message of [automatic, manual, compaction('ncl_k_3', true)]) {
            expect(normalizeUserDisplayParts(message.parts)).toEqual(message.parts);
            expect(isHiddenUserMessage(message)).toBe(false);
        }
    });

    test('leaves every other message unmarked', () => {
        const prompt = getNormalizedMessageForDisplay({
            info: userInfo('ncl_u_1'),
            parts: [{ id: 'ncl_u_1_p0', sessionID: 'ncl_session', messageID: 'ncl_u_1', type: 'text', text: '/compact' }],
        });
        expect(getCompactionKind(prompt)).toBeNull();
    });
});
