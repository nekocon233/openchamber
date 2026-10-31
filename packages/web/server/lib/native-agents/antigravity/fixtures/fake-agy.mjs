#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const home = process.env.AGY_FIXTURE_HOME;
if (!home) throw new Error('AGY_FIXTURE_HOME is required');
const conversationId = process.env.AGY_FIXTURE_CONVERSATION_ID || 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.4.11');
  process.exit(0);
}
if (args.includes('models')) {
  if (process.env.AGY_FIXTURE_UNAUTHENTICATED === '1') {
    console.error('authentication required');
    process.exit(1);
  }
  console.log('gemini-test-high\tGemini Test (High)');
  console.log('gemini-test-low\tGemini Test (Low)');
  process.exit(0);
}
if (args.includes('/usage')) {
  if (!args.includes('--disable-slash-commands=false')) throw new Error('Quota probes must execute the CLI command');
  console.log('Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-06T08:26:27Z');
  console.log('Claude and GPT models\tFive Hour Limit Remaining\t75%\t2026-11-06T08:26:27Z');
  process.exit(0);
}
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const cwd = option('--add-dir') || process.cwd();
const resumed = option('--conversation');
const model = option('--model');
const mode = option('--mode');
const effort = option('--effort');
const modelEffort = /-(low|medium|high|xhigh|max)$/.exec(model ?? '')?.[1];
if (effort && modelEffort && effort !== modelEffort) {
  console.error(`--model ${model} conflicts with --effort=${effort}`);
  process.exit(1);
}
if (mode === 'plan') {
  const settings = JSON.parse(option('--settings') ?? '{}');
  if (args.includes('--dangerously-skip-permissions') || settings.toolPermission !== 'request-review'
    || !['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)'].every((rule) => settings.permissions?.deny?.includes(rule))) {
    throw new Error('Plan launched without native write protection');
  }
}
const root = path.join(home, 'brain', conversationId, '.system_generated', 'logs');
fs.mkdirSync(root, { recursive: true });
const transcript = path.join(root, 'transcript.jsonl');
const fullTranscript = path.join(root, 'transcript_full.jsonl');
const databasePath = path.join(home, 'conversation_summaries.db');
const writeSummary = () => {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`create table if not exists conversation_summaries (
    conversation_id text primary key,
    title text,
    preview text,
    last_modified_time text,
    workspace_uris text,
    parent_conversation_id text default ''
  )`);
  db.prepare(`insert into conversation_summaries
    (conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id)
    values (?, ?, ?, ?, ?, '')
    on conflict(conversation_id) do update set last_modified_time=excluded.last_modified_time`)
    .run(conversationId, 'Fake Antigravity', 'Fixture preview', new Date().toISOString(), JSON.stringify([pathToFileURL(cwd).href]));
  db.close();
};
writeSummary();
let stepIndex = 0;
if (fs.existsSync(transcript)) {
  const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try { stepIndex = Math.max(stepIndex, JSON.parse(line).step_index + 1); } catch { /* fixture input is controlled */ }
  }
}
const frame = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const append = (entry, preview = entry) => {
  const defaults = { created_at: new Date().toISOString(), status: 'DONE' };
  const shortened = { ...defaults, ...preview };
  if (preview.tool_calls) shortened.tool_calls = preview.tool_calls.map((call) => ({
    ...call,
    args: Object.fromEntries(Object.entries(call.args ?? {}).map(([key, value]) => [key, JSON.stringify(value)])),
  }));
  fs.appendFileSync(transcript, `${JSON.stringify(shortened)}\n`);
  fs.appendFileSync(fullTranscript, `${JSON.stringify({ ...defaults, ...entry })}\n`);
  writeSummary();
};
const usage = { input_tokens: 10, output_tokens: 4, thinking_tokens: 1, cache_read_tokens: 2, total_tokens: 14 };
frame({ event: 'init', conversation_id: conversationId, init: { cwd, model, permission_mode: 'always-proceed' } });
let turns = 0;
let active = false;
let interruptError = 'interrupted';
const finish = (status, response, error, extra = {}) => {
  active = false;
  turns += 1;
  frame({ event: 'result', result: {
    conversation_id: conversationId,
    status,
    response,
    ...(error ? { error } : {}),
    num_turns: turns,
    usage,
    ...extra,
  } });
  if (status !== 'SUCCESS') process.exit(1);
};
const planner = (text, toolCalls = []) => {
  const index = stepIndex++;
  append({ step_index: index, type: 'PLANNER_RESPONSE', content: text, tool_calls: toolCalls, usage });
  frame({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: text, usage,
  } });
  return index;
};
const run = (text) => {
  active = true;
  const visible = text.replace(/<openchamber-instructions>[\s\S]*?<\/openchamber-instructions>/g, '').trim();
  if (process.env.AGY_FIXTURE_REQUESTS) {
    fs.appendFileSync(process.env.AGY_FIXTURE_REQUESTS, `${JSON.stringify({ conversationId, cwd, model, mode, effort, resumed, text, visible })}\n`);
  }
  const userIndex = stepIndex++;
  append({ step_index: userIndex, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  frame({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_index: userIndex, state: 'DONE', step_type: 'user_input',
  } });
  if (visible === 'decision-questions' || visible === 'decision-plan') {
    const questions = visible === 'decision-plan' ? [{
      question: '<openchamber-plan-v1>\n# Fixture implementation plan\n\n1. Preserve the API.\n2. Update the tests.',
      options: ['build', 'plan'], is_multi_select: false,
    }] : [
      { question: 'Which scope should change?', options: ['Current file', 'Whole module'], is_multi_select: false },
      { question: 'Which checks should run?', options: ['Unit tests', 'Lint'], is_multi_select: true },
    ];
    planner('Please review the next step.\n', [{ name: 'ask_question', args: { questions } }]);
    append({ step_index: stepIndex++, type: 'GENERIC', content: questions.map((_, index) => `A${index + 1}: User Skipped`).join('\n') });
    planner('Waiting for your answer.\n');
    finish('SUCCESS', 'Waiting for your answer.\n');
    return;
  }
  if (visible === 'sticky') {
    planner('Recovered response\n');
    finish('ERROR', 'Recovered response\n', 'The stream was interrupted. Please continue the task you were working on.');
    return;
  }
  if (visible === 'permission-denied' || visible === 'permission-denied-with-answer') {
    const index = planner('', [{ name: 'read_file', args: { Path: '/outside/skill.md' } }]);
    stepIndex = index + 2;
    frame({ event: 'step_update', step_update: {
      conversation_id: conversationId, step_index: index + 1, state: 'ACTIVE', step_type: 'tool',
      tool_info: { name: 'read_file', parameters: { Path: '/outside/skill.md' }, output: '', error: null },
    } });
    const answer = visible === 'permission-denied-with-answer' ? 'The read needs permission. Please review the CLI settings.\n' : '';
    if (answer) planner(answer);
    finish('SUCCESS', answer, null, { denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] });
    return;
  }
  if (visible === 'failure-after-response') {
    planner('Partial answer\n');
    finish('ERROR', 'Partial answer\n', 'Authentication expired');
    return;
  }
  if (visible === 'mode-probe') {
    const response = JSON.stringify({ mode, model, effort, resumed, nodeEnv: process.env.NODE_ENV ?? null });
    planner(response);
    finish('SUCCESS', response);
    return;
  }
  if (visible === 'stop-after-commentary') {
    interruptError = 'The stream was interrupted. Please continue the task.';
    planner('Waiting for completion\n');
    return;
  }
  if (visible === 'background-task') {
    planner('Launching a command\n', [{ name: 'run_command', args: { CommandLine: 'build fixture' } }]);
    const index = stepIndex++;
    const id = `${conversationId}/task-${index}`;
    append({ step_index: index, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${id}\nTask Description: Build fixture` });
    const output = 'Command exited with code 0.\nDisplayed result';
    append({ step_index: stepIndex++, type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T02:01:00Z sender=${id} priority=MESSAGE_PRIORITY_HIGH content=Task id "${id}" finished with result:\n${output}\nLog: file:///ignored\n</SYSTEM_MESSAGE>` });
    const taskRoot = path.join(home, 'brain', conversationId, '.system_generated', 'tasks');
    fs.mkdirSync(taskRoot, { recursive: true });
    fs.writeFileSync(path.join(taskRoot, `task-${index}.log`), 'Complete saved background output\n');
    frame({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'build fixture' }, output, error: null } } });
    planner('Background command completed\n');
    finish('SUCCESS', 'Background command completed\n');
    return;
  }
  if (visible === 'missing-final-frame') {
    planner('Checking the result\n');
    append({ step_index: stepIndex++, type: 'PLANNER_RESPONSE', content: 'Final response without a stream frame\n',
      input_tokens: 14, output_tokens: 7 });
    finish('SUCCESS', 'Final response without a stream frame\n');
    return;
  }
  if (visible === 'history-recovery' || visible === 'preview-only-final') {
    planner('Choose the scope\n', [{ name: 'ask_question', args: { question: 'Which files?' } }]);
    append({ step_index: stepIndex++, type: 'GENERIC', content: 'A1: User Skipped' });
    planner('Waiting for verification\n');
    const answer = { step_index: stepIndex++, type: 'PLANNER_RESPONSE', content: 'Complete final answer\n', usage };
    append(answer, { ...answer, content: 'Complete <truncated 12 bytes>', truncated_fields: ['content'] });
    if (visible === 'preview-only-final') fs.unlinkSync(fullTranscript);
    finish('SUCCESS', 'Waiting for verification\nComplete final answer\n');
    return;
  }
  if (visible.includes('stop-me')) {
    const index = stepIndex++;
    frame({ event: 'step_update', step_update: {
      conversation_id: conversationId, step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Working',
    } });
    return;
  }
  if (visible.includes('tool')) {
    planner('Running a tool\n', [{ name: 'run_command', args: { CommandLine: 'printf fixture' } }]);
    const index = stepIndex++;
    frame({ event: 'step_update', step_update: {
      conversation_id: conversationId, step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'printf fixture' }, output: '', error: null },
    } });
    append({ step_index: index, type: 'GENERIC', content: 'fixture\n' });
    frame({ event: 'step_update', step_update: {
      conversation_id: conversationId, step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'printf fixture' }, output: 'fixture\n', error: null },
    } });
    planner('Tool finished\n');
    finish('SUCCESS', 'Tool finished\n');
    return;
  }
  planner(`Reply to ${visible}\n`);
  finish('SUCCESS', `Reply to ${visible}\n`);
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.event === 'user') run(message.message.content);
});
process.on('SIGINT', () => finish('ERROR', '', interruptError));
process.on('SIGTERM', () => finish('ERROR', '', 'interrupted'));
