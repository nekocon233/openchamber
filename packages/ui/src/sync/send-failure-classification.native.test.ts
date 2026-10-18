import { describe, expect, test } from 'bun:test';
import { NativeAgentsRequestError } from '@/lib/native-agents/errors';
import { isAmbiguousSendFailure } from './send-failure-classification';

describe('native prompt admission uncertainty', () => {
  test('confirms an explicitly unknown outcome from native history', () => {
    expect(isAmbiguousSendFailure(new NativeAgentsRequestError('Unconfirmed', 502, 'NATIVE_PROMPT_OUTCOME_UNKNOWN'))).toBe(true);
  });
  test('keeps missing CLI, busy and enterprise refusals definite', () => {
    expect(isAmbiguousSendFailure(new NativeAgentsRequestError('Missing CLI', 503, 'NATIVE_CLI_MISSING'))).toBe(false);
    expect(isAmbiguousSendFailure(new NativeAgentsRequestError('Busy', 409, 'NATIVE_SESSION_BUSY'))).toBe(false);
    expect(isAmbiguousSendFailure(new NativeAgentsRequestError('Enterprise mode', 403, 'enterprise_mode'))).toBe(false);
  });
});
