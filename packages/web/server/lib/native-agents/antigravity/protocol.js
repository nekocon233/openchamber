// Protocol boundaries for Antigravity CLI (agy). The stream shapes follow the
// documented headless protocol and Paseo's antigravity-provider wire adapter:
// https://github.com/getpaseo/paseo/tree/main/plugins/antigravity-provider
// Transcript reading follows the MIT-licensed community provider:
// https://github.com/lefos13/paseo-plugin-antigravity-cli

import { z } from 'zod';

const usage = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  thinking_tokens: z.number().nonnegative().default(0),
  cache_read_tokens: z.number().nonnegative().default(0),
  total_tokens: z.number().nonnegative().optional(),
}).passthrough();

const toolInfo = z.object({
  name: z.string(),
  parameters: z.record(z.string(), z.json()).default({}),
  output: z.string().default(''),
  error: z.object({ type: z.string(), message: z.string() }).nullable().default(null),
}).passthrough();

const subagentInfo = z.object({
  subagents: z.array(z.object({
    type_name: z.string(),
    role: z.string().default(''),
    initial_prompt: z.string().default(''),
    conversation_id: z.string().nullable().default(null),
    log_uri: z.string().default(''),
    workspace_uris: z.array(z.string()).default([]),
  }).passthrough()),
}).passthrough();

const step = z.object({
  conversation_id: z.string(),
  step_index: z.number().int().nonnegative(),
  state: z.string(),
  step_type: z.string(),
  text_delta: z.string().default(''),
  tool_name: z.string().default(''),
  tool_info: toolInfo.nullable().default(null),
  subagent_info: subagentInfo.nullable().default(null),
  usage: usage.nullable().default(null),
  duration_seconds: z.number().nonnegative().optional(),
}).passthrough();

const result = z.object({
  conversation_id: z.string(),
  status: z.string(),
  response: z.string().default(''),
  error: z.string().optional(),
  usage: usage.optional(),
  num_turns: z.number().int().nonnegative().optional(),
  duration_seconds: z.number().nonnegative().optional(),
  denied_actions: z.array(z.object({
    action: z.string(),
    display_name: z.string(),
  }).passthrough()).default([]),
}).passthrough();

const frame = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('init'),
    conversation_id: z.string().min(1),
    init: z.object({
      cwd: z.string().optional(),
      model: z.string().nullable().default(null),
      permission_mode: z.string().optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({ event: z.literal('step_update'), step_update: step }).passthrough(),
  z.object({ event: z.literal('result'), result }).passthrough(),
]);

export const parseAgyStreamFrame = (line) => frame.parse(JSON.parse(line));

export const encodeAgyPrompt = (text) => `${JSON.stringify({
  event: 'user',
  message: { content: text },
})}\n`;

const transcriptToolCall = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.json()).default({}),
}).passthrough();

const transcriptStep = z.object({
  step_index: z.number().int().nonnegative(),
  type: z.string().min(1),
  status: z.string().optional(),
  source: z.string().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
  created_at: z.string().optional(),
  tool_calls: z.array(transcriptToolCall).default([]),
  usage: usage.optional(),
}).passthrough();

const KNOWN_TRANSCRIPT_TYPES = new Set([
  'USER_INPUT',
  'PLANNER_RESPONSE',
  'GENERIC',
  'SYSTEM_MESSAGE',
  'EPHEMERAL_MESSAGE',
  'ERROR_MESSAGE',
  'CHECKPOINT',
]);

/** Only newline-terminated records are complete while agy is appending. */
export const parseAgyTranscript = (text) => {
  const byStep = new Map();
  let malformed = 0;
  const unknownTypes = new Set();
  for (const line of text.split('\n').slice(0, -1)) {
    if (line.trim() === '') continue;
    let decoded;
    try {
      decoded = transcriptStep.parse(JSON.parse(line));
    } catch {
      malformed += 1;
      continue;
    }
    if (!KNOWN_TRANSCRIPT_TYPES.has(decoded.type)) unknownTypes.add(decoded.type);
    byStep.set(decoded.step_index, decoded);
  }
  return {
    entries: [...byStep.values()].sort((left, right) => left.step_index - right.step_index),
    malformed,
    unknownTypes: [...unknownTypes],
  };
};

/** agy JSON-encodes tool argument values and adds narration beside them. */
export const decodeAgyToolArguments = (args) => {
  const parameters = {};
  let title;
  for (const [key, raw] of Object.entries(args)) {
    let value = raw;
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    if (key === 'toolSummary' || key === 'toolAction') {
      if (typeof value === 'string' && title === undefined) title = value;
    } else {
      parameters[key] = value;
    }
  }
  return { parameters, title };
};

export const agyTime = (value, fallback) => {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const agyTokenUsage = (value) => ({
  total: value.total_tokens ?? value.input_tokens + value.output_tokens,
  input: value.input_tokens,
  output: value.output_tokens,
  reasoning: value.thinking_tokens,
  cache: { read: value.cache_read_tokens, write: 0 },
});
