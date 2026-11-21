import { antigravityVisiblePromptText } from '../prompt-parts.js';
import { agyConversationMessage, agyTime, agyTokenUsage } from './protocol.js';
import type { AgyTokenUsage, AgyTranscriptStep } from './protocol.js';
import { agyBackgroundResults } from './tasks.js';
import { mapAgyTool } from './tools.js';

export interface AgyStatisticsSendRecord {
  modelID: string;
  agent: string;
  antigravity?: {
    stepIndex?: number | undefined;
    fingerprint?: string | undefined;
  } | undefined;
}

export interface AgyStatisticsInput {
  nativeId: string;
  entries: readonly AgyTranscriptStep[];
  sends: ReadonlyMap<string, AgyStatisticsSendRecord>;
  parentID?: string | null | undefined;
  tools?: 'none' | 'detail' | undefined;
}

export interface AgyStatisticsToolTime {
  start: number;
  end?: number;
}

export interface AgyStatisticsToolPart {
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'running' | 'error' | 'completed';
    time: AgyStatisticsToolTime;
  };
}

export interface AgyStatisticsUserRecord {
  info: { id: string; role: 'user'; time: { created: number } };
  parts: Array<{ type: 'text' }>;
}

export interface AgyStatisticsAssistantInfo {
  id: string;
  role: 'assistant';
  time: { created: number };
  providerID: 'antigravity-native';
  modelID: string;
  tokens?: AgyTokenUsage;
  reasoningKnown: boolean;
}

export interface AgyStatisticsAssistantRecord {
  info: AgyStatisticsAssistantInfo;
  parts: AgyStatisticsToolPart[];
}

export type AgyStatisticsRecord = AgyStatisticsUserRecord | AgyStatisticsAssistantRecord;

export const antigravityStatisticsRecords = ({
  nativeId,
  entries,
  sends,
  parentID,
  tools,
}: AgyStatisticsInput): AgyStatisticsRecord[] => {
  const key = nativeId.replaceAll('-', '');
  const bindings = new Map<number, AgyStatisticsSendRecord>();
  for (const send of sends.values()) {
    if (send.antigravity?.stepIndex !== undefined) bindings.set(send.antigravity.stepIndex, send);
  }
  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const background = tools === 'detail' ? agyBackgroundResults(entries, nativeId) : new Map<number, AgyTranscriptStep>();
  const records: AgyStatisticsRecord[] = [];
  let selection: AgyStatisticsSendRecord | null = null;
  for (const entry of entries) {
    const at = agyTime(entry.created_at, 0);
    const message = entry.type === 'SYSTEM_MESSAGE' ? agyConversationMessage(entry.content) : null;
    if (entry.type === 'USER_INPUT' || (message && `nag_${message.sender}` === parentID)) {
      selection = bindings.get(entry.step_index) ?? null;
      const text = antigravityVisiblePromptText(
        message?.content ?? entry.content ?? '',
        selection?.agent === 'plan' ? selection.antigravity?.fingerprint : undefined,
      );
      records.push({
        info: { id: `nag_u_${key}_${entry.step_index}`, role: 'user', time: { created: at } },
        parts: text.trim() ? [{ type: 'text' }] : [],
      });
      continue;
    }
    if (entry.type !== 'PLANNER_RESPONSE') continue;
    const tokens = entry.usage ? agyTokenUsage(entry.usage) : undefined;
    const parts: AgyStatisticsToolPart[] = tools === 'detail'
      ? entry.tool_calls.map((call, offset) => {
          const stepIndex = entry.step_index + offset + 1;
          const started = byStep.get(stepIndex);
          const isBackground = call.name === 'run_command' && (started?.content ?? '').split(/\r?\n/)
            .includes(`Tool is running as a background task with task id: ${nativeId}/task-${stepIndex}`);
          const result = isBackground ? background.get(stepIndex) : started;
          const valid = result?.type === 'GENERIC' || (isBackground && result?.type === 'SYSTEM_MESSAGE');
          const exit = call.name === 'run_command' ? /^Command exited with code (-?\d+)\.\r?$/m.exec(result?.content ?? '') : null;
          const failed = result?.status === 'ERROR'
            || result?.status === 'INVALID'
            || Boolean(result?.error)
            || (exit !== null && Number(exit[1]) !== 0);
          const status: 'running' | 'error' | 'completed' = !valid || result?.status === 'RUNNING'
            ? 'running'
            : failed
              ? 'error'
              : 'completed';
          const start = agyTime(/^Created At: (.+)\r?$/m.exec(started?.content ?? '')?.[1], agyTime(started?.created_at, 0));
          const end = agyTime(/^Completed At: (.+)\r?$/m.exec(result?.content ?? '')?.[1], isBackground ? agyTime(result?.created_at, 0) : 0);
          const time: AgyStatisticsToolTime = { start };
          if (start > 0 && end >= start) time.end = end;
          return {
            type: 'tool',
            callID: `nag_t_${key}_${stepIndex}`,
            tool: mapAgyTool(call).tool,
            state: { status, time },
          };
        })
      : [];
    const info: AgyStatisticsAssistantInfo = {
      id: `nag_a_${key}_${entry.step_index}`,
      role: 'assistant',
      time: { created: at },
      providerID: 'antigravity-native',
      modelID: selection?.modelID ?? '',
      reasoningKnown: entry.reasoningKnown !== false,
    };
    if (tokens !== undefined) info.tokens = tokens;
    records.push({ info, parts });
  }
  return records;
};
