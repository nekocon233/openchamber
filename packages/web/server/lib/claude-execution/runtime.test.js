import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { realpath } from 'node:fs/promises';
import { createClaudeExecutionRuntime, prepareClaudeExecutionEnv } from './runtime.js';

describe('managed execution authority', () => {
  it('registers supported providers without duplicating managed plugins', () => {
    const excludedProviderIDs = [
      'anthropic',
      'claude-code',
      'cloudflare-ai-gateway',
      'gitlab',
      'kimi-for-coding',
      'openai',
      'sap-ai-core',
    ];
    const env = prepareClaudeExecutionEnv(
      JSON.stringify({
        plugin: [['custom-plugin', { option: true }]],
        model: 'openai/gpt',
        provider: { campus: {} },
        enabled_providers: ['environment-provider'],
      }),
      '/settings.json',
      ['zai-coding-plan', ...excludedProviderIDs, 'zai-coding-plan', 'invalid/provider'],
    );
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(parsed.model).toBe('openai/gpt');
    expect(parsed.plugin[0]).toEqual(['custom-plugin', { option: true }]);
    expect(parsed.plugin[1]).toContain('/claude-execution/plugin.js');
    expect(parsed.plugin.slice(2).map((entry) => entry[1].providerID)).toEqual([
      'campus',
      'environment-provider',
      'zai-coding-plan',
    ]);
    expect(
      parsed.plugin.slice(2).every((entry) => entry[0].includes('/claude-execution/provider-plugin.js?provider=')),
    ).toBe(true);
    const repeated = JSON.parse(
      prepareClaudeExecutionEnv(
        env.OPENCODE_CONFIG_CONTENT,
        '/settings.json',
        ['zai-coding-plan'],
      ).OPENCODE_CONFIG_CONTENT,
    );
    expect(repeated.plugin).toEqual(parsed.plugin);
  });

  it('rejects invalid OpenCode config', () => {
    expect(() => prepareClaudeExecutionEnv('{"plugin":', '/settings.json')).toThrow();
  });

  it('copies only provider IDs from inline OpenCode auth', () => {
    const runtime = createClaudeExecutionRuntime({
      readSettings: async () => ({ claudeCodeExecution: false }),
      getActivePort: () => 3000,
      settingsPath: '/settings.json',
      isExternal: () => false,
      listAuthenticatedProviderIDs: () => { throw new Error('auth.json should not be read'); },
      env: { OPENCODE_AUTH_CONTENT: JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'never-serialize-this' } }) },
    });
    const env = runtime.prepareEnv('{}');
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config.plugin.at(-1)[1]).toEqual({ providerID: 'zai-coding-plan' });
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('never-serialize-this');
  });

  it('authenticates callbacks, preserves queued decisions, and fails on authoritative read errors', async () => {
    let enabled = true;
    let failRead = false;
    const runtime = createClaudeExecutionRuntime({
      readSettings: async () => { if (failRead) throw new Error('unavailable'); return { claudeCodeExecution: enabled }; },
      getActivePort: () => 3000,
      settingsPath: '/settings.json', isExternal: () => false,
      listAuthenticatedProviderIDs: () => [],
    });
    const env = runtime.prepareEnv('{}');
    const app = express();
    runtime.registerInternal(app, express);
    app.use('/api', (req, res, next) => { if (req.get('x-fixture-user') !== 'yes') return res.sendStatus(401); next(); });
    runtime.registerPublic(app, express);
    const identity = { directory: await realpath(process.cwd()), sessionID: 's1', messageID: 'm1' };
    const callback = (body) => request(app).post('/internal/claude-execution/decision').set('Authorization', `Bearer ${env.OPENCHAMBER_CLAUDE_EXECUTION_TOKEN}`).send(body);
    await request(app).post('/internal/claude-execution/decision').send(identity).expect(401);
    await request(app).post('/api/claude-execution/requests').send({ ...identity, executionFramework: 'claude-code' }).expect(401);
    await request(app).post('/api/claude-execution/requests').set('x-fixture-user', 'yes').send({ ...identity, executionFramework: 'claude-code' }).expect(200);
    await request(app).post('/api/claude-execution/requests').set('x-fixture-user', 'yes').send({ ...identity, executionFramework: 'opencode' }).expect(409);
    enabled = false;
    expect((await callback(identity).expect(200)).body).toEqual({ enabled: true });
    expect((await callback({ ...identity, messageID: 'm2' }).expect(200)).body).toEqual({ enabled: false });
    failRead = true;
    await callback({ ...identity, messageID: 'm3' }).expect(503);
  });
});
