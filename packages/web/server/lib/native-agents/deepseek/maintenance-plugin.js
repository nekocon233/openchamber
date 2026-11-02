// Loaded only into OpenChamber's owned DSH process through --patch. fd 3 is
// an inherited private pipe, never a listener or a browser Remote endpoint.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export const inject = ['sessionPersistence', 'agents', 'workspaceRegistry', 'tools'];
export async function apply(ctx) {
  const require = createRequire(process.env.OPENCHAMBER_DSH_PACKAGE);
  const { default: Jsonl } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  const reader = createInterface({ input: channel });
  channel.on('error', () => reader.close());
  ctx.effect(() => () => { reader.close(); channel.destroy(); });
  const send = (value) => channel.write(`${JSON.stringify(value)}\n`);
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const configurations = new Map();
  const installs = new Map();
  const install = (agent) => {
    const key = String(agent.session.id);
    const configuration = configurations.get(key);
    for (const dispose of installs.get(key) ?? []) dispose();
    installs.delete(key);
    if (!configuration) return;
    const nativeDelegationTools = new Set(['subagent', 'subagent_fork', 'spawn_agent', 'delegate']);
    if (configuration.child) nativeDelegationTools.add('exit_plan_mode');
    const disposers = [
      agent.ctx.tools.restrict({ deny: [...nativeDelegationTools].filter((name) => agent.ctx.tools.get(name) !== undefined) }),
      agent.ctx.tools.guard((execution) => nativeDelegationTools.has(execution.name)
        ? 'Use openchamber_delegate for the selected subagent. Nested delegation is unavailable.' : undefined),
    ];
    if (!configuration.child) disposers.push(agent.ctx.tools.register(defineTool({
      name: 'openchamber_delegate',
      description: 'Delegate a task using the subagent CLI and model selected by the user. Returns the actual child result.',
      parameters: { task_id: { type: 'string', required: true, description: 'Unique task key within this turn. Keep the same key when retrying this task.' }, prompt: { type: 'string', required: true }, description: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const response = await fetch(configuration.env.OPENCHAMBER_DELEGATION_URL, {
          method: 'POST', headers: { Authorization: `Bearer ${configuration.env.OPENCHAMBER_DELEGATION_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...args, id: args.task_id }), signal: exec.signal,
        });
        const answer = await response.json();
        if (!response.ok || answer.error) throw new Error(answer.error || 'Subagent dispatch failed');
        return JSON.stringify(answer);
      },
    })));
    installs.set(key, disposers);
  };
  ctx.on('agent/created', ({ agent }) => install(agent));
  const modern = require(process.env.OPENCHAMBER_DSH_PACKAGE).version === '0.2.1-rc.5';
  if (!modern && !(ctx.sessionPersistence instanceof Jsonl)) { send({ type: 'unsupported' }); return; }
  const config = ctx.sessionPersistence.config;
  send({ type: 'ready', root: config.root, compression: config.compression ?? 'zstd' });
  const configuration = z.object({ child: z.boolean(), env: z.object({ OPENCHAMBER_DELEGATION_URL: z.string().url(), OPENCHAMBER_DELEGATION_TOKEN: z.string().min(1) }) }).nullable();
  const request = z.discriminatedUnion('type', [
    z.object({ type: z.literal('inspect'), id: z.string().uuid() }),
    z.object({ type: z.literal('configure-delegation'), id: z.string().uuid(), sessionId: z.string(), configuration }),
  ]);
  let work = Promise.resolve();
  reader.on('line', (line) => {
    work = work.catch(() => {}).then(async () => {
      const input = request.parse(JSON.parse(line));
      try {
        if (input.type === 'configure-delegation') {
          configurations.set(input.sessionId, input.configuration);
          for (const agent of ctx.agents.list()) if (String(agent.session.id) === input.sessionId) install(agent);
          send({ type: 'configured', id: input.id });
          return;
        }
        const items = await ctx.sessionPersistence.list();
        const active = [];
        for (const { header } of items) {
          const activity = await ctx.waterfall('workspace/session-activity', { sessionId: header.id }, () => Promise.resolve([]));
          if (activity.length) active.push(header.id);
        }
        send({ type: 'inspection', id: input.id, active, sessions: items.map(({ header }) => ({ id: header.id, parent: header.parentSession, origin: header.origin })) });
      } catch { send({ type: 'error', id: input.id }); }
    }).catch(() => {});
  });
}
