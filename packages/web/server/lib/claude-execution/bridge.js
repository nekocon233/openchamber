import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { startModelGateway } from './gateway.js';
import { emptyUsage, sdkUsage } from './protocol.js';

const running = new Map();
const utilityAgents = new Set(['title', 'summary', 'compaction']);
const runKey = (context) => `${context.directory}\0${context.sessionID}\0${context.agent}`;
const debug = (stage) => { if (process.env.OPENCHAMBER_CLAUDE_EXECUTION_DEBUG === '1') console.error('[claude-execution]', stage); };
const combineUsage = (left, right, sign = 1) => ({
  inputTokens: Object.fromEntries(['total', 'noCache', 'cacheRead', 'cacheWrite'].map((key) => [key, Math.max(0, left.inputTokens[key] + sign * right.inputTokens[key])])),
  outputTokens: { total: Math.max(0, left.outputTokens.total + sign * right.outputTokens.total), text: undefined, reasoning: undefined },
});

class EventQueue {
  items = [];
  readers = [];
  writers = [];
  closed = false;

  async push(value) {
    while (!this.closed && this.items.length >= 128) await new Promise((resolve) => this.writers.push(resolve));
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.items.push(value);
  }

  next() {
    if (this.items.length) {
      const value = this.items.shift();
      this.writers.shift()?.();
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.readers.push(resolve));
  }

  close(discard = false) {
    this.closed = true;
    if (discard) this.items.length = 0;
    for (const resolve of this.readers.splice(0)) resolve({ done: true });
    for (const resolve of this.writers.splice(0)) resolve();
  }
}

function childEnvironment(gateway, modelID, contextLimit) {
  const processKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA'];
  const env = Object.fromEntries(processKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const result = {
    ...env,
    ANTHROPIC_BASE_URL: gateway.baseURL,
    ANTHROPIC_AUTH_TOKEN: gateway.token,
    ANTHROPIC_MODEL: modelID,
    ANTHROPIC_DEFAULT_FABLE_MODEL: modelID,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelID,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelID,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelID,
    CLAUDE_CODE_SUBAGENT_MODEL: modelID,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'openchamber/claude-execution',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (contextLimit > 0) {
    result.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextLimit);
    result.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextLimit);
  }
  return result;
}

const toolResultContent = (output) => {
  if (output.type === 'text' || output.type === 'error-text') return [{ type: 'text', text: output.value }];
  if (output.type === 'json' || output.type === 'error-json') return [{ type: 'text', text: JSON.stringify(output.value) }];
  if (output.type === 'content') return output.value.map((part) => {
    if (part.type === 'text') return part;
    if (part.type === 'image-data') return { type: 'image', data: part.data, mimeType: part.mediaType };
    throw new Error(`Unsupported bridged tool result: ${part.type}`);
  });
  throw new Error(`Unsupported bridged tool result: ${output.type}`);
};

function fileBlock(part) {
  if (!part.mediaType.startsWith('image/') && part.mediaType !== 'application/pdf') throw new Error(`Claude Code cannot receive ${part.mediaType} directly`);
  return {
    type: part.mediaType === 'application/pdf' ? 'document' : 'image',
    source: part.data instanceof URL ? { type: 'url', url: part.data.href }
      : { type: 'base64', media_type: part.mediaType, data: Buffer.from(part.data).toString('base64') },
  };
}

function historyForClaude(messages, attachments) {
  return messages.map((message) => {
    const restored = { ...message };
    delete restored.providerOptions;
    if (!Array.isArray(message.content)) return restored;
    restored.content = message.content.map((part) => {
      const restoredPart = { ...part };
      delete restoredPart.providerOptions;
      if (part.type === 'file') {
        attachments.push({ type: 'text', text: `Earlier attachment: ${part.filename ?? part.mediaType}` }, fileBlock(part));
        restoredPart.data = '[Attachment supplied below]';
      }
      if (part.type === 'tool-result' && part.output.type === 'content') {
        restoredPart.output = { ...part.output, value: part.output.value.map((item) => {
          if (item.type !== 'image-data') return item;
          attachments.push({ type: 'text', text: `Image returned by earlier tool ${part.toolName}` }, {
            type: 'image', source: { type: 'base64', media_type: item.mediaType, data: item.data },
          });
          return { type: 'text', text: '[Tool image supplied below]' };
        }) };
      }
      return restoredPart;
    });
    return restored;
  });
}

function makePrompt(prompt) {
  const messages = prompt.filter((item) => item.role !== 'system');
  let current = messages.findLastIndex((item) => item.role === 'user');
  if (current < 0) current = messages.length;
  const prior = messages.slice(0, current);
  const latest = messages.slice(current);
  const content = [];
  const attachments = [];
  const history = historyForClaude(prior, attachments);
  if (prior.length) content.push({
    type: 'text',
    text: `The host restored the preceding conversation below. Tool results describe completed operations; do not repeat them merely to reconstruct history.\n<conversation_history>\n${JSON.stringify(history)}\n</conversation_history>`,
  });
  content.push(...attachments);
  for (const message of latest) {
    if (!Array.isArray(message.content)) { content.push({ type: 'text', text: message.content }); continue; }
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'file') {
        content.push(fileBlock(part));
      } else if (part.type !== 'reasoning') content.push({ type: 'text', text: JSON.stringify(part) });
    }
  }
  if (!content.length) throw new Error('Claude Code received no prompt');
  return (async function* () {
    yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
  })();
}

function hostInstructions(params, context) {
  // OpenCode puts ChatGPT OAuth system instructions in provider options rather
  // than in the message array. They still contain the host's project rules.
  const responsesInstructions = z.string().optional().parse(params.providerOptions?.openai?.instructions);
  const systemMessages = params.prompt.filter((message) => message.role === 'system').map((message) => message.content);
  const projectInstructions = (text = '') => {
    if (context.preserveSystemPrefix || !['build', 'plan'].includes(context.agent)) return text;
    const boundary = text.indexOf('You are powered by the model named');
    return boundary >= 0 ? text.slice(boundary) : text;
  };
  // With ordinary API authentication, a separate instructions option belongs
  // to the user. Only the OAuth-only system field carries OpenCode's prefix.
  const system = [
    systemMessages.length ? responsesInstructions : projectInstructions(responsesInstructions),
    ...systemMessages.map(projectInstructions),
  ].filter(Boolean).join('\n\n');
  return [
    'You are running inside OpenChamber. Use the provided mcp__opencode__ tools. The host executes those tools and enforces permissions. Native tools are disabled.',
    system,
  ].filter(Boolean).join('\n\n');
}

async function createRun({ model, params, context, providerOptions, sourceFormat, sdk }) {
  debug('gateway.start');
  const controller = new AbortController();
  const queue = new EventQueue();
  const pending = new Map();
  const gateway = await startModelGateway({ model, modelID: context.modelID, providerOptions, format: sourceFormat, headers: params.headers, maxOutputTokens: params.maxOutputTokens, signal: controller.signal });
  debug('gateway.ready');
  let query;
  let disposed = false;
  const key = runKey(context);
  const run = {
    context, queue, pending, controller,
    reportedUsage: emptyUsage(),
    seenUsage: new Set(),
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const call of pending.values()) call.reject(new Error('Claude Code task stopped'));
      pending.clear();
      query?.close();
      gateway.close();
      queue.close(true);
      if (running.get(key) === run) running.delete(key);
    },
  };
  try {
    const utility = utilityAgents.has(context.agent) || !params.tools?.length;
    if (!utility && params.tools.some((entry) => entry.type !== 'function')) throw new Error('Claude Code execution requires host-executed function tools');
    const tools = utility ? [] : params.tools.filter((entry) => entry.type === 'function').map((definition) => {
      const schema = z.fromJSONSchema(definition.inputSchema);
      if (!(schema instanceof z.ZodObject)) throw new Error(`Tool ${definition.name} requires an object schema`);
      // Zod names this external API property "shape"; our tool fields preserve
      // the complete JSON Schema conversion, including optional/nested inputs.
      const inputFields = schema['shape'];
      return sdk.tool(definition.name, definition.description ?? definition.name, inputFields, async (args) => {
        const id = `call_${randomUUID().replaceAll('-', '')}`;
        const result = Promise.withResolvers();
        const call = { id, name: definition.name, input: JSON.stringify(args), ...result };
        pending.set(id, call);
        await queue.push({ type: 'host-tool', call });
        return result.promise;
      }, { alwaysLoad: true });
    });
    const allowedTools = tools.map((entry) => `mcp__opencode__${entry.name}`);
    const toolAliases = Object.fromEntries(tools.flatMap((entry) => [
      [entry.name, `mcp__opencode__${entry.name}`],
      [entry.name[0].toUpperCase() + entry.name.slice(1), `mcp__opencode__${entry.name}`],
    ]));
    debug('query.start');
    query = sdk.query({
      prompt: makePrompt(params.prompt),
      options: {
        cwd: context.directory,
        model: context.modelID,
        env: childEnvironment(gateway, context.modelID, context.contextLimit),
        abortController: controller,
        includePartialMessages: true,
        tools: [],
        allowedTools,
        toolAliases,
        mcpServers: tools.length ? { opencode: sdk.createSdkMcpServer({ name: 'opencode', tools }) } : {},
        settingSources: [],
        settings: { disableAllHooks: true },
        skills: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: utility ? hostInstructions(params, context) : { type: 'preset', preset: 'claude_code', append: hostInstructions(params, context) },
        maxTurns: utility ? 1 : undefined,
        persistSession: false,
      },
    });
    debug('query.created');
    void (async () => {
      try {
        for await (const event of query) {
          if (event.type === 'system' || event.type === 'result') debug(`query.event.${event.type}.${event.subtype ?? ''}`);
          await queue.push(event);
        }
      } catch (error) {
        if (!controller.signal.aborted) await queue.push({ type: 'bridge-error', error });
      } finally {
        queue.close();
      }
    })();
    running.set(key, run);
    return run;
  } catch (error) {
    run.dispose();
    throw error;
  }
}

export function stopSessionRuns(directory, sessionID, includeUtility = false) {
  for (const run of running.values()) {
    if (run.context.directory === directory && run.context.sessionID === sessionID && (includeUtility || !utilityAgents.has(run.context.agent))) run.dispose();
  }
}

export function stopDirectoryRuns(directory) {
  for (const run of running.values()) if (run.context.directory === directory) run.dispose();
}

export async function streamClaudeCode({ model, params, context, providerOptions, sourceFormat = 'anthropic', sdk }) {
  params.abortSignal?.throwIfAborted();
  const key = runKey(context);
  let run = running.get(key);
  if (run && (run.context.providerID !== context.providerID || run.context.modelID !== context.modelID || run.context.messageID !== context.messageID)) {
    run.dispose();
    run = undefined;
  }
  if (!run) {
    debug('sdk.load');
    const runtime = sdk ?? await import('@anthropic-ai/claude-agent-sdk');
    params.abortSignal?.throwIfAborted();
    debug('sdk.ready');
    run = await createRun({ model, params, context, providerOptions, sourceFormat, sdk: runtime });
  }
  for (const message of params.prompt) {
    if (message.role !== 'tool') continue;
    for (const result of message.content) {
      const pending = run.pending.get(result.toolCallId);
      if (!pending) continue;
      pending.resolve({ content: toolResultContent(result.output), isError: result.output.type.startsWith('error-') });
      run.pending.delete(result.toolCallId);
    }
  }
  const activeRun = run;
  let parked = false;
  let complete = false;
  const abort = () => activeRun.dispose();
  params.abortSignal?.addEventListener('abort', abort, { once: true });
  if (params.abortSignal?.aborted) abort();
  const iterator = (async function* () {
    yield { type: 'stream-start', warnings: [] };
    const openBlocks = new Map();
    let usage = emptyUsage();
    try {
      while (true) {
        const next = await activeRun.queue.next();
        if (next.done) {
          if (activeRun.controller.signal.aborted) throw new Error('Claude Code task stopped');
          throw new Error('Claude Code ended without a result');
        }
        const event = next.value;
        if (event.type === 'bridge-error') throw event.error;
        if (event.type === 'host-tool') {
          parked = true;
          yield { type: 'tool-input-start', id: event.call.id, toolName: event.call.name };
          yield { type: 'tool-input-delta', id: event.call.id, delta: event.call.input };
          yield { type: 'tool-input-end', id: event.call.id };
          yield { type: 'tool-call', toolCallId: event.call.id, toolName: event.call.name, input: event.call.input };
          activeRun.reportedUsage = combineUsage(activeRun.reportedUsage, usage);
          yield { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage };
          return;
        }
        if (event.type === 'stream_event') {
          const part = event.event;
          if (part.type === 'content_block_start' && ['text', 'thinking'].includes(part.content_block.type)) {
            const kind = part.content_block.type === 'text' ? 'text' : 'reasoning';
            const id = `${kind}_${randomUUID()}`;
            openBlocks.set(part.index, { kind, id });
            yield { type: `${kind}-start`, id };
          }
          if (part.type === 'content_block_delta') {
            const block = openBlocks.get(part.index);
            if (block && ['text_delta', 'thinking_delta'].includes(part.delta.type)) yield { type: `${block.kind}-delta`, id: block.id, delta: part.delta.text ?? part.delta.thinking };
          }
          if (part.type === 'content_block_stop') {
            const block = openBlocks.get(part.index);
            if (block) { yield { type: `${block.kind}-end`, id: block.id }; openBlocks.delete(part.index); }
          }
        }
        if (event.type === 'assistant' && !activeRun.seenUsage.has(event.message.id)) {
          activeRun.seenUsage.add(event.message.id);
          usage = combineUsage(usage, sdkUsage(event.message.usage));
        }
        if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success') throw new Error('Claude Code could not complete the task');
          for (const block of openBlocks.values()) yield { type: `${block.kind}-end`, id: block.id };
          const remainingUsage = combineUsage(sdkUsage(event.usage), activeRun.reportedUsage, -1);
          yield { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: remainingUsage };
          complete = true;
          return;
        }
      }
    } finally {
      params.abortSignal?.removeEventListener('abort', abort);
      if (!parked || complete) activeRun.dispose();
    }
  })();
  return {
    stream: new ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) { activeRun.dispose(); controller.error(error); }
      },
      async cancel() { activeRun.dispose(); await iterator.return(); },
    }),
  };
}
