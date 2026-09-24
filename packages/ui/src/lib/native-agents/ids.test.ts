import { describe, expect, test } from 'bun:test';

import {
  createNativeUserMessageId,
  isNativeUserMessageIdFor,
  isProviderPickableForSession,
  NATIVE_PROVIDER_CLAUDE,
  NATIVE_PROVIDER_CODEX,
} from './ids';

const CLAUDE_SESSION = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const CODEX_SESSION = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';

describe('isProviderPickableForSession', () => {
  test('a native session offers only its own CLI', () => {
    expect(isProviderPickableForSession(CLAUDE_SESSION, NATIVE_PROVIDER_CLAUDE)).toBe(true);
    expect(isProviderPickableForSession(CLAUDE_SESSION, NATIVE_PROVIDER_CODEX)).toBe(false);
    expect(isProviderPickableForSession(CLAUDE_SESSION, 'anthropic')).toBe(false);
    expect(isProviderPickableForSession(CODEX_SESSION, NATIVE_PROVIDER_CODEX)).toBe(true);
  });

  test('an OpenCode session offers no native CLI, and a new session offers everything', () => {
    expect(isProviderPickableForSession('ses_opencode', 'anthropic')).toBe(true);
    expect(isProviderPickableForSession('ses_opencode', NATIVE_PROVIDER_CLAUDE)).toBe(false);
    expect(isProviderPickableForSession(null, NATIVE_PROVIDER_CODEX)).toBe(true);
    expect(isProviderPickableForSession(null, 'anthropic')).toBe(true);
  });
});

describe('native user message ids', () => {
  test('are minted per backend and recognised only for that backend', () => {
    const claudeId = createNativeUserMessageId('claude');
    const codexId = createNativeUserMessageId('codex');
    expect(/^ncl_u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claudeId)).toBe(true);
    expect(codexId.startsWith('ncx_u_')).toBe(true);
    expect(isNativeUserMessageIdFor('claude', claudeId)).toBe(true);
    expect(isNativeUserMessageIdFor('codex', claudeId)).toBe(false);
    expect(isNativeUserMessageIdFor('claude', 'msg_0198b4f3c001AbCdEfGhIjKlMn')).toBe(false);
    expect(isNativeUserMessageIdFor('claude', 'ncl_u_not-a-uuid')).toBe(false);
  });
});
