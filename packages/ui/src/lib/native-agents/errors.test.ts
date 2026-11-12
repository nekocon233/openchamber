import { describe, expect, test } from 'bun:test';
import { NativeAgentsRequestError, nativeSessionActionErrorKey } from './errors';
import { unifiedConversationsI18n } from '../i18n/messages/unified-conversations.i18n';

describe('handoff failure guidance', () => {
  for (const [code, key] of [
    ['NATIVE_CONVERSATION_SUMMARY_UNAVAILABLE', 'chat.unified.summaryUnavailable'],
    ['NATIVE_CONVERSATION_SUMMARY_INCOMPLETE', 'chat.unified.summaryIncomplete'],
    ['NATIVE_CONVERSATION_CONTEXT_TOO_LARGE', 'chat.unified.contextTooLarge'],
  ] as const) {
    test(`maps ${code} to its recovery guidance`, () => {
      expect(nativeSessionActionErrorKey(new NativeAgentsRequestError('Handoff failed', 409, code))).toBe(key);
    });
  }

  test('translates each handoff recovery action in every shipped locale', () => {
    for (const [locale, dictionary] of Object.entries(unifiedConversationsI18n)) {
      for (const key of ['chat.unified.summaryUnavailable', 'chat.unified.summaryIncomplete', 'chat.unified.contextTooLarge'] as const) {
        expect(dictionary[key].trim()).not.toBe('');
        if (locale !== 'en') expect(dictionary[key]).not.toBe(unifiedConversationsI18n.en[key]);
      }
    }
  });
});
