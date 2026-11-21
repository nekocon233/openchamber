import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { JsonObject } from '../../shared/json-values.js';

type DshRegisteredTool = { name?: string };
type JsonlConstructor = new (...args: never[]) => DshPluginSessionPersistence;

interface DshToolExecution {
  name: string;
}

interface DshToolExecuteContext {
  signal: AbortSignal;
}

interface DshDelegateToolArgs {
  task_id: string;
  prompt: string;
  description?: string;
}

interface DshToolDefinition {
  name: string;
  description: string;
  parameters: {
    task_id: { type: 'string'; required: true; description: string };
    prompt: { type: 'string'; required: true };
    description: { type: 'string' };
  };
  output: {
    schema: { type: 'string' };
    render: (args: DshDelegateToolArgs, value: string) => Array<{ type: 'text'; text: string }>;
  };
  isConcurrencySafe: () => boolean;
  execute: (args: DshDelegateToolArgs, exec: DshToolExecuteContext) => Promise<string>;
}

type DefineToolFn = (definition: DshToolDefinition) => DshRegisteredTool;

export interface DshPluginTools {
  get: (name: string) => DshRegisteredTool | undefined;
  restrict: (policy: { deny: string[] }) => () => void;
  guard: (handler: (execution: DshToolExecution) => string | undefined) => () => void;
  register: (tool: DshRegisteredTool) => () => void;
}

export interface DshPluginAgent {
  session: { id: string | number };
  ctx: { tools: DshPluginTools };
}

export interface DshPluginSessionPersistence {
  config: { root: string; compression?: string };
  list: () => Promise<Array<{ header: { id: string; parentSession?: string; origin?: string } }>>;
}

export interface DshPluginContext {
  sessionPersistence: DshPluginSessionPersistence;
  agents: { list: () => Iterable<DshPluginAgent> };
  effect: (factory: () => () => void) => void;
  on: (event: 'agent/created', listener: (payload: { agent: DshPluginAgent }) => void) => void;
  waterfall: (event: string, payload: { sessionId: string }, fallback: () => Promise<string[]>) => Promise<string[]>;
}

const jsonlModuleSchema = z.object({
  default: z.custom<JsonlConstructor>((value) => z.function().safeParse(value).success),
});
const toolsModuleSchema = z.object({
  defineTool: z.custom<DefineToolFn>((value) => z.function().safeParse(value).success),
});
const packageVersionSchema = z.object({ version: z.string().optional() });
const delegateAnswerSchema = z.object({ error: z.string().optional() }).passthrough();

const delegationConfigSchema = z.object({
  child: z.boolean(),
  env: z.object({
    OPENCHAMBER_DELEGATION_URL: z.string().url(),
    OPENCHAMBER_DELEGATION_TOKEN: z.string().min(1),
  }),
}).nullable();

const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect'), id: z.string().uuid() }),
  z.object({ type: z.literal('configure-delegation'), id: z.string().uuid(), sessionId: z.string(), configuration: delegationConfigSchema }),
]);

type DelegationConfiguration = z.infer<typeof delegationConfigSchema>;

export const inject = ['sessionPersistence', 'agents', 'workspaceRegistry', 'tools'];

export async function apply(ctx: DshPluginContext): Promise<void> {
  const packagePath = process.env.OPENCHAMBER_DSH_PACKAGE;
  if (!packagePath) throw new Error('Missing OPENCHAMBER_DSH_PACKAGE');
  const require = createRequire(packagePath);
  const { default: Jsonl } = jsonlModuleSchema.parse(
    await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),
  );
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  const reader = createInterface({ input: channel });
  channel.on('error', () => reader.close());
  ctx.effect(() => () => {
    reader.close();
    channel.destroy();
  });
  const send = (value: JsonObject): void => {
    channel.write(`${JSON.stringify(value)}\n`);
  };
  const { defineTool } = toolsModuleSchema.parse(
    await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href),
  );
  const configurations = new Map<string, DelegationConfiguration>();
  const installs = new Map<string, Array<() => void>>();

  const install = (agent: DshPluginAgent): void => {
    const key = String(agent.session.id);
    const configuration = configurations.get(key);
    for (const dispose of installs.get(key) ?? []) dispose();
    installs.delete(key);
    if (!configuration) return;
    const nativeDelegationTools = new Set(['subagent', 'subagent_fork', 'spawn_agent', 'delegate']);
    if (configuration.child) nativeDelegationTools.add('exit_plan_mode');
    const disposers: Array<() => void> = [
      agent.ctx.tools.restrict({ deny: [...nativeDelegationTools].filter((name) => agent.ctx.tools.get(name) !== undefined) }),
      agent.ctx.tools.guard((execution) => nativeDelegationTools.has(execution.name)
        ? 'Use openchamber_delegate for the selected subagent. Nested delegation is unavailable.'
        : undefined),
    ];
    if (!configuration.child) {
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'openchamber_delegate',
        description: 'Delegate a task using the subagent CLI and model selected by the user. Returns the actual child result.',
        parameters: {
          task_id: { type: 'string', required: true, description: 'Unique task key within this turn. Keep the same key when retrying this task.' },
          prompt: { type: 'string', required: true },
          description: { type: 'string' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const response = await fetch(configuration.env.OPENCHAMBER_DELEGATION_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${configuration.env.OPENCHAMBER_DELEGATION_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...args, id: args.task_id }),
            signal: exec.signal,
          });
          const answer = delegateAnswerSchema.parse(await response.json());
          if (!response.ok || answer.error) throw new Error(answer.error || 'Subagent dispatch failed');
          return JSON.stringify(answer);
        },
      })));
    }
    installs.set(key, disposers);
  };

  ctx.on('agent/created', ({ agent }) => install(agent));
  const modern = packageVersionSchema.parse(require(packagePath)).version === '0.2.1-rc.5';
  if (!modern && !(ctx.sessionPersistence instanceof Jsonl)) {
    send({ type: 'unsupported' });
    return;
  }
  const config = ctx.sessionPersistence.config;
  send({ type: 'ready', root: config.root, compression: config.compression ?? 'zstd' });
  let work: Promise<void> = Promise.resolve();
  reader.on('line', (line) => {
    work = work.catch(() => {}).then(async () => {
      const input = requestSchema.parse(JSON.parse(line));
      try {
        if (input.type === 'configure-delegation') {
          configurations.set(input.sessionId, input.configuration);
          for (const agent of ctx.agents.list()) if (String(agent.session.id) === input.sessionId) install(agent);
          send({ type: 'configured', id: input.id });
          return;
        }
        const items = await ctx.sessionPersistence.list();
        const active: string[] = [];
        for (const { header } of items) {
          const activity = await ctx.waterfall('workspace/session-activity', { sessionId: header.id }, () => Promise.resolve([]));
          if (activity.length) active.push(header.id);
        }
        send({
          type: 'inspection',
          id: input.id,
          active,
          sessions: items.map(({ header }) => ({ id: header.id, parent: header.parentSession, origin: header.origin })),
        });
      } catch {
        send({ type: 'error', id: input.id });
      }
    }).catch(() => {});
  });
}
