#!/usr/bin/env node
// Scripted app-server for the native runtime's plan-approval integration test.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const thread = { id: '01a0d2a6-b55b-7162-a837-c62053537e00', cwd: '', name: 'Plan test', model: 'gpt-5.5', createdAt: 1000, updatedAt: 1000 };
let turns = [];
let sequence = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialized') return;
  if (method === 'thread/start') thread.cwd = params.cwd;
  if (thread.cwd) fs.appendFileSync(path.join(thread.cwd, 'requests.jsonl'), `${JSON.stringify({ method, params })}\n`);
  const reply = (result) => send({ id, result });
  if (method === 'thread/start' || method === 'thread/read') return reply({ thread });
  if (method === 'thread/turns/list') return reply({ data: turns, nextCursor: null });
  if (method === 'thread/name/set') thread.name = params.name;
  if (method === 'thread/archive') thread.path = '/archived_sessions/test.jsonl';
  if (method === 'thread/revert') turns = turns.slice(0, turns.findIndex(turn => turn.id === params.beforeTurnId));
  if (method !== 'turn/start') return reply({});

  const planning = params.collaborationMode.mode === 'plan';
  if (!planning && fs.existsSync(path.join(thread.cwd, 'fail-build'))) {
    return send({ id, error: { code: -32000, message: 'Scripted execution start failed' } });
  }
  sequence += 1;
  const turn = { id: `turn-${sequence}`, status: 'inProgress', startedAt: 1000 + sequence, items: [] };
  turns.push(turn);
  reply({ turn });
  setTimeout(() => {
    notify('turn/started', { threadId: thread.id, turn });
    const user = { type: 'userMessage', id: `user-${sequence}`, clientId: params.clientUserMessageId, content: params.input };
    const answer = planning
      ? { type: 'plan', id: `plan-${sequence}`, text: `Plan revision ${sequence}: test, then implement.` }
      : { type: 'agentMessage', id: `answer-${sequence}`, text: 'Implemented.' };
    for (const item of [user, answer]) {
      turn.items.push(item);
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
    }
    turn.status = 'completed';
    turn.completedAt = 1001 + sequence;
    notify('turn/completed', { threadId: thread.id, turn });
    notify('thread/status/changed', { threadId: thread.id, status: { type: 'notLoaded' } });
  }, 10);
});
