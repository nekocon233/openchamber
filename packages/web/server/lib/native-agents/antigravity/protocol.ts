import { z } from 'zod';
import { isRecord, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';

const jsonValueSchema = z.json();

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

const subagentEntry = z.object({
  type_name: z.string(),
  role: z.string().default(''),
  initial_prompt: z.string().default(''),
  conversation_id: z.string().nullable().default(null),
  log_uri: z.string().default(''),
  workspace_uris: z.array(z.string()).default([]),
}).passthrough();

const subagentInfo = z.object({
  subagents: z.array(subagentEntry),
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
  thinking: z.string().optional(),
  error: z.string().optional(),
  created_at: z.string().optional(),
  tool_calls: z.array(transcriptToolCall).default([]),
  usage: usage.optional(),
  input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative().optional(),
  thinking_tokens: z.number().nonnegative().optional(),
  cache_read_tokens: z.number().nonnegative().optional(),
  total_tokens: z.number().nonnegative().optional(),
  truncated_fields: z.array(z.string()).default([]),
  subagent_info: subagentInfo.nullable().optional(),
}).passthrough();

export type AgyUsage = z.infer<typeof usage>;
export type AgyToolInfo = z.infer<typeof toolInfo>;
export type AgySubagentEntry = z.infer<typeof subagentEntry>;
export type AgyValidSubagentReference = AgySubagentEntry & { conversation_id: string };
export type AgySubagentInfo = z.infer<typeof subagentInfo>;
export type AgyStepUpdate = z.infer<typeof step>;
export type AgyResult = z.infer<typeof result>;
export type AgyStreamFrame = z.infer<typeof frame>;
export type AgyInitFrame = Extract<AgyStreamFrame, { event: 'init' }>;

export interface AgyTranscriptToolCall {
  name: string;
  args: JsonObject;
  argumentsEncoded?: boolean | undefined;
  truncated?: boolean | undefined;
  args_truncated?: boolean | undefined;
  input_truncated?: boolean | undefined;
  truncated_fields?: string[] | undefined;
}

export interface AgyTranscriptStep {
  step_index: number;
  type: string;
  status?: string | undefined;
  source?: string | undefined;
  content?: string | undefined;
  thinking?: string | undefined;
  error?: string | undefined;
  created_at?: string | undefined;
  tool_calls: AgyTranscriptToolCall[];
  usage?: AgyUsage | undefined;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  thinking_tokens?: number | undefined;
  cache_read_tokens?: number | undefined;
  total_tokens?: number | undefined;
  truncated_fields: string[];
  subagent_info?: AgySubagentInfo | null | undefined;
  reasoningKnown?: boolean | undefined;
  truncated?: boolean | undefined;
  args_truncated?: boolean | undefined;
  input_truncated?: boolean | undefined;
}

export interface AgyParsedTranscript {
  entries: AgyTranscriptStep[];
  malformed: number;
  unknownTypes: string[];
}

export interface AgyTokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface AgyDecodedToolArguments {
  parameters: JsonObject;
  title: string | undefined;
}

export const parseAgyStreamFrame = (line: string): AgyStreamFrame => frame.parse(JSON.parse(line));

export const agyPermissionError = (actions: readonly string[]): string => (
  `Antigravity stopped because these tools require permission: ${actions.join(', ')}. Interactive permission approvals are unavailable in this session. Review the CLI permissions, then send another message to continue.`
);

export const encodeAgyPrompt = (text: string): string => `${JSON.stringify({
  event: 'user',
  message: { content: text },
})}\n`;

const hasValidConversationId = (agent: AgySubagentEntry): agent is AgyValidSubagentReference => (
  z.string().uuid().safeParse(agent.conversation_id).success
);

export const agySubagentReferences = (
  info: AgySubagentInfo | null | undefined,
): AgyValidSubagentReference[] => (info?.subagents ?? []).filter(hasValidConversationId);

export const agyConversationMessage = (
  content = '',
): { sender: string; content: string } | null => {
  const match = /(?:^|\r?\n)<SYSTEM_MESSAGE>\r?\n\[Message\] timestamp=\S+ sender=(\S+) priority=\S+ content=([\s\S]*)$/.exec(content);
  const sender = match?.[1];
  const body = match?.[2];
  if (!sender || body === undefined || !z.string().uuid().safeParse(sender).success) return null;
  const text = body.replace(/\r?\n<\/SYSTEM_MESSAGE>\s*$/, '').trim();
  return text ? { sender, content: text } : null;
};

const KNOWN_TRANSCRIPT_TYPES = new Set([
  'USER_INPUT',
  'PLANNER_RESPONSE',
  'GENERIC',
  'SYSTEM_MESSAGE',
  'EPHEMERAL_MESSAGE',
  'ERROR_MESSAGE',
  'CHECKPOINT',
]);

export const parseAgyTranscript = (
  text: string,
  { encodedArguments = true }: { encodedArguments?: boolean | undefined } = {},
): AgyParsedTranscript => {
  const byStep = new Map<number, AgyTranscriptStep>();
  let malformed = 0;
  const unknownTypes = new Set<string>();
  for (const line of text.split('\n').slice(0, -1)) {
    if (line.trim() === '') continue;
    let decoded: AgyTranscriptStep;
    try {
      const raw: unknown = JSON.parse(line);
      const parsed = transcriptStep.parse(raw);
      const rawUsage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : isRecord(raw) ? raw : null;
      decoded = {
        ...parsed,
        tool_calls: parsed.tool_calls.map((call) => ({ ...call, argumentsEncoded: encodedArguments })),
      };
      if (!rawUsage || !Object.hasOwn(rawUsage, 'thinking_tokens')) decoded.reasoningKnown = false;
    } catch {
      malformed += 1;
      continue;
    }
    if (!KNOWN_TRANSCRIPT_TYPES.has(decoded.type)) unknownTypes.add(decoded.type);
    if (!decoded.usage) {
      const flatUsage = usage.safeParse({
        input_tokens: decoded.input_tokens,
        output_tokens: decoded.output_tokens,
        thinking_tokens: decoded.thinking_tokens,
        cache_read_tokens: decoded.cache_read_tokens,
        total_tokens: decoded.total_tokens,
      });
      if (flatUsage.success) decoded.usage = flatUsage.data;
    }
    byStep.set(decoded.step_index, decoded);
  }
  return {
    entries: [...byStep.values()].sort((left, right) => left.step_index - right.step_index),
    malformed,
    unknownTypes: [...unknownTypes],
  };
};

export const decodeAgyToolArguments = (
  args: JsonObject,
  encoded = true,
): AgyDecodedToolArguments => {
  const parameters: Array<[string, JsonValue | undefined]> = [];
  let title: string | undefined;
  for (const [key, raw] of Object.entries(args)) {
    let value: JsonValue | undefined = raw;
    if (encoded && isString(raw)) {
      try {
        const parsed = jsonValueSchema.safeParse(JSON.parse(raw));
        value = parsed.success ? parsed.data : raw;
      } catch {
        value = raw;
      }
    }
    if (key === 'toolSummary' || key === 'toolAction') {
      if (isString(value) && title === undefined) title = value;
    } else {
      parameters.push([key, value]);
    }
  }
  return { parameters: Object.fromEntries(parameters), title };
};

export const agyTime = (value: string | null | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const agyTokenUsage = (value: AgyUsage): AgyTokenUsage | undefined => (
  value.thinking_tokens > value.output_tokens
    ? undefined
    : {
        total: Math.max(value.total_tokens ?? 0, value.input_tokens + value.output_tokens + value.cache_read_tokens),
        input: value.input_tokens,
        output: value.output_tokens - value.thinking_tokens,
        reasoning: value.thinking_tokens,
        cache: { read: value.cache_read_tokens, write: 0 },
      }
);
