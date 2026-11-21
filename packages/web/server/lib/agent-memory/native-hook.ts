import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requestControlAction } from '../../../bin/lib/cli-control.js';
import type { ControlInput } from '../openchamber-control/contracts.js';

const hookInput = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt']),
  turn_id: z.string().optional(),
  last_assistant_message: z.string().nullish(),
  source: z.string().optional(),
});

export type NativeMemoryHookRequest = (
  port: number,
  action: string,
  input: ControlInput,
  options?: { timeoutMs?: number },
) => ReturnType<typeof requestControlAction>;

export interface RunNativeMemoryHookOptions {
  input: unknown;
  backend: 'claude' | 'codex';
  port: number;
  request?: NativeMemoryHookRequest;
  observedAt?: number;
}

export type NativeMemoryHookOutput =
  | Record<string, never>
  | {
    hookSpecificOutput: {
      hookEventName: z.infer<typeof hookInput>['hook_event_name'];
      additionalContext: string;
    };
  };

export const runNativeMemoryHook = async ({
  input,
  backend,
  port,
  request = requestControlAction,
  observedAt = Date.now(),
}: RunNativeMemoryHookOptions): Promise<NativeMemoryHookOutput> => {
  const value = hookInput.parse(input);
  if (value.hook_event_name === 'SessionStart' && value.source !== 'compact') return {};
  const identity: ControlInput & {
    backend: 'claude' | 'codex';
    sessionId: string;
    directory: string;
    delivery: 'hook';
  } = {
    backend,
    sessionId: value.session_id,
    directory: value.cwd,
    delivery: 'hook',
  };
  if (value.hook_event_name === 'Stop' || value.hook_event_name === 'Interrupt') {
    const checkpointPayload: ControlInput & {
      backend: 'claude' | 'codex';
      sessionId: string;
      directory: string;
      delivery: 'hook';
      turnId?: string | undefined;
      summary: string;
      status: 'interrupted' | 'completed';
      observedAt: number;
    } = {
      ...identity,
      turnId: value.turn_id,
      summary: (value.last_assistant_message ?? '').slice(0, 12000),
      status: value.hook_event_name === 'Interrupt' ? 'interrupted' : 'completed',
      observedAt,
    };
    await request(port, 'memory.checkpoint', checkpointPayload, { timeoutMs: 1800 });
    return {};
  }
  const result = z.object({ enabled: z.boolean(), text: z.string() }).parse(
    await request(port, 'memory.context', identity, { timeoutMs: 1800 }),
  );
  return result.enabled && result.text
    ? { hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: result.text } }
    : {};
};

const main = async () => {
  try {
    const args = process.argv.slice(2);
    const backend = z.enum(['claude', 'codex']).parse(args[args.indexOf('--backend') + 1]);
    const port = z.coerce.number().int().min(1).max(65535).parse(args[args.indexOf('--port') + 1]);
    let text = '';
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 256 * 1024) throw new Error('Hook input is too large');
    }
    const result = await runNativeMemoryHook({ input: JSON.parse(text), backend, port });
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write('{}');
    process.stderr.write('OpenChamber shared memory is unavailable.\n');
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
