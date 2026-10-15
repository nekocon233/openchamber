import { describe, expect, it } from 'vitest';
import { runNativeMemoryHook } from './native-hook.js';

describe('native memory hook protocol', () => {
  it('injects context using the native event shape and never turns a Stop into a continuation', async () => {
    const calls = [];
    const request = async (port, action, input) => {
      calls.push({ port, action, input });
      return { enabled: true, text: 'Shared context' };
    };
    const input = { session_id: 'session', cwd: '/project', hook_event_name: 'UserPromptSubmit' };
    expect(await runNativeMemoryHook({ input, backend: 'codex', port: 3000, request })).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Shared context' },
    });
    expect(await runNativeMemoryHook({ input: { ...input, hook_event_name: 'Stop', last_assistant_message: 'Finished' }, backend: 'claude', port: 3000, request, observedAt: 123 })).toEqual({});
    expect(calls[1]).toMatchObject({ action: 'memory.checkpoint', input: { summary: 'Finished', status: 'completed', observedAt: 123 } });
    expect(await runNativeMemoryHook({ input: { ...input, hook_event_name: 'Interrupt' }, backend: 'codex', port: 3000, request })).toEqual({});
    expect(calls.at(-1).input.status).toBe('interrupted');
  });

  it('does not inject anything when memory is disabled', async () => {
    const result = await runNativeMemoryHook({
      input: { session_id: 'session', cwd: '/project', hook_event_name: 'SessionStart' }, backend: 'claude', port: 3000,
      request: async () => ({ enabled: false, text: '' }),
    });
    expect(result).toEqual({});
  });
});
