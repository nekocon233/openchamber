import { describe, expect, test } from 'bun:test';
import { chatgptErrorLabel } from './chatgpt-error';
import { chatgptAuthorizationSchema } from './connections';
import { buildNativeProvider } from './providers';

describe('ChatGPT connections in the UI', () => {
  test('uses explicit error codes without mistaking generic HTTP failures for quota', () => {
    expect(chatgptErrorLabel('API Error: 429 subscription_sharing_usage_limit_exceeded')).toBe('settings.chatgpt.limitReached');
    expect(chatgptErrorLabel('CHATGPT_REAUTH_REQUIRED')).toBe('settings.chatgpt.reauthorize');
    expect(chatgptErrorLabel('429 Too many requests')).toBeNull();
  });

  test('accepts only the OpenAI authorization endpoint as a sign-in URL', () => {
    const attemptId = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
    expect(chatgptAuthorizationSchema.safeParse({ attemptId, url: 'https://auth.openai.com/api/accounts/authorize?state=fixture' }).success).toBe(true);
    expect(chatgptAuthorizationSchema.safeParse({ attemptId, url: 'https://example.test/authorize' }).success).toBe(false);
  });

  test('does not advertise invented limits, pricing, attachments or effort levels', () => {
    const provider = buildNativeProvider('claude', [{
      id: 'chatgpt:fixture:model', name: 'Account / GPT', billing: 'chatgpt-plan',
      contextWindow: null, outputLimit: null, efforts: [], defaultEffort: null, fast: false,
      input: { image: false, pdf: false },
    }]);
    const model = provider.models[0];
    expect(model.limit).toEqual({ context: 0, output: 0 });
    expect(model.cost).toEqual([]);
    expect(model.capabilities.input).toEqual(['text']);
    expect(model.variants).toEqual([]);
  });
});
