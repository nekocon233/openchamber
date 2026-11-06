#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

const home = process.env.AGY_FIXTURE_HOME;
if (!home) throw new Error('AGY_FIXTURE_HOME is required');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
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
  const settings = JSON.parse(option('--settings') ?? '{}');
  const customModels = settings.customModelsConfig?.customModels;
  if (!customModels || Object.keys(customModels).length !== 0) {
    console.log('magpie/antigravity/gemini-test\tMagpie Gemini Test');
    console.log('custom-model\tCustom Model');
  }
  process.exit(0);
}
if (args.includes('/usage')) {
  if (!args.includes('--disable-slash-commands=false')) throw new Error('Quota probes must execute the CLI command');
  const failure = process.env.AGY_FIXTURE_QUOTA_FAILURE;
  if (failure === 'unsupported-settings') {
    console.error('flag provided but not defined: -settings');
    process.exit(1);
  }
  if (failure === 'unauthenticated') {
    console.error('authentication required');
    process.exit(1);
  }
  const settingsFile = path.join(home, 'settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  const overrides = option('--settings');
  if (overrides) Object.assign(settings, JSON.parse(overrides));
  if (failure === 'empty' || settings.modelProvider || settings.model || option('--model')) process.exit(0);
  console.log('Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-06T08:26:27Z');
  console.log('Claude and GPT models\tFive Hour Limit Remaining\t75%\t2026-11-06T08:26:27Z');
  process.exit(0);
}
const cwd = option('--add-dir') || process.cwd();
const resumed = option('--conversation');
const conversationId = process.env.AGY_FIXTURE_CONVERSATION_ID || resumed || randomUUID();
const model = option('--model');
if (model === 'invalid-model') {
  console.error('Unknown fixture model');
  process.exit(1);
}
const mode = option('--mode');
const effort = option('--effort');
const modelEffort = /-(low|medium|high|xhigh|max)$/.exec(model ?? '')?.[1];
if (effort && modelEffort && effort !== modelEffort) {
  console.error(`--model ${model} conflicts with --effort=${effort}`);
  process.exit(1);
}
if (mode && !args.includes('--dangerously-skip-permissions')) {
  throw new Error('Conversation launched without full tool access');
}
let contextSettings = null;
if (mode && option('--settings')) {
  contextSettings = JSON.parse(fs.readFileSync(option('--settings'), 'utf8'));
  if (Object.keys(contextSettings).join(',') !== 'customModelsConfig') throw new Error('Unexpected conversation settings');
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
const outputLimitError = 'Your previous response was cut off because it exceeded the output token limit\nPlease continue from where you left off, keeping your response shorter\nRetries remaining: 3';
frame({ event: 'init', conversation_id: conversationId, init: { cwd, model, permission_mode: 'always-proceed' } });
let turns = 0;
let active = false;
let retainedChildId = null;
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
const planner = (text, toolCalls = [], thinking = undefined) => {
  const index = stepIndex++;
  append({ step_index: index, type: 'PLANNER_RESPONSE', content: text, thinking, tool_calls: toolCalls, usage });
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
  if (visible === 'retained-child-followup' || visible === 'retained-child-followup-result-only') {
    if (!retainedChildId) throw new Error('No retained fixture child');
    const task = '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T02:01:00Z sender=' + conversationId
      + ' priority=MESSAGE_PRIORITY_HIGH content=Also inspect error cases.\n</SYSTEM_MESSAGE>';
    const childLog = path.join(home, 'brain', retainedChildId, '.system_generated', 'logs', 'transcript_full.jsonl');
    for (const entry of [
      { step_index: 2, type: 'SYSTEM_MESSAGE', content: task },
      { step_index: 3, type: 'PLANNER_RESPONSE', thinking: 'Inspect the error cases.', content: 'Error cases checked.' },
    ]) fs.appendFileSync(childLog, JSON.stringify({ created_at: new Date().toISOString(), status: 'DONE', ...entry }) + '\n');
    if (visible !== 'retained-child-followup-result-only') {
      frame({ event: 'step_update', step_update: { conversation_id: retainedChildId, step_index: 3, state: 'DONE',
        step_type: 'agent_response', text_delta: 'Error cases checked.' } });
    }
    frame({ event: 'result', result: { conversation_id: retainedChildId, status: 'SUCCESS', response: 'Error cases checked.' } });
    planner('Follow-up completed.\n');
    finish('SUCCESS', 'Follow-up completed.\n');
    return;
  }
  if (visible === 'retained-agent-content' || visible === 'retained-agent-no-child-frames' || visible === 'live-child-thinking') {
    const childId = randomUUID();
    retainedChildId = childId;
    const message = (sender, body) => '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T02:01:00Z sender='
      + sender + ' priority=MESSAGE_PRIORITY_HIGH content=' + body + '\n</SYSTEM_MESSAGE>';
    const task = 'Inspect fixture evidence.';
    const report = '# Fixture report\n\nThe evidence is complete.';
    const db = new DatabaseSync(databasePath);
    db.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?)')
      .run(childId, 'Fixture child', task, new Date().toISOString(), JSON.stringify([pathToFileURL(cwd).href]), conversationId);
    db.close();
    const childRoot = path.join(home, 'brain', childId, '.system_generated', 'logs');
    fs.mkdirSync(childRoot, { recursive: true });
    const childEntries = [
      { step_index: 0, type: 'SYSTEM_MESSAGE', content: message(conversationId, task) },
      { step_index: 1, type: 'PLANNER_RESPONSE', thinking: visible === 'live-child-thinking' ? undefined : 'Read the evidence.',
        content: visible === 'retained-agent-no-child-frames' ? 'First progress.' : 'Evidence checked.' },
      ...(visible === 'retained-agent-no-child-frames' ? [{ step_index: 2, type: 'PLANNER_RESPONSE', content: 'Evidence checked.' }] : []),
    ].map((entry) => JSON.stringify({ created_at: new Date().toISOString(), status: 'DONE', ...entry })).join('\n') + '\n';
    fs.writeFileSync(path.join(childRoot, 'transcript_full.jsonl'), childEntries);
    append({ step_index: stepIndex++, type: 'PLANNER_RESPONSE', thinking: 'Check the saved task first.', usage });
    planner('Waiting for the child.\n', [{ name: 'invoke_subagent', args: { Task: task } },
      { name: 'find_by_name', args: {} }, { name: 'grep_search', args: {} }], 'Delegate the evidence check.');
    const index = stepIndex++;
    const subagentInfo = { subagents: [{ conversation_id: childId, type_name: 'explorer', role: 'Fixture child', initial_prompt: task }] };
    append({ step_index: index, type: 'GENERIC', content: 'Child created', subagent_info: subagentInfo });
    frame({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: index, state: 'DONE', step_type: 'subagent',
      tool_info: { name: 'invoke_subagent', parameters: { Task: task }, output: 'Child created', error: null }, subagent_info: subagentInfo } });
    if (visible !== 'retained-agent-no-child-frames') {
      frame({ event: 'step_update', step_update: { conversation_id: childId, step_index: 1, state: 'DONE',
        step_type: 'agent_response', text_delta: 'Evidence checked.' } });
    }
    if (visible === 'live-child-thinking') return;
    frame({ event: 'result', result: { conversation_id: childId, status: 'SUCCESS', response: 'Evidence checked.' } });
    for (const name of ['find_by_name', 'grep_search']) {
      append({ step_index: stepIndex++, type: 'GENERIC', status: 'INVALID', error: 'unknown tool: ' + name, content: 'Invalid call' });
    }
    append({ step_index: stepIndex++, type: 'SYSTEM_MESSAGE', content: message('system', 'Hidden system notice') });
    append({ step_index: stepIndex++, type: 'SYSTEM_MESSAGE', content: message(randomUUID(), 'Hidden unrelated sender') });
    append({ step_index: stepIndex++, type: 'SYSTEM_MESSAGE', content: message(childId, report) });
    planner('Report received.\n', [], 'Summarize the report.');
    finish('SUCCESS', 'Report received.\n');
    return;
  }
  if (['decision-questions', 'decision-plan', 'decision-questions-output-limit', 'decision-questions-stale-output-limit'].includes(visible)) {
    const questions = visible === 'decision-plan' ? [{
      question: '<openchamber-plan-v1>\n# Fixture implementation plan\n\n1. Preserve the API.\n2. Update the tests.\n</openchamber-plan-v1>',
      options: ['build', 'plan'], is_multi_select: false,
    }] : [
      { question: 'Which scope should change?', options: ['Current file', 'Whole module'], is_multi_select: false },
      { question: 'Which checks should run?', options: ['Unit tests', 'Lint'], is_multi_select: true },
    ];
    planner('Please review the next step.\n', [{ name: 'ask_question', args: { questions } }]);
    append({ step_index: stepIndex++, type: 'GENERIC', content: questions.map((_, index) => `A${index + 1}: User Skipped`).join('\n') });
    if (visible === 'decision-questions-output-limit') {
      planner('');
      append({ step_index: stepIndex++, type: 'ERROR_MESSAGE', error: outputLimitError, content: outputLimitError });
    }
    planner('Waiting for your answer.\n');
    const limited = visible.endsWith('output-limit');
    finish(limited ? 'ERROR' : 'SUCCESS', 'Waiting for your answer.\n', limited ? outputLimitError : undefined);
    return;
  }
  if (visible.startsWith('output-limit-')) {
    if (visible !== 'output-limit-no-final') {
      append({ step_index: stepIndex++, type: 'PLANNER_RESPONSE', content: 'Incomplete answer',
        truncated_fields: visible === 'output-limit-truncated-final' ? ['content'] : [] });
    }
    if (visible === 'output-limit-unreadable-final') {
      fs.unlinkSync(transcript);
      fs.mkdirSync(transcript);
    }
    finish('ERROR', 'Incomplete answer', visible === 'output-limit-unrecognized' ? `${outputLimitError}\nAuthentication expired` : outputLimitError);
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
  if (visible.startsWith('checklist-')) {
    if (process.env.OPENCHAMBER_AGY_CHECKLIST !== '1') throw new Error('Checklist helper was not enabled');
    const input = { todos: visible === 'checklist-empty' ? [] : [{ id: 'verify', content: 'Verify checklist integration',
      status: visible === 'checklist-completed' ? 'completed' : 'pending' }] };
    const parameters = { ServerName: 'openchamber_checklist', ToolName: 'update_checklist', Arguments: input };
    const output = JSON.stringify({ openchamberChecklist: 1, digest: createHash('sha256').update(JSON.stringify(input)).digest('hex') });
    planner('', [{ name: 'call_mcp_tool', args: parameters }]);
    const index = stepIndex++;
    append({ step_index: index, type: 'GENERIC', content: output });
    frame({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: index, state: 'DONE', step_type: 'tool',
      tool_info: { name: 'call_mcp_tool', parameters, output, error: null } } });
    planner('Checklist recorded\n');
    finish('SUCCESS', 'Checklist recorded\n');
    return;
  }
  if (visible === 'mode-probe') {
    const response = JSON.stringify({ mode, model, effort, resumed, nodeEnv: process.env.NODE_ENV ?? null, pid: process.pid,
      settingsFile: option('--settings'), contextBudgets: Object.fromEntries(Object.entries(contextSettings?.customModelsConfig?.customModels ?? {})
        .map(([id, value]) => [id, value.maxTokens ?? null])) });
    planner(response);
    finish('SUCCESS', response);
    return;
  }
  if (visible === 'live-thinking') {
    const generation = stepIndex;
    planner('Working\n', [{ name: 'run_command', args: { CommandLine: 'wait for fixture' } }]);
    const tool = stepIndex++;
    append({ step_index: tool, type: 'GENERIC', status: 'RUNNING', content: 'Still working' });
    frame({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: tool, state: 'ACTIVE', step_type: 'tool',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'wait for fixture' }, output: '', error: null } } });
    const release = path.join(home, 'release-thinking');
    const watcher = fs.watch(home, () => {
      if (!fs.existsSync(release)) return;
      watcher.close();
      append({ step_index: generation, type: 'PLANNER_RESPONSE', content: 'Working\n', thinking: 'Check the fixture while the turn runs.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'wait for fixture' } }], usage });
      append({ step_index: tool, type: 'GENERIC', content: 'Tool completed' });
      const completed = { event: 'step_update', step_update: { conversation_id: conversationId, step_index: tool, state: 'DONE', step_type: 'tool',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'wait for fixture' }, output: 'Tool completed', error: null } } };
      frame(completed);
      frame(completed);
    });
    return;
  }
  if (visible === 'stop-after-commentary' || visible === 'stop-after-output-limit') {
    interruptError = visible === 'stop-after-output-limit' ? outputLimitError : 'The stream was interrupted. Please continue the task.';
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
