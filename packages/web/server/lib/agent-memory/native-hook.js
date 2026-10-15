// Native CLI hook protocol. stdout is always native JSON, never CLI framing.
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requestControlAction } from '../../../bin/lib/cli-control.js';

const hookInput = z.object({
  session_id: z.string().min(1), cwd: z.string().min(1),
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt']),
  turn_id: z.string().optional(), last_assistant_message: z.string().nullish(),
  source: z.string().optional(),
});

export const runNativeMemoryHook = async ({ input, backend, port, request = requestControlAction, observedAt = Date.now() }) => {
  const value = hookInput.parse(input);
  // The first user prompt owns startup/resume delivery. A mid-turn compaction
  // needs context immediately because no new user prompt follows it.
  if (value.hook_event_name === 'SessionStart' && value.source !== 'compact') return {};
  const identity = { backend, sessionId: value.session_id, directory: value.cwd, delivery: 'hook' };
  if (value.hook_event_name === 'Stop' || value.hook_event_name === 'Interrupt') {
    await request(port, 'memory.checkpoint', {
      ...identity, turnId: value.turn_id, summary: (value.last_assistant_message ?? '').slice(0, 12000),
      status: value.hook_event_name === 'Interrupt' ? 'interrupted' : 'completed', observedAt,
    }, { timeoutMs: 1800 });
    return {};
  }
  const result = z.object({ enabled: z.boolean(), text: z.string() }).parse(
    await request(port, 'memory.context', identity, { timeoutMs: 1800 }),
  );
  return result.enabled && result.text
    ? { hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: result.text } } : {};
};

const main = async () => {
  try {
    const args = process.argv.slice(2);
    const backend = z.enum(['claude', 'codex']).parse(args[args.indexOf('--backend') + 1]);
    const port = z.coerce.number().int().min(1).max(65535).parse(args[args.indexOf('--port') + 1]);
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 256 * 1024) throw new Error('Hook input is too large');
    }
    const result = await runNativeMemoryHook({ input: JSON.parse(text), backend, port });
    process.stdout.write(JSON.stringify(result));
  } catch {
    // A disconnected or disabled memory service must never block a prompt or
    // turn a Stop hook into an automatic continuation.
    process.stdout.write('{}');
    process.stderr.write('OpenChamber shared memory is unavailable.\n');
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
