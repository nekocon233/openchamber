import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeAntigravitySessionId } from '../ids.js';
import { antigravityPromptFingerprint } from '../prompt-parts.js';
import { createNativeRegistry } from '../registry.js';
import { createAntigravityStore } from './store.js';

const NATIVE_ID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const SESSION_ID = encodeAntigravitySessionId(NATIVE_ID);
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = ({ confirmed = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-store-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const directory = path.join(root, 'project');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(root, 'registry.json');
  const registry = createNativeRegistry({ filePath });
  const entry = {
    backend: 'antigravity', nativeId: NATIVE_ID, directory,
    origin: 'openchamber', createdAt: 1,
    ...(confirmed ? { confirmedAt: 2 } : {}),
  };
  const writeSummary = (nativeId = NATIVE_ID, cwd = directory) => {
    fs.mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(path.join(home, 'conversation_summaries.db'));
    db.exec(`create table if not exists conversation_summaries (
      conversation_id text primary key, title text, preview text,
      last_modified_time text, workspace_uris text, parent_conversation_id text default ''
    )`);
    db.prepare('insert or replace into conversation_summaries values (?, ?, ?, ?, ?, ?)')
      .run(nativeId, 'Native title', 'Preview', '2026-10-01 12:00:00+00:00', JSON.stringify([pathToFileURL(cwd).href]), '');
    db.close();
  };
  const writeTranscript = (lines, nativeId = NATIVE_ID, trailingNewline = true) => {
    const target = path.join(home, 'brain', nativeId, '.system_generated', 'logs');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'transcript.jsonl'), `${lines.join('\n')}${trailingNewline ? '\n' : ''}`);
  };
  return { root, home, directory, registry, entry, filePath, writeSummary, writeTranscript };
};

const step = (value) => JSON.stringify({ created_at: '2026-10-01T12:00:00Z', status: 'DONE', ...value });

describe('Antigravity native store', () => {
  it('keeps readable records when another transcript line is malformed or unknown', async () => {
    const { home, directory, registry, entry, writeSummary, writeTranscript } = setup();
    await registry.registerSession(SESSION_ID, entry);
    writeSummary();
    writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>hello</USER_REQUEST>' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'world', tool_calls: [] }),
      'not-json',
      step({ step_index: 2, type: 'FUTURE_STEP' }),
      '{"step_index":',
    ], NATIVE_ID, false);
    const store = createAntigravityStore({ registry, home, now: () => 1000 });
    const history = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(history.records[0].info.id).toBe(`nag_u_${NATIVE_ID.replaceAll('-', '')}_0`);
    expect(history.records[1].parts[0].text).toBe('world');
    expect(history.metadataComplete).toBe(false);
    expect((await store.listRootSessions(directory)).map((record) => record.id)).toEqual([SESSION_ID]);
  });

  it('recovers a client id from an accepted send once, then persists the binding', async () => {
    const { home, directory, registry, entry, filePath, writeSummary, writeTranscript } = setup();
    await registry.registerSession(SESSION_ID, entry);
    const content = '<USER_REQUEST>\nhello\n\n<openchamber-instructions>\nrules\n</openchamber-instructions>\n</USER_REQUEST>';
    const messageId = 'nag_u_00112233-4455-4677-8899-aabbccddeeff';
    await registry.recordSend(SESSION_ID, {
      messageId, providerID: 'antigravity-native', modelID: 'gemini-test-high', agent: 'build', sentAt: 3,
      antigravity: { fingerprint: antigravityPromptFingerprint(content) },
    });
    writeSummary();
    writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'reply', tool_calls: [] }),
    ]);
    const first = createAntigravityStore({ registry: createNativeRegistry({ filePath }), home });
    const history = await first.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records[0].info.id).toBe(messageId);
    expect(history.records[0].parts[0].text).toBe('hello');
    const second = createAntigravityStore({ registry: createNativeRegistry({ filePath }), home });
    expect((await second.loadHistory(SESSION_ID, NATIVE_ID, directory)).records[0].info.id).toBe(messageId);
    expect((await createNativeRegistry({ filePath }).sendRecords(SESSION_ID)).get(messageId).antigravity.stepIndex).toBe(0);
  });

  it('distinguishes an unwritten new session from a missing confirmed transcript', async () => {
    const { home, directory, registry, entry, writeSummary } = setup({ confirmed: false });
    await registry.registerSession(SESSION_ID, entry);
    writeSummary();
    const store = createAntigravityStore({ registry, home });
    expect((await store.loadHistory(SESSION_ID, NATIVE_ID, directory)).records).toEqual([]);
    await registry.confirmSession(SESSION_ID);
    await expect(store.loadHistory(SESSION_ID, NATIVE_ID, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE' });
  });

  it('filters native roots to their own workspace', async () => {
    const { home, directory, registry, writeSummary } = setup();
    writeSummary();
    writeSummary('01a0d2a6-b55b-7162-a837-c62053537e00', path.join(directory, 'other'));
    const store = createAntigravityStore({ registry, home });
    expect((await store.listRootSessions(directory)).map((record) => record.id)).toEqual([SESSION_ID]);
    expect(await store.getSession(SESSION_ID, NATIVE_ID, path.join(directory, 'other'))).toBeNull();
  });
});
