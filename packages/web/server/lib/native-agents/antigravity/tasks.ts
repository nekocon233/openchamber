import { agyTime, decodeAgyToolArguments } from './protocol.js';
import type { AgyTranscriptStep, AgyTranscriptToolCall } from './protocol.js';

export type AgySavedTask = {
  id: string;
  type: 'bash';
  description: string;
  active: false;
  ambient: false;
  canStop: false;
  status: 'completed' | 'failed' | 'unknown';
  outputAvailable: boolean;
  toolUseId: string;
  startedAt?: number;
  endedAt?: number;
};

export interface AgySavedTaskRecord {
  stepIndex: number;
  output: string;
  truncated: boolean;
  task: AgySavedTask;
}

export const agyBackgroundResults = (
  entries: readonly AgyTranscriptStep[],
  nativeId: string,
): Map<number, AgyTranscriptStep> => {
  const results = new Map<number, AgyTranscriptStep>();
  const header = new RegExp(`\\[Message\\] timestamp=\\S+ sender=${nativeId}/task-(\\d+) priority=\\S+ content=Task id "${nativeId}/task-\\1" finished with result:\\r?\\n`);
  for (const entry of entries) {
    if (entry.type !== 'SYSTEM_MESSAGE') continue;
    const content = entry.content ?? '';
    const match = header.exec(content);
    const stepNumber = match?.[1];
    if (!match || stepNumber === undefined) continue;
    const output = content.slice(match.index + match[0].length)
      .replace(/\r?\nLog: file:\/\/[^\n]*\r?\n<\/SYSTEM_MESSAGE>\s*$/, '')
      .replace(/\r?\n<\/SYSTEM_MESSAGE>\s*$/, '');
    results.set(Number(stepNumber), { ...entry, content: output });
  }
  return results;
};

export const agySavedTasks = (
  entries: readonly AgyTranscriptStep[],
  nativeId: string,
): AgySavedTaskRecord[] => {
  const calls = new Map<number, AgyTranscriptToolCall>();
  for (const entry of entries) {
    if (entry.type !== 'PLANNER_RESPONSE') continue;
    entry.tool_calls.forEach((call, index) => {
      if (call.name === 'run_command') calls.set(entry.step_index + index + 1, call);
    });
  }
  const results = agyBackgroundResults(entries, nativeId);
  const tasks: AgySavedTaskRecord[] = [];
  for (const entry of entries) {
    const call = calls.get(entry.step_index);
    if (entry.type !== 'GENERIC' || !call) continue;
    const id = `${nativeId}/task-${entry.step_index}`;
    const lines = (entry.content ?? '').split(/\r?\n/);
    if (!lines.includes(`Tool is running as a background task with task id: ${id}`)) continue;
    const completion = results.get(entry.step_index);
    const output = completion?.content ?? '';
    const exit = /^Command exited with code (-?\d+)\.\r?$/m.exec(output);
    const { title } = decodeAgyToolArguments(call.args, call.argumentsEncoded ?? true);
    const description = title ?? lines.find((line) => line.startsWith('Task Description: '))?.slice('Task Description: '.length) ?? id;
    const startedAt = agyTime(entry.created_at, Number.NaN);
    const endedAt = agyTime(completion?.created_at, Number.NaN);
    const task: AgySavedTask = {
      id: `${nativeId}_task-${entry.step_index}`,
      type: 'bash',
      description,
      active: false,
      ambient: false,
      canStop: false,
      status: exit ? (Number(exit[1]) === 0 ? 'completed' : 'failed') : 'unknown',
      outputAvailable: output !== '',
      toolUseId: `nag_t_${nativeId.replaceAll('-', '')}_${entry.step_index}`,
    };
    if (Number.isFinite(startedAt)) task.startedAt = startedAt;
    if (Number.isFinite(endedAt)) task.endedAt = endedAt;
    tasks.push({
      stepIndex: entry.step_index,
      output,
      truncated: completion?.truncated_fields?.includes('content') === true || /<truncated \d+/.test(output),
      task,
    });
  }
  return tasks;
};
