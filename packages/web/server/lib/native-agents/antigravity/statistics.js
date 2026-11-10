import { antigravityVisiblePromptText } from '../prompt-parts.js';
import { agyConversationMessage, agyTime, agyTokenUsage } from './protocol.js';
import { agyBackgroundResults } from './tasks.js';
import { mapAgyTool } from './tools.js';

/** Accounting records contain native generations and calls, without chat diffs or reasoning text. */
export const antigravityStatisticsRecords = ({ nativeId, entries, sends, parentID, tools }) => {
  const key = nativeId.replaceAll('-', '');
  const bindings = new Map([...sends.values()].filter((send) => send.antigravity?.stepIndex !== undefined)
    .map((send) => [send.antigravity.stepIndex, send]));
  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const background = tools === 'detail' ? agyBackgroundResults(entries, nativeId) : new Map();
  const records = [];
  let selection = null;
  for (const entry of entries) {
    const at = agyTime(entry.created_at, 0);
    const message = entry.type === 'SYSTEM_MESSAGE' ? agyConversationMessage(entry.content) : null;
    if (entry.type === 'USER_INPUT' || (message && `nag_${message.sender}` === parentID)) {
      selection = bindings.get(entry.step_index) ?? null;
      const text = antigravityVisiblePromptText(message?.content ?? entry.content ?? '',
        selection?.agent === 'plan' ? selection.antigravity?.fingerprint : undefined);
      records.push({ info: { id: `nag_u_${key}_${entry.step_index}`, role: 'user', time: { created: at } },
        parts: text.trim() ? [{ type: 'text' }] : [] });
      continue;
    }
    // Reports from another agent and checkpoint summaries are not model requests.
    if (entry.type !== 'PLANNER_RESPONSE') continue;
    const tokens = entry.usage ? agyTokenUsage(entry.usage) : undefined;
    const parts = tools === 'detail' ? entry.tool_calls.map((call, offset) => {
      const stepIndex = entry.step_index + offset + 1;
      const started = byStep.get(stepIndex);
      const isBackground = call.name === 'run_command' && (started?.content ?? '').split(/\r?\n/)
        .includes(`Tool is running as a background task with task id: ${nativeId}/task-${stepIndex}`);
      const result = isBackground ? background.get(stepIndex) : started;
      const valid = result?.type === 'GENERIC' || isBackground && result?.type === 'SYSTEM_MESSAGE';
      const exit = call.name === 'run_command' ? /^Command exited with code (-?\d+)\.\r?$/m.exec(result?.content ?? '') : null;
      const failed = ['ERROR', 'INVALID'].includes(result?.status) || Boolean(result?.error) || (exit !== null && Number(exit[1]) !== 0);
      const status = !valid || result.status === 'RUNNING' ? 'running' : failed ? 'error' : 'completed';
      const start = agyTime(/^Created At: (.+)\r?$/m.exec(started?.content ?? '')?.[1], agyTime(started?.created_at, 0));
      const end = agyTime(/^Completed At: (.+)\r?$/m.exec(result?.content ?? '')?.[1], isBackground ? agyTime(result?.created_at, 0) : 0);
      return { type: 'tool', callID: `nag_t_${key}_${stepIndex}`, tool: mapAgyTool(call).tool,
        state: { status, time: { start, end: start > 0 && end >= start ? end : undefined } } };
    }) : [];
    records.push({ info: { id: `nag_a_${key}_${entry.step_index}`, role: 'assistant', time: { created: at },
      providerID: 'antigravity-native', modelID: selection?.modelID ?? '', variant: selection?.variant ?? null,
      tokens, reasoningKnown: entry.reasoningKnown !== false,
    }, parts });
  }
  return records;
};
