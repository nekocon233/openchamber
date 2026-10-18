import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCommonRequestMiddleware } from '../../opencode/core-routes.js';
import { newNativeClientUserMessageId } from '../ids.js';
import { registerNativeAgentRoutes } from '../routes.js';
import { createNativeAgentsRuntime } from '../runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const setup = async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'openchamber-dsh-runtime-'));
    cleanups.push(() => rm(temporary, { recursive: true, force: true }));
    const directory = path.join(temporary, 'workspace');
    await mkdir(directory);
    const executable = path.join(temporary, 'dsh');
    await writeFile(executable, `#!/usr/bin/env node\nimport ${JSON.stringify(new URL('./fixtures/server.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
    const runtime = createNativeAgentsRuntime({
      dataDir: path.join(temporary, 'data'), clientVersion: 'test',
      resolveExecutable: async (cli) => cli === 'dsh' ? executable : null,
      buildChildEnv: () => ({ ...process.env, DSH_TEST_DIRECTORY: directory }),
      publishNativeEvent: () => {}, loadSdk: async () => ({ listSessions: async () => [] }),
    });
    cleanups.push(() => runtime.shutdown());
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerNativeAgentRoutes(app, { runtime });
    return { app, runtime, directory, dataDir: path.join(temporary, 'data') };
};

describe.skipIf(process.platform === 'win32')('DeepSeek native HTTP routing', () => {
  it('creates, sends, reads and updates through the shared runtime and enforces operation limits', async () => {
    const { app, directory } = await setup();
    expect((await request(app).get('/api/native/capabilities').expect(200)).body.backends.deepseek).toMatchObject({ cli: true, actions: { revert: true, delete: false, fork: true } });
    const configuration = (await request(app).get('/api/native/deepseek/configuration').set('X-Forwarded-For', '198.51.100.7').expect(200)).body;
    expect(configuration).toMatchObject({ revision: 0, credential: { configured: false } });
    const provider = { revision: 0, baseURL: null, modelIDs: ['test-model'], apiKey: 'fixture-remote-key' };
    const saved = (await request(app).post('/api/native/deepseek/configuration').set('X-Forwarded-For', '198.51.100.7').send(provider).expect(200)).body;
    expect(saved).toMatchObject({ status: 'saved', configuration: { revision: 1, credential: { configured: true } } });
    expect(JSON.stringify(saved)).not.toContain(provider.apiKey);
    await request(app).post('/api/native/deepseek/configuration').send(provider).expect(409);
    await request(app).post('/api/native/deepseek/configuration').send({ ...provider, revision: 1, baseURL: 'file:///secret' }).expect(400);
    const created = (await request(app).post('/api/native/sessions').send({ backend: 'deepseek', directory, title: 'DSH integration' }).expect(200)).body;
    expect(created.id).toMatch(/^ndh_[a-f0-9]{64}$/);
    const messageID = newNativeClientUserMessageId(created.id);
    await request(app).post(`/api/native/sessions/${created.id}/prompt`).send({
      directory, messageID, parts: [{ type: 'text', text: 'Hello' }], model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build',
    }).expect(200);
    const page = (await request(app).get(`/api/native/sessions/${created.id}/messages`).query({ directory }).expect(200)).body;
    expect(page.records.some((record) => record.info.id === messageID)).toBe(true);
    const metadata = { openchamber: { assist: { recap: 'Keep this metadata' } } };
    await request(app).patch(`/api/native/sessions/${created.id}`).send({ directory, metadata }).expect(200);
    const updated = (await request(app).get(`/api/native/sessions/${created.id}`).query({ directory }).expect(200)).body;
    expect(updated.metadata.openchamber.assist.recap).toBe('Keep this metadata');
    const revert = (await request(app).post(`/api/native/sessions/${created.id}/revert`).send({ directory, messageID }).expect(200)).body;
    expect(revert).toMatchObject({ conversationOnly: true, session: { revert: { messageID } } });
    await request(app).post(`/api/native/sessions/${created.id}/unrevert`).send({ directory }).expect(200);
    await request(app).delete(`/api/native/sessions/${created.id}`).query({ directory }).expect(501);
    const commands = (await request(app).get('/api/native/commands').query({ backend: 'deepseek', directory, sessionId: created.id }).expect(200)).body;
    expect(commands.commands.some((command) => command.name === 'compact')).toBe(true);
    await request(app).post('/api/native/deepseek/command').send({ sessionId: created.id, directory, line: '/plan off' }).expect(200);
  });

  it('opens independent configuration without reading Claude credentials and keeps repeated setup safe', async () => {
    const { app, dataDir } = await setup();
    await mkdir(path.join(dataDir, 'native-agents'), { recursive: true });
    await writeFile(path.join(dataDir, 'native-agents', 'claude-connections.json'), 'This file must not be read by dsh setup');
    const starts = await Promise.all([
      request(app).post('/api/native/deepseek/setup').send({}).expect(200),
      request(app).post('/api/native/deepseek/setup').send({}).expect(200),
    ]);
    expect(starts.every((response) => ['installing', 'configuring'].includes(response.body.state))).toBe(true);
    await expect.poll(async () => (await request(app).get('/api/native/deepseek/setup').expect(200)).body.state).toBe('needs-key');
    const configuration = (await request(app).get('/api/native/deepseek/configuration').expect(200)).body;
    expect(configuration).toMatchObject({ revision: 0, credential: { configured: false } });
    await request(app).post('/api/native/deepseek/setup').send({ executable: '/anything' }).expect(400);
    await request(app).post('/api/native/deepseek/configuration').send({ revision: 0, baseURL: null, modelIDs: ['own-model'], apiKey: 'fixture-independent-key' }).expect(200);
    await request(app).post('/api/native/deepseek/setup').send({}).expect(200);
    await expect.poll(async () => (await request(app).get('/api/native/deepseek/setup').expect(200)).body.state).toBe('ready');
    expect((await request(app).get('/api/native/deepseek/configuration').expect(200)).body).toMatchObject({ revision: 1, modelIDs: ['own-model'] });
  });

  it('refuses remote setup and progress reads in enterprise mode', async () => {
    const { app } = await setup();
    const previous = process.env.OPENCHAMBER_ENTERPRISE_MODE;
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      expect((await request(app).post('/api/native/deepseek/setup').send({}).expect(403)).body.code).toBe('enterprise_mode');
      expect((await request(app).get('/api/native/deepseek/setup').expect(403)).body.code).toBe('enterprise_mode');
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      else process.env.OPENCHAMBER_ENTERPRISE_MODE = previous;
    }
  });
});
