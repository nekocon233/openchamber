import { agyTime, decodeAgyToolArguments } from './protocol.js';

/** A notification may settle only the task named by both native identities. */
export const agyBackgroundResults = (entries, nativeId) => {
  const results = new Map();
  const header = new RegExp(`\\[Message\\] timestamp=\\S+ sender=${nativeId}/task-(\\d+) priority=\\S+ content=Task id "${nativeId}/task-\\1" finished with result:\\r?\\n`);
  for (const entry of entries) {
    if (entry.type !== 'SYSTEM_MESSAGE') continue;
    const content = entry.content ?? '';
    const match = header.exec(content);
    if (!match) continue;
    const output = content.slice(match.index + match[0].length)
      .replace(/\r?\nLog: file:\/\/[^\n]*\r?\n<\/SYSTEM_MESSAGE>\s*$/, '')
      .replace(/\r?\n<\/SYSTEM_MESSAGE>\s*$/, '');
    results.set(Number(match[1]), { ...entry, content: output });
  }
  return results;
};

/** Saved task outcomes are not observations of current process activity. */
export const agySavedTasks = (entries, nativeId) => {
  const calls = new Map();
  for (const entry of entries) {
    if (entry.type !== 'PLANNER_RESPONSE') continue;
    entry.tool_calls.forEach((call, index) => {
      if (call.name === 'run_command') calls.set(entry.step_index + index + 1, call);
    });
  }
  const results = agyBackgroundResults(entries, nativeId);
  const tasks = [];
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
    tasks.push({
      stepIndex: entry.step_index, output,
      truncated: completion?.truncated_fields?.includes('content') === true || /<truncated \d+/.test(output),
      task: {
        id: `${nativeId}_task-${entry.step_index}`, type: 'bash', description,
        active: false, ambient: false, canStop: false,
        status: exit ? Number(exit[1]) === 0 ? 'completed' : 'failed' : 'unknown',
        outputAvailable: output !== '',
        toolUseId: `nag_t_${nativeId.replaceAll('-', '')}_${entry.step_index}`,
        startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
        endedAt: Number.isFinite(endedAt) ? endedAt : undefined,
      },
    });
  }
  return tasks;
};
