import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '../../shared/json-values.js';

const counter = z.number().finite().nonnegative();
const interval = z.object({ start: counter, end: counter }).refine((time) => time.end >= time.start);
const tokens = z.object({
  total: counter.optional(),
  input: counter,
  output: counter,
  reasoning: counter,
  cache: z.object({ read: counter, write: counter }),
});
const partMeasurement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), id: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/), time: interval }),
  z.object({ type: z.literal('tool'), callID: z.string().min(1), time: interval }),
]);

export const antigravityMeasurementsSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({
    messageID: z.string().min(1),
    completed: counter,
    tokens: tokens.optional(),
    parts: z.array(partMeasurement).max(4096),
  })).max(4096),
});

export type AntigravityTimeInterval = z.infer<typeof interval>;
export type AntigravityMeasurementTokens = z.infer<typeof tokens>;
export type AntigravityPartMeasurement = z.infer<typeof partMeasurement>;
export type AntigravityRecordMeasurement = z.infer<typeof antigravityMeasurementsSchema>['records'][number];
export type AntigravityMeasurements = z.infer<typeof antigravityMeasurementsSchema>;

export interface AgyMeasurementTokenSummary {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface AgyMeasurementTimeRange {
  start: number;
  end?: number;
}

export interface AgyMeasurementToolMetadata {
  openchamberToolSource?: JsonValue | undefined;
}

export type AgyMeasurementPart =
  | {
      type: 'text';
      id: string;
      text: string;
      time: AgyMeasurementTimeRange;
    }
  | {
      type: 'tool';
      callID: string;
      state:
        | { status: 'completed'; time: AgyMeasurementTimeRange; metadata?: AgyMeasurementToolMetadata | undefined }
        | { status: 'error'; error: string; time: AgyMeasurementTimeRange; metadata?: AgyMeasurementToolMetadata | undefined }
        | { status: 'running'; time: AgyMeasurementTimeRange; metadata?: AgyMeasurementToolMetadata | undefined };
    }
  | { type: 'reasoning' | 'file' | 'compaction' };

export type AgyMeasurementMessageInfo =
  | {
      role: 'assistant';
      id: string;
      parentID: string;
      time: { created: number; completed?: number };
      tokens?: AgyMeasurementTokenSummary;
    }
  | {
      role: 'user' | 'compaction';
      id: string;
    };

export interface AgyMeasurementRecord {
  info: AgyMeasurementMessageInfo;
  parts: AgyMeasurementPart[];
}

export interface AgyMeasurementSendRecord {
  messageId: string;
  antigravity?: {
    measurements?: AntigravityMeasurements | undefined;
  } | undefined;
}

const isFiniteNumber = (value: number | undefined): value is number => Number.isFinite(value);

const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

const measuredTime = (time: AgyMeasurementTimeRange | undefined): AntigravityTimeInterval | undefined => interval.safeParse(time).data;

const measuredTokens = (value: AgyMeasurementTokenSummary | undefined): AntigravityMeasurementTokens | undefined => tokens.safeParse(value).data;

const inside = (time: AntigravityTimeInterval, created: number, completed: number): boolean => (
  time.start >= created && time.end <= completed
);

export const captureAntigravityMeasurements = (
  records: readonly AgyMeasurementRecord[],
  parentID: string,
): AntigravityMeasurements => ({
  version: 1,
  records: records.flatMap(({ info, parts }) => {
    if (info.role !== 'assistant' || info.parentID !== parentID || !isFiniteNumber(info.time.completed)) return [];
    const completed = info.time.completed;
    const usage = measuredTokens(info.tokens);
    const measurement: AntigravityRecordMeasurement = {
      messageID: info.id,
      completed,
      parts: parts.flatMap((part): AntigravityPartMeasurement[] => {
        if (part.type === 'text' && part.text) {
          const time = measuredTime(part.time);
          return time && inside(time, info.time.created, completed)
            ? [{ type: 'text', id: part.id, hash: textHash(part.text), time }]
            : [];
        }
        if (part.type !== 'tool'
          || (part.state.status !== 'completed' && part.state.status !== 'error')
          || part.state.metadata?.openchamberToolSource === 'native-interaction'
          || (part.state.status === 'error' && part.state.error === 'Antigravity tool completion was not recorded')) return [];
        const time = measuredTime(part.state.time);
        return time && inside(time, info.time.created, completed)
          ? [{ type: 'tool', callID: part.callID, time }]
          : [];
      }),
    };
    if (usage) measurement.tokens = usage;
    return [measurement];
  }),
});

const sameUsage = (
  native: AgyMeasurementTokenSummary | undefined,
  saved: AntigravityMeasurementTokens,
): boolean => (
  !native
  || (
    native.input === saved.input
    && native.output + native.reasoning === saved.output + saved.reasoning
    && native.cache.read === saved.cache.read
    && native.cache.write === saved.cache.write
  )
);

export const restoreAntigravityMeasurements = (
  records: readonly AgyMeasurementRecord[],
  sends: ReadonlyMap<string, AgyMeasurementSendRecord>,
): void => {
  const byParent = new Map<string, Map<string, AntigravityRecordMeasurement>>(
    [...sends.values()].map((send) => [
      send.messageId,
      new Map((send.antigravity?.measurements?.records ?? []).map((record) => [record.messageID, record])),
    ]),
  );
  for (const record of records) {
    const { info } = record;
    if (info.role !== 'assistant') continue;
    const saved = byParent.get(info.parentID)?.get(info.id);
    if (!saved || saved.completed < info.time.created || (saved.tokens && !sameUsage(info.tokens, saved.tokens))) continue;
    const completed = Math.max(info.time.completed ?? 0, saved.completed);
    info.time.completed = completed;
    if (saved.tokens) {
      const sum = saved.tokens.input + saved.tokens.output + saved.tokens.reasoning + saved.tokens.cache.read + saved.tokens.cache.write;
      info.tokens = { ...structuredClone(saved.tokens), total: Math.max(saved.tokens.total ?? 0, sum) };
    }
    const textTimes = new Map<string, Extract<AntigravityPartMeasurement, { type: 'text' }>>();
    const toolTimes = new Map<string, AntigravityTimeInterval>();
    for (const part of saved.parts) {
      if (part.type === 'text') textTimes.set(part.id, part);
      else toolTimes.set(part.callID, part.time);
    }
    for (const part of record.parts) {
      if (part.type === 'text') {
        const text = textTimes.get(part.id);
        if (text && text.hash === textHash(part.text) && inside(text.time, info.time.created, completed)) {
          part.time = { ...text.time };
        }
      } else if (part.type === 'tool' && (part.state.status === 'completed' || part.state.status === 'error')) {
        const time = toolTimes.get(part.callID);
        if (time && inside(time, info.time.created, completed)) part.state.time = { ...time };
      }
    }
  }
};
