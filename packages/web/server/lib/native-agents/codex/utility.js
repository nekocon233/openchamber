import os from 'node:os';
import { z } from 'zod';

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

// Utility calls share the existing app-server, but never enter the session
// registry or publish chat events. Codex owns credentials and token refresh.
export const createCodexUtility = ({ request, catalog }) => {
  const pending = new Map();
  const running = new Set();

  const available = async () => {
    const result = accountResponse.parse(await request('account/read', { refreshToken: false }));
    return result.account !== null || !result.requiresOpenaiAuth;
  };

  const describe = async (modelID) => {
    const [hasLogin, models] = await Promise.all([
      available(),
      catalog(),
    ]);
    const model = models.find((entry) => entry.id === modelID);
    if (!model) {
      throw Object.assign(new Error('The selected model is not available in Codex: ' + modelID), {
        statusCode: 404, code: 'codex-model-unavailable',
      });
    }
    return { ...model, hasLogin, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort };
  };

  const generate = ({ modelID, effort, directory, prompt, system, maxOutputTokens, responseSchema, timeoutMs, signal }) => {
    const deadline = AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : REQUEST_TIMEOUT_MS);
    const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const result = Promise.withResolvers();
    const messages = new Map();
    let threadId = null;
    let turnId = null;
    let turnFinished = false;
    let settled = false;
    let connectionLost = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      result.reject(error);
    };
    const onAbort = () => fail(abortSignal.reason);
    const onExit = (error) => {
      connectionLost = true;
      fail(error);
    };
    const handlers = {
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
        result.resolve(text);
      },
    };

    // A timed-out caller returns immediately. An in-flight thread/turn start
    // still owns its eventual reply and releases that thread when it arrives.
    const run = async () => {
      try {
        abortSignal.throwIfAborted();
        const cwd = directory || os.homedir();
        const configured = configResponse.parse(await request('config/read', { cwd, includeLayers: false }));
        abortSignal.throwIfAborted();
        const started = threadResponse.parse(await request('thread/start', {
          model: modelID,
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
        const turn = {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          effort,
        };
        if (responseSchema) turn.outputSchema = responseSchema;
        const startedTurn = turnResponse.parse(await request('turn/start', turn));
        turnId = startedTurn.turn.id;
        abortSignal.throwIfAborted();
        await result.promise;
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
        pending.delete(threadId);
      }
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    running.add(onExit);
    void run();
    return result.promise.finally(() => abortSignal.removeEventListener('abort', onAbort));
  };

  return {
    available,
    describe,
    generate,
    handleNotification(method, params) {
      const handlers = pending.get(params.threadId);
      if (!handlers) return false;
      if (method === 'item/completed') handlers.message(params);
      if (method === 'turn/completed') handlers.complete(params);
      return true;
    },
    ownsRequest(params) {
      return pending.has(params.threadId);
    },
    handleExit(error) {
      for (const fail of running) fail(error);
    },
  };
};
