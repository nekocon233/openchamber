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
  console.log('1.4.2');
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
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const cwd = option('--add-dir') || process.cwd();
const resumed = option('--conversation');
const model = option('--model');
const root = path.join(home, 'brain', conversationId, '.system_generated', 'logs');
fs.mkdirSync(root, { recursive: true });
const transcript = path.join(root, 'transcript.jsonl');
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
const append = (entry) => {
  fs.appendFileSync(transcript, `${JSON.stringify({ created_at: new Date().toISOString(), status: 'DONE', ...entry })}\n`);
  writeSummary();
};
const usage = { input_tokens: 10, output_tokens: 4, thinking_tokens: 1, cache_read_tokens: 2, total_tokens: 14 };
frame({ event: 'init', conversation_id: conversationId, init: { cwd, model, permission_mode: 'always-proceed' } });
let turns = 0;
let active = false;
const finish = (status, response, error) => {
  active = false;
  turns += 1;
  frame({ event: 'result', result: {
    conversation_id: conversationId,
    status,
    response,
    ...(error ? { error } : {}),
    num_turns: turns,
    usage,
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
  const userIndex = stepIndex++;
  append({ step_index: userIndex, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  frame({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_index: userIndex, state: 'DONE', step_type: 'user_input',
  } });
  if (visible === 'sticky') {
    planner('Recovered response\n');
    finish('ERROR', 'Recovered response\n', 'The stream was interrupted. Please continue the task you were working on.');
    return;
  }
  if (text.includes('stop-me')) {
    const index = stepIndex++;
    frame({ event: 'step_update', step_update: {
      conversation_id: conversationId, step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Working',
    } });
    return;
  }
  if (text.includes('tool')) {
    planner('Running a tool\n', [{ name: 'run_command', args: { CommandLine: '"printf fixture"' } }]);
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
process.on('SIGINT', () => finish('ERROR', '', 'interrupted'));
process.on('SIGTERM', () => finish('ERROR', '', 'interrupted'));
