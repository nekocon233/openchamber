import os from 'node:os';
import { z } from 'zod';

import { isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import type { JsonRpcRequest } from './rpc.js';
import type { createCodexConnections } from './connections.js';

const REQUEST_TIMEOUT_MS = 60_000;
const UTILITY_INSTRUCTIONS = 'Generate only the requested text or JSON from the supplied input. This is a standalone text transformation.';

const accountResponse = z.object({
  account: z.object({ type: z.string() }).passthrough().nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const configResponse = z.object({
  config: z.object({
    mcp_servers: z.record(z.string(), z.object({}).passthrough()).optional(),
  }),
});
const threadResponse = z.object({ thread: z.object({ id: z.string() }) });
const turnResponse = z.object({ turn: z.object({ id: z.string() }) });
const completedTurn = z.object({
  turn: z.object({
    status: z.string(),
    error: z.object({ message: z.string() }).nullish(),
  }),
});
const completedMessage = z.object({
  item: z.object({
    type: z.literal('agentMessage'),
    id: z.string(),
    text: z.string(),
    phase: z.string().nullish(),
  }),
});

export interface CodexUtilityCatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  outputLimit: number;
  efforts: string[];
  defaultEffort: string | null;
  serviceTiers?: string[] | undefined;
  defaultEffortVariants?: string[] | undefined;
  fast: boolean;
  input: { image: boolean; pdf: boolean };
}

export interface CodexDescribedModel extends CodexUtilityCatalogModel {
  hasLogin: boolean;
  effort?: string;
}

export interface CodexUtilityOptions {
  request: JsonRpcRequest;
  catalog: () => Promise<CodexUtilityCatalogModel[]>;
  connections?: Pick<ReturnType<typeof createCodexConnections>, 'catalog' | 'resolve'>;
}

export interface CodexUtilityGenerateOptions {
  modelID: string;
  effort?: string | null | undefined;
  serviceTier?: string | undefined;
  directory?: string | null | undefined;
  prompt: string;
  system?: string | null | undefined;
  maxOutputTokens?: number | null | undefined;
  responseSchema?: JsonValue | undefined;
  timeoutMs?: unknown;
  signal?: AbortSignal | null | undefined;
}

interface UtilityHandlers {
  message: (params: JsonObject) => void;
  complete: (params: JsonObject) => void;
}

type UtilityTurnStartParams = {
  threadId: string;
  input: Array<{ type: 'text'; text: string; text_elements: JsonValue[] }>;
  effort?: string | null;
  serviceTier?: string;
  outputSchema?: JsonValue;
};

export const createCodexUtility = ({ request, catalog, connections }: CodexUtilityOptions) => {
  const pending = new Map<string, UtilityHandlers>();
  const running = new Set<(error: Error) => void>();

  const defaultLogin = async (): Promise<boolean> => {
    const result = accountResponse.parse(await request('account/read', { refreshToken: false }));
    return result.account !== null || !result.requiresOpenaiAuth;
  };

  const available = async (): Promise<boolean> => Boolean((await connections?.catalog())?.length) || defaultLogin();

  const describe = async (modelID: string): Promise<CodexDescribedModel> => {
    const managed = (await connections?.catalog())?.find((entry) => entry.id === modelID);
    const model = managed ?? (await catalog()).find((entry) => entry.id === modelID);
    if (!model) {
      throw Object.assign(new Error('The selected model is not available in Codex: ' + modelID), {
        statusCode: 404,
        code: 'codex-model-unavailable',
      });
    }
    const effort = model.efforts.includes('low') ? 'low' : model.defaultEffort;
    const described: CodexDescribedModel = { ...model, hasLogin: Boolean(managed) || await defaultLogin() };
    if (effort !== null) described.effort = effort;
    return described;
  };

  const generate = ({
    modelID,
    effort,
    serviceTier,
    directory,
    prompt,
    system,
    maxOutputTokens,
    responseSchema,
    timeoutMs,
    signal,
  }: CodexUtilityGenerateOptions): Promise<string> => {
    const deadline = AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : REQUEST_TIMEOUT_MS);
    const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let resolveResult: (value: string) => void = () => {};
    let rejectResult: (cause: unknown) => void = () => {};
    const resultPromise = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const messages = new Map<string, string>();
    let threadId: string | null = null;
    let turnId: string | null = null;
    let turnFinished = false;
    let settled = false;
    let connectionLost = false;

    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      rejectResult(cause);
    };
    const onAbort = () => fail(abortSignal.reason);
    const onExit = (error: Error) => {
      connectionLost = true;
      fail(error);
    };
    const handlers: UtilityHandlers = {
      message(params) {
        const parsed = completedMessage.safeParse(params);
        if (!parsed.success || parsed.data.item.phase === 'commentary') return;
        messages.set(parsed.data.item.id, parsed.data.item.text);
      },
      complete(params) {
        const parsed = completedTurn.safeParse(params);
        if (!parsed.success) {
          fail(new Error('Invalid Codex utility completion'));
          return;
        }
        turnFinished = true;
        if (parsed.data.turn.status !== 'completed') {
          fail(new Error(parsed.data.turn.error?.message || 'Codex utility generation did not complete'));
          return;
        }
        const text = [...messages.values()].join('\n').trim();
        if (!text) {
          fail(Object.assign(new Error('Codex returned no utility text'), { code: 'output-exhausted' }));
          return;
        }
        if (settled) return;
        settled = true;
        resolveResult(text);
      },
    };

    const run = async () => {
      try {
        abortSignal.throwIfAborted();
        const cwd = directory || os.homedir();
        const selected = await connections?.resolve(modelID);
        const configured = configResponse.parse(await request('config/read', { cwd, includeLayers: false }));
        abortSignal.throwIfAborted();
        const started = threadResponse.parse(await request('thread/start', {
          model: selected?.model ?? modelID,
          modelProvider: selected?.providerId ?? undefined,
          cwd,
          ephemeral: true,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          environments: [],
          baseInstructions: UTILITY_INSTRUCTIONS,
          developerInstructions: [system, maxOutputTokens ? 'Keep the answer within ' + maxOutputTokens + ' tokens.' : null].filter(Boolean).join('\n'),
          config: {
            project_doc_max_bytes: 0,
            web_search: 'disabled',
            agents: { enabled: false },
            features: {
              shell_tool: false,
              multi_agent: false,
              multi_agent_v2: false,
              apps: false,
              plugins: false,
              hooks: false,
              code_mode: false,
              code_mode_only: false,
              code_mode_host: false,
              view_image: false,
              skill_search: false,
              skill_mcp_dependency_install: false,
              tool_suggest: false,
              request_permissions_tool: false,
            },
            mcp_servers: Object.fromEntries(Object.keys(configured.config.mcp_servers ?? {}).map((name) => [name, { enabled: false }])),
          },
        }));
        threadId = started.thread.id;
        pending.set(threadId, handlers);
        abortSignal.throwIfAborted();
        if (connectionLost) return;
        const turn: UtilityTurnStartParams = {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        };
        if (effort !== undefined) turn.effort = effort;
        if (serviceTier !== undefined) turn.serviceTier = serviceTier;
        if (responseSchema) turn.outputSchema = responseSchema;
        const startedTurn = turnResponse.parse(await request('turn/start', turn));
        turnId = startedTurn.turn.id;
        abortSignal.throwIfAborted();
        await resultPromise;
      } catch (error) {
        fail(error);
      } finally {
        running.delete(onExit);
        if (threadId !== null && !connectionLost) {
          if (!turnFinished && turnId !== null) {
            await request('turn/interrupt', { threadId, turnId }).catch(() => {});
          }
          await request('thread/unsubscribe', { threadId }).catch(() => {});
        }
        if (threadId !== null) pending.delete(threadId);
      }
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    running.add(onExit);
    void run();
    return resultPromise.finally(() => abortSignal.removeEventListener('abort', onAbort));
  };

  return {
    available,
    describe,
    generate,
    handleNotification(method: string, params: JsonObject): boolean {
      const threadId = params.threadId;
      if (!isString(threadId)) return false;
      const handlers = pending.get(threadId);
      if (!handlers) return false;
      if (method === 'item/completed') handlers.message(params);
      if (method === 'turn/completed') handlers.complete(params);
      return true;
    },
    ownsRequest(params: JsonObject): boolean {
      return isString(params.threadId) && pending.has(params.threadId);
    },
    handleExit(error: Error) {
      for (const fail of running) fail(error);
    },
  };
};
