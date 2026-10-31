import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createNativeRegistry } from '../registry.js';
import { createNativeEventPublisher } from '../publisher.js';
import { buildCliChildEnv } from '../process.js';
import { createAntigravityBackend } from './backend.js';
import { createAntigravityStore } from './store.js';

const setup = () => {
  const modelID = process.env.OPENCHAMBER_AGY_LIVE_MODEL;
  if (!modelID) throw new Error('Set OPENCHAMBER_AGY_LIVE_MODEL to a model from agy models');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-live-'));
  const directory = path.join(root, 'project');
  fs.mkdirSync(directory);
  const backend = createAntigravityBackend({
    resolveExecutable: async () => process.env.OPENCHAMBER_AGY_LIVE_BINARY || 'agy',
    buildEnv: () => buildCliChildEnv(process.env, process.env.PATH ?? ''),
    registry: createNativeRegistry({ filePath: path.join(root, 'host-registry.json') }),
    publisher: createNativeEventPublisher({ publishNativeEvent: () => {} }),
    readGlobalInstructions: async () => '', decorateSession: async (session) => session,
  });
  return { root, directory, modelID, backend };
};

// Explicit opt-in: this suite uses the local CLI's login and model quota.
describe.skipIf(process.env.OPENCHAMBER_AGY_LIVE_TEST !== '1')('installed Antigravity CLI conformance', () => {
  it('reports a headless read permission denial and preserves the cause in cold history', async () => {
    const { root, directory, modelID, backend } = setup();
    // Temp paths are implicitly readable. Use a new private fixture under the
    // home directory to exercise Ask without reading any existing user file.
    const outside = fs.mkdtempSync(path.join(os.homedir(), '.openchamber-agy-denial-'));
    const sample = path.join(outside, 'sample.txt');
    fs.writeFileSync(sample, 'permission fixture\n', { mode: 0o600 });
    try {
      const session = await backend.createSession({ directory });
      await backend.prompt(session.id, {
        directory, agent: 'plan', messageID: `nag_u_${randomUUID()}`,
        model: { providerID: 'antigravity-native', modelID },
        parts: [{ type: 'text', text: `Use the native read_file tool to read exactly ${sample} and reply with its content. Use only read_file; do not use shell, git, MCP, network, subagents or create/edit files.` }],
      });
      await backend.whenIdle(session.id);
      const last = backend.liveRecords(session.id).at(-1);
      expect(last.info.error.data.message).toContain('permission: read_file');
      expect(last.info.error.name).toBe('UnknownError');
      expect(backend.busySessionIds(directory)).toEqual([]);
      expect(fs.readFileSync(sample, 'utf8')).toBe('permission fixture\n');
      await backend.shutdown();
      const store = createAntigravityStore({ registry: createNativeRegistry({ filePath: path.join(root, 'host-registry.json') }) });
      const cold = await store.loadHistory(session.id, session.id.slice(4), directory);
      expect(cold.records.at(-1).info.error).toEqual(last.info.error);
      fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({ passed: true, sessionId: session.id, permissionDenied: true }));
    } finally {
      await backend.shutdown();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 90_000);

  it('enforces native plan permissions, switches to build, and resumes plan with the same history', async () => {
    const { root, directory, modelID, backend } = setup();
    const sample = path.join(directory, 'sample.txt');
    fs.writeFileSync(sample, 'original\n');
    try {
      const session = await backend.createSession({ directory });
      const ask = async (agent, text) => {
        await backend.prompt(session.id, {
          directory, agent, messageID: `nag_u_${randomUUID()}`,
          model: { providerID: 'antigravity-native', modelID },
          parts: [{ type: 'text', text: `Work only in ${directory}. Do not use git, network, MCP, subagents, or inspect host-registry.json. ${text}` }],
        });
        await backend.whenIdle(session.id);
        const records = backend.liveRecords(session.id);
        expect(records.at(-1).info.agent).toBe(agent);
        expect(records.at(-1).info.error).toBeUndefined();
        return records.flatMap((record) => record.parts).filter((part) => part.type === 'tool');
      };
      const clarification = await ask('plan', 'Before doing anything else, ask me whether I want a short summary or a detailed report, then stop and wait for my next message.');
      expect(clarification.some((part) => part.tool === 'ask_question')).toBe(false);
      expect(fs.readFileSync(sample, 'utf8')).toBe('original\n');
      const plan = await ask('plan', 'Read sample.txt. For a permission regression check, attempt once to replace original with changed using edit_file and once to create denied.txt using run_command. If denied, do not retry or use a different route. Report the denials and a short plan.');
      expect(fs.readFileSync(sample, 'utf8')).toBe('original\n');
      expect(fs.existsSync(path.join(directory, 'denied.txt'))).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(['sample.txt']);
      for (const tool of ['edit', 'bash']) {
        expect(plan.some((part) => part.tool === tool && part.state.status === 'error' && /permission/i.test(part.state.error))).toBe(true);
      }

      const build = await ask('build', 'Implement now: use edit_file once to replace original in sample.txt with build-mode. Then run a command to print NODE_ENV, or unset if it is absent. Make no other changes.');
      expect(fs.readFileSync(sample, 'utf8')).toBe('build-mode\n');
      expect(build.some((part) => part.tool === 'bash' && part.state.output?.includes('unset'))).toBe(true);

      await backend.shutdown();
      await ask('plan', 'Read sample.txt and propose one improvement in two sentences. Do not implement it.');
      expect(fs.readFileSync(sample, 'utf8')).toBe('build-mode\n');
      const history = await backend.loadHistory(session.id, directory);
      expect(history.records.filter((record) => record.info.role === 'user').map((record) => record.info.agent)).toEqual(['plan', 'plan', 'build', 'plan']);
      expect((await backend.quota()).ok).toBe(true);
      fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({ passed: true, sessionId: session.id, modelID }));
    } finally {
      await backend.shutdown();
    }
  }, 180_000);

  it.skipIf(process.platform === 'win32')('stops a real command before its delayed write and resumes the same conversation in Plan', async () => {
    const { root, directory, modelID, backend } = setup();
    const started = path.join(directory, 'started');
    const finished = path.join(directory, 'finished');
    try {
      const session = await backend.createSession({ directory });
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>fs.writeFileSync(${JSON.stringify(finished)},'finished'),15000)`;
      const command = `${quote(process.execPath)} -e ${quote(program)}`;
      await backend.prompt(session.id, {
        directory, agent: 'build', messageID: `nag_u_${randomUUID()}`,
        model: { providerID: 'antigravity-native', modelID },
        parts: [{ type: 'text', text: `This is an isolated cancellation check. Run this command exactly once; I will interrupt it:\n\n${command}\n\nDo not use git, network, MCP, subagents, status polling, or other writes.` }],
      });
      const deadline = Date.now() + 60_000;
      while (!fs.existsSync(started) && Date.now() < deadline) await delay(100);
      expect(fs.existsSync(started)).toBe(true);
      expect(await backend.abort(session.id)).toBe(true);
      await backend.whenIdle(session.id);
      expect(backend.busySessionIds(directory)).toEqual([]);
      expect(backend.liveRecords(session.id).some((record) => record.info.error?.name === 'MessageAbortedError')).toBe(true);
      await delay(16_000);
      expect(fs.existsSync(finished)).toBe(false);
      await backend.prompt(session.id, {
        directory, agent: 'plan', messageID: `nag_u_${randomUUID()}`,
        model: { providerID: 'antigravity-native', modelID },
        parts: [{ type: 'text', text: 'Reply briefly that this conversation has resumed. Do not use any tools or change files.' }],
      });
      await backend.whenIdle(session.id);
      const last = backend.liveRecords(session.id).at(-1);
      expect(last.info.agent).toBe('plan');
      expect(last.info.error).toBeUndefined();
      fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({ passed: true, sessionId: session.id, cancelled: true }));
    } finally { await backend.shutdown(); }
  }, 120_000);
});
