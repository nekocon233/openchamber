import { describe, expect, it } from 'vitest';

import {
  decodeNativeSessionId,
  encodeClaudeChildSessionId,
  encodeClaudeSessionId,
  encodeCodexSessionId,
  isNativeClientUserMessageId,
  isNativeSessionId,
  nativeBackendOfProviderId,
  nativeBackendOfSessionId,
  newNativeClientUserMessageId,
} from './ids.js';

const CLAUDE_UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const CODEX_THREAD = '01a0d2a6-b55b-7162-a837-c62053537e00';
const TOOL_USE = 'toolu_01VAnMEDHHeuo92ZtfbaNtwQ';

describe('native session ids', () => {
  it('round-trips Claude, Claude subagent and Codex ids', () => {
    expect(decodeNativeSessionId(encodeClaudeSessionId(CLAUDE_UUID))).toEqual({
      backend: 'claude', sessionUuid: CLAUDE_UUID, toolUseId: null,
    });
    expect(decodeNativeSessionId(encodeClaudeChildSessionId(CLAUDE_UUID, TOOL_USE))).toEqual({
      backend: 'claude', sessionUuid: CLAUDE_UUID, toolUseId: TOOL_USE,
    });
    expect(decodeNativeSessionId(encodeCodexSessionId(CODEX_THREAD))).toEqual({
      backend: 'codex', threadId: CODEX_THREAD,
    });
  });

  it('keeps every id inside the charset and length other routes accept', () => {
    for (const id of [
      encodeClaudeSessionId(CLAUDE_UUID),
      encodeClaudeChildSessionId(CLAUDE_UUID, TOOL_USE),
      encodeCodexSessionId(CODEX_THREAD),
    ]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{4,128}$/);
    }
  });

  it('tells native ids from OpenCode ids by prefix alone', () => {
    expect(isNativeSessionId(encodeClaudeSessionId(CLAUDE_UUID))).toBe(true);
    expect(isNativeSessionId(encodeCodexSessionId(CODEX_THREAD))).toBe(true);
    expect(isNativeSessionId('ses_0d21f4177002a5gRcRPHz6AWvt')).toBe(false);
    expect(nativeBackendOfSessionId('ncl_x')).toBe('claude');
    expect(nativeBackendOfSessionId('ncx_x')).toBe('codex');
    expect(nativeBackendOfSessionId('ses_x')).toBeNull();
  });

  it('maps native provider ids to their backend', () => {
    expect(nativeBackendOfProviderId('claude-native')).toBe('claude');
    expect(nativeBackendOfProviderId('codex-native')).toBe('codex');
    expect(nativeBackendOfProviderId('claude-code')).toBeNull();
  });

  it('rejects malformed native ids instead of guessing', () => {
    expect(decodeNativeSessionId('ncl_not-a-uuid')).toBeNull();
    expect(decodeNativeSessionId(`ncl_${CLAUDE_UUID}_x_${TOOL_USE}`)).toBeNull();
    expect(decodeNativeSessionId(`ncl_${CLAUDE_UUID}_t_`)).toBeNull();
    expect(decodeNativeSessionId('ncx_01a0d2a6')).toBeNull();
    expect(decodeNativeSessionId('ses_abc')).toBeNull();
    expect(() => encodeClaudeSessionId('nope')).toThrow();
    expect(() => encodeClaudeChildSessionId(CLAUDE_UUID, 'bad id with spaces')).toThrow();
    expect(() => encodeCodexSessionId('nope')).toThrow();
  });

  it('names a prompt the server sends itself the way a client names one, for the session\'s CLI', () => {
    const claude = newNativeClientUserMessageId(encodeClaudeSessionId(CLAUDE_UUID));
    const codex = newNativeClientUserMessageId(encodeCodexSessionId(CODEX_THREAD));
    expect(claude.startsWith('ncl_u_')).toBe(true);
    expect(codex.startsWith('ncx_u_')).toBe(true);
    expect([claude, codex].every(isNativeClientUserMessageId)).toBe(true);
    expect(newNativeClientUserMessageId(encodeClaudeSessionId(CLAUDE_UUID))).not.toBe(claude);
    expect(() => newNativeClientUserMessageId('ses_opencode')).toThrow('Not a native session');
  });
});
