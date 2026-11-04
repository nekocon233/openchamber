import { createHash } from 'node:crypto';
import { z } from 'zod';

const counter = z.number().finite().nonnegative();
const interval = z.object({ start: counter, end: counter }).refine((time) => time.end >= time.start);
const tokens = z.object({
  total: counter.optional(), input: counter, output: counter, reasoning: counter,
  cache: z.object({ read: counter, write: counter }),
});
const partMeasurement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), id: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/), time: interval }),
  z.object({ type: z.literal('tool'), callID: z.string().min(1), time: interval }),
]);

// Only stream measurements missing from native logs. No text or tool payloads.
export const antigravityMeasurementsSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({
    messageID: z.string().min(1), completed: counter,
    tokens: tokens.optional(), parts: z.array(partMeasurement).max(4096),
  })).max(4096),
});

const textHash = (text) => createHash('sha256').update(text).digest('hex');
const measuredTime = (time) => interval.safeParse(time).data;
const measuredTokens = (value) => tokens.safeParse(value).data;
const inside = (time, created, completed) => time.start >= created && time.end <= completed;

export const captureAntigravityMeasurements = (records, parentID) => ({
  version: 1,
  records: records.flatMap(({ info, parts }) => {
    if (info.role !== 'assistant' || info.parentID !== parentID || !Number.isFinite(info.time.completed)) return [];
    const completed = info.time.completed;
    const usage = measuredTokens(info.tokens);
    const measurement = {
      messageID: info.id, completed,
      parts: parts.flatMap((part) => {
        if (part.type === 'text' && part.text) {
          const time = measuredTime(part.time);
          return time && inside(time, info.time.created, completed)
            ? [{ type: 'text', id: part.id, hash: textHash(part.text), time }] : [];
        }
        if (part.type !== 'tool' || !['completed', 'error'].includes(part.state.status)
          || part.state.metadata?.openchamberToolSource === 'native-interaction'
          || part.state.error === 'Antigravity tool completion was not recorded') return [];
        const time = measuredTime(part.state.time);
        return time && inside(time, info.time.created, completed)
          ? [{ type: 'tool', callID: part.callID, time }] : [];
      }),
    };
    if (usage) measurement.tokens = usage;
    return [measurement];
  }),
});

// Saved IDs and native usage must still agree. A changed native response owns
// its new counters and text; a stream checkpoint cannot restore stale values.
const sameUsage = (native, saved) => !native || native.input === saved.input
  && native.output + native.reasoning === saved.output + saved.reasoning
  && native.cache.read === saved.cache.read && native.cache.write === saved.cache.write;

export const restoreAntigravityMeasurements = (records, sends) => {
  const byParent = new Map([...sends.values()].map((send) => [send.messageId,
    new Map((send.antigravity?.measurements?.records ?? []).map((record) => [record.messageID, record]))]));
  for (const record of records) {
    const { info } = record;
    if (info.role !== 'assistant') continue;
    const saved = byParent.get(info.parentID)?.get(info.id);
    if (!saved || saved.completed < info.time.created || saved.tokens && !sameUsage(info.tokens, saved.tokens)) continue;
    info.time.completed = Math.max(info.time.completed ?? 0, saved.completed);
    if (saved.tokens) info.tokens = structuredClone(saved.tokens);
    const textTimes = new Map(saved.parts.filter((part) => part.type === 'text').map((part) => [part.id, part]));
    const toolTimes = new Map(saved.parts.filter((part) => part.type === 'tool').map((part) => [part.callID, part.time]));
    for (const part of record.parts) {
      if (part.type === 'text') {
        const text = textTimes.get(part.id);
        if (text && text.hash === textHash(part.text) && inside(text.time, info.time.created, info.time.completed)) {
          part.time = { ...text.time };
        }
      } else if (part.type === 'tool' && ['completed', 'error'].includes(part.state.status)) {
        const time = toolTimes.get(part.callID);
        if (time && inside(time, info.time.created, info.time.completed)) part.state.time = { ...time };
      }
    }
  }
};
