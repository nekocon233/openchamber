import { MISSING_TOOL_RESULT } from './antigravity/history-projection.js';
import { withAgyFileDetails } from './antigravity/tools.js';
import { UNFINISHED_TOOL_ERROR } from './claude/tools.js';
import type { NativeMessageRecord, NativeToolPart } from './records.js';

const isNumber = (value: unknown): value is number => typeof value === 'number';

const SYNTHETIC_UNSETTLED_TOOL_ERRORS = new Set([UNFINISHED_TOOL_ERROR, MISSING_TOOL_RESULT]);

const hasRunningTool = (record: NativeMessageRecord): boolean => record.parts.some(
  (part) => part.type === 'tool' && part.state.status === 'running',
);

const isUnsettledHistoryTool = (part: NativeToolPart | undefined): boolean => {
  if (!part) return true;
  if (part.state.status === 'running') return true;
  return part.state.status === 'error' && SYNTHETIC_UNSETTLED_TOOL_ERRORS.has(part.state.error);
};

const hasUnsettledLiveTool = (liveRecord: NativeMessageRecord, historyRecord: NativeMessageRecord): boolean => {
  const historyTools = new Map(
    historyRecord.parts
      .filter((part): part is NativeToolPart => part.type === 'tool')
      .map((part) => [part.callID, part] as const),
  );
  return liveRecord.parts.some((part) => (
    part.type === 'tool'
    && part.state.status === 'running'
    && isUnsettledHistoryTool(historyTools.get(part.callID))
  ));
};

const withHistoryMeasurements = (liveRecord: NativeMessageRecord, historyRecord: NativeMessageRecord): NativeMessageRecord => {
  const live = liveRecord.info;
  const history = historyRecord.info;
  if (live.role !== 'assistant' || history.role !== 'assistant') return liveRecord;
  if (
    !isNumber(live.time.completed)
    && isNumber(history.time.completed)
    && !hasRunningTool(historyRecord)
    && !hasUnsettledLiveTool(liveRecord, historyRecord)
  ) {
    return historyRecord;
  }
  if (live.tokens !== undefined && live.contextWindow !== undefined && live.contextCompaction !== undefined) return liveRecord;
  const info = { ...live };
  if (info.tokens === undefined && history.tokens !== undefined) info.tokens = history.tokens;
  if (info.contextWindow === undefined && history.contextWindow !== undefined) info.contextWindow = history.contextWindow;
  if (info.contextCompaction === undefined && history.contextCompaction !== undefined) info.contextCompaction = history.contextCompaction;
  if (info.tokens === live.tokens && info.contextWindow === live.contextWindow
    && info.contextCompaction === live.contextCompaction) return liveRecord;
  return { ...liveRecord, info };
};

export const overlay = (
  history: NativeMessageRecord[],
  live: ReadonlyArray<NativeMessageRecord> | null | undefined,
): NativeMessageRecord[] => {
  if (!live || live.length === 0) return history;
  const liveById = new Map(live.map((record) => [record.info.id, record]));
  const merged = history.map((record) => {
    const liveRecord = liveById.get(record.info.id);
    if (!liveRecord) return record;
    const measured = withHistoryMeasurements(liveRecord, record);
    if (!record.info.id.startsWith('nag_') || measured === record) return measured;
    const saved = new Map(record.parts.map((part) => [part.id, part]));
    const parts = measured.parts.map((part) => withAgyFileDetails(part, saved.get(part.id)));
    return parts.some((part, index) => part !== measured.parts[index]) ? { ...measured, parts } : measured;
  });
  const known = new Set(history.map((record) => record.info.id));
  for (const record of live) if (!known.has(record.info.id)) merged.push(record);
  return merged
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (left.record.info.time.created - right.record.info.time.created) || (left.index - right.index))
    .map(({ record }) => record);
};
