import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { deriveSessionActivity } from './sessionActivity';

const pendingAssistant = {
  id: 'assistant-1',
  role: 'assistant',
  time: { created: 1 },
} as Message;

const baseInput = {
  hasAuthoritativeStatusSnapshot: false,
  messages: [pendingAssistant],
  pendingPermissions: 0,
  pendingQuestions: 0,
};

describe('deriveSessionActivity', () => {
  test('uses an interrupted trailing assistant only before the first authoritative status snapshot', () => {
    expect(deriveSessionActivity(baseInput).phase).toBe('busy');
    expect(deriveSessionActivity({
      ...baseInput,
      hasAuthoritativeStatusSnapshot: true,
    })).toEqual({
      phase: 'idle',
      isWorking: false,
      isBusy: false,
      isCooldown: false,
    });
  });

  test('uses an explicit idle global resolution instead of the interrupted assistant', () => {
    expect(deriveSessionActivity({
      ...baseInput,
      globalResolvedStatus: 'idle',
    }).phase).toBe('idle');
  });

  test('keeps authoritative busy and retry states working', () => {
    expect(deriveSessionActivity({
      ...baseInput,
      globalResolvedStatus: 'busy',
    }).phase).toBe('busy');
    expect(deriveSessionActivity({
      ...baseInput,
      globalResolvedStatus: 'retry',
    }).phase).toBe('retry');
  });

  test('blocking permissions and questions leave the send path available', () => {
    expect(deriveSessionActivity({
      ...baseInput,
      pendingPermissions: 1,
    }).phase).toBe('idle');
    expect(deriveSessionActivity({
      ...baseInput,
      pendingQuestions: 1,
    }).phase).toBe('idle');
  });
});
