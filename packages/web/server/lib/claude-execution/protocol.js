import { z } from 'zod';

export const EXECUTION_HEADER = 'x-openchamber-claude-execution';
export const CONTEXT_HEADER = 'x-openchamber-claude-context';
const executionContextSchema = z.object({
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  directory: z.string().min(1),
  agent: z.string(),
  preserveSystemPrefix: z.boolean().optional(),
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  contextLimit: z.number().nonnegative(),
  variant: z.string().optional(),
});

const jsonObject = z.record(z.string(), z.json());
const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
  z.object({ type: z.literal('url'), url: z.string().url() }),
]);
const toolContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), source: sourceSchema }),
]);
const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.object({ type: z.literal('image'), source: sourceSchema }),
  z.object({ type: z.literal('document'), source: sourceSchema, title: z.string().optional() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: jsonObject }),
  z.object({
    type: z.literal('tool_result'), tool_use_id: z.string(),
    content: z.union([z.string(), z.array(toolContentSchema)]).default('').transform((value) => Array.isArray(value) ? value : [{ type: 'text', text: value }]),
    is_error: z.boolean().optional(),
  }),
]);

export const messagesRequestSchema = z.object({
  model: z.string(),
  stream: z.literal(true),
  system: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]).optional().transform((value) => Array.isArray(value) ? value.map((block) => block.text).join('\n\n') : value),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.union([z.string(), z.array(blockSchema)]).transform((value) => Array.isArray(value) ? value : [{ type: 'text', text: value }]) })),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional(), input_schema: jsonObject })).optional(),
  tool_choice: z.object({ type: z.enum(['auto', 'any', 'none', 'tool']), name: z.string().optional() }).optional(),
  max_tokens: z.number().int().positive(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});

export const readExecutionContext = (headers) => {
  const value = new Headers(headers).get(CONTEXT_HEADER);
  if (!value) throw new Error('Claude Code execution context is missing');
  return executionContextSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
};

const withoutExecutionHeaders = (headers) => {
  const result = new Headers(headers);
  result.delete(EXECUTION_HEADER);
  result.delete(CONTEXT_HEADER);
  return Object.fromEntries(result);
};

const toFile = (block) => {
  const file = {
    type: 'file',
    mediaType: block.source.type === 'base64' ? block.source.media_type : block.type === 'document' ? 'application/pdf' : 'image/*',
    data: block.source.type === 'base64' ? Buffer.from(block.source.data, 'base64') : new URL(block.source.url),
  };
  if (block.type === 'document' && block.title) file.filename = block.title;
  return file;
};

const toolOutput = (block) => {
  if (block.content.every((part) => part.type === 'text')) return { type: block.is_error ? 'error-text' : 'text', value: block.content.map((part) => part.text).join('\n') };
  if (block.is_error) throw new Error('A failed tool returned unsupported binary content');
  return { type: 'content', value: block.content.map((part) => {
    if (part.type === 'text') return part;
    return part.source.type === 'base64'
      ? { type: 'image-data', data: part.source.data, mediaType: part.source.media_type }
      : { type: 'image-url', url: part.source.url };
  }) };
};

// Only model protocol conversion happens here. Tool execution remains in OpenCode.
export function toLanguageModelCall(request, providerOptions, abortSignal, reasoningHistory = new Map(), format = 'anthropic') {
  const prompt = [];
  if (request.system && format !== 'responses') {
    prompt.push({ role: 'system', content: request.system });
  }
  for (const message of request.messages) {
    const blocks = message.content;
    if (message.role === 'system') {
      if (blocks.some((block) => block.type !== 'text')) throw new Error('System messages must contain text');
      prompt.push({ role: 'system', content: blocks.map((block) => block.text).join('\n\n') });
      continue;
    }
    let content = [];
    const flush = () => {
      if (content.length) prompt.push({ role: message.role, content });
      content = [];
    };
    for (const block of blocks) {
      switch (block.type) {
        case 'text': content.push({ type: 'text', text: block.text }); break;
        case 'image':
        case 'document': content.push(toFile(block)); break;
        case 'thinking': {
          const metadata = reasoningHistory.get(block.thinking);
          if (metadata || block.signature) content.push({
            type: 'reasoning', text: block.thinking,
            providerOptions: metadata ?? { anthropic: { signature: block.signature } },
          });
          break;
        }
        case 'redacted_thinking':
          content.push({ type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: block.data } } });
          break;
        case 'tool_use':
          content.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, input: block.input });
          break;
        case 'tool_result':
          flush();
          prompt.push({ role: 'tool', content: [{
            type: 'tool-result', toolCallId: block.tool_use_id, toolName: toolNameFor(request.messages, block.tool_use_id),
            output: toolOutput(block),
          }] });
          break;
      }
    }
    flush();
  }
  const choice = request.tool_choice;
  const sourceOptions = format === 'responses'
    ? { ...providerOptions, openai: { ...providerOptions?.openai, instructions: request.system ?? '' } }
    : providerOptions;
  return {
    prompt,
    tools: request.tools?.map((item) => {
      const tool = { type: 'function', name: item.name, description: item.description, inputSchema: item.input_schema };
      if (format === 'responses') tool.strict = false;
      return tool;
    }),
    toolChoice: choice?.type === 'tool' ? { type: 'tool', toolName: choice.name }
      : { type: choice?.type === 'any' ? 'required' : choice?.type ?? 'auto' },
    maxOutputTokens: request.max_tokens,
    temperature: request.temperature,
    topP: request.top_p,
    providerOptions: sourceOptions,
    abortSignal,
  };
}

function toolNameFor(messages, id) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const call = message.content.find((b) => b.type === 'tool_use' && b.id === id);
    if (call) return call.name;
  }
  throw new Error('Tool result has no matching call');
}

export const emptyUsage = () => ({
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
});

export const sdkUsage = (usage) => ({
  inputTokens: {
    total: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    noCache: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  },
  outputTokens: { total: usage.output_tokens ?? 0, text: undefined, reasoning: undefined },
});

function sourceProviderOptions(params, format, providerID) {
  const key = format === 'responses' ? 'openai' : format === 'anthropic' ? 'anthropic' : 'openaiCompatible';
  const options = { ...params.providerOptions, [key]: { ...params.providerOptions?.[providerID], ...params.providerOptions?.[key] } };
  if (format === 'responses') {
    options.openai = { store: false, include: ['reasoning.encrypted_content'], ...options.openai };
    if (options.openai.reasoningEffort !== undefined) options.openai.forceReasoning = true;
  }
  if (format === 'anthropic' && providerID === 'kimi-for-coding') {
    options.anthropic = { thinking: { type: 'adaptive' }, effort: 'high', toolStreaming: false, ...options.anthropic };
  }
  return options;
}

export function cleanSourceCall(params, format, providerID) {
  const providerOptions = sourceProviderOptions(params, format, providerID);
  const key = format === 'responses' ? 'openai' : format === 'anthropic' ? 'anthropic' : 'openaiCompatible';
  const normalizeOptions = (value) => {
    if (!value) return value;
    const next = { ...value, [key]: { ...value[providerID], ...value[key] } };
    if (format === 'responses' && providerOptions.openai.store !== true) delete next.openai.itemId;
    return next;
  };
  return {
    ...params,
    tools: format === 'responses' ? params.tools?.map((tool) => tool.type === 'function' ? { ...tool, strict: false } : tool) : params.tools,
    headers: withoutExecutionHeaders(params.headers),
    providerOptions,
    prompt: params.prompt.map((message) => {
      const next = { ...message, providerOptions: normalizeOptions(message.providerOptions) };
      if (Array.isArray(message.content)) next.content = message.content.map((part) => ({ ...part, providerOptions: normalizeOptions(part.providerOptions) }));
      return next;
    }),
  };
}
