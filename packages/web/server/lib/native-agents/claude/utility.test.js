import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeUtility } from './utility.js';

const WORK_DIR = path.join(os.tmpdir(), 'claude-utility-work');
const EXECUTABLE = '/usr/local/bin/claude';
const ENV = { PATH: '/usr/bin' };

const success = (result, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result, ...extra });

// A stand-in for the Agent SDK: `answer` yields the frames of each query.
const fixture = ({ answer = async function* () { yield success('Generated text'); }, loggedIn = true } = {}) => {
  const queries = [];
  const cliCalls = [];
  const utility = createClaudeUtility({
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        queries.push({ prompt, options });
        return answer(options);
      },
    }),
    launchableExecutable: async () => EXECUTABLE,
    buildEnv: () => ENV,
    runCli: async (executable, args, env) => {
      cliCalls.push({ executable, args, env });
      return JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' });
    },
    workDir: WORK_DIR,
  });
  return { utility, queries, cliCalls };
};

// Like the SDK, the query ends a while after its abort controller fires.
const untilAborted = async function* (options) {
  await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error('Claude Code process aborted by user');
};

const generate = (utility, overrides = {}) => utility.generate({ modelID: 'haiku', effort: 'low', prompt: 'Summarize the supplied text', ...overrides });

describe('Claude Code utility calls', () => {
  it('reports the login Claude Code reports and describes catalog models', async () => {
    const { utility, cliCalls } = fixture();
    expect(await utility.available()).toBe(true);
    expect(cliCalls).toEqual([{ executable: EXECUTABLE, args: ['auth', 'status', '--json'], env: ENV }]);
    expect(await utility.describe('haiku')).toMatchObject({ id: 'haiku', hasLogin: true, effort: 'low', contextWindow: 200_000 });
    expect(await utility.describe('opus')).toMatchObject({ id: 'opus', contextWindow: 1_000_000 });
    await expect(utility.describe('missing')).rejects.toMatchObject({ statusCode: 404, code: 'claude-model-unavailable' });
    expect(await fixture({ loggedIn: false }).utility.available()).toBe(false);
  });

  it('answers from one query with every tool, setting, MCP server and transcript off', async () => {
    const { utility, queries } = fixture({
      answer: async function* () {
        yield { type: 'system', subtype: 'init' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A short title' }] } };
        yield success('  A short title  ');
      },
    });
    expect(await generate(utility, { modelID: 'opus', system: 'Return a short title', maxOutputTokens: 100 })).toBe('A short title');
    expect(queries[0].prompt).toBe('Summarize the supplied text');
    expect(queries[0].options).toMatchObject({
      cwd: WORK_DIR,
      pathToClaudeCodeExecutable: EXECUTABLE,
      env: ENV,
      model: 'opus[1m]',
      effort: 'low',
      thinking: { type: 'disabled' },
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: 'dontAsk',
    });
    expect(queries[0].options.systemPrompt).toContain('Return a short title');
    expect(queries[0].options.systemPrompt).toContain('Keep the answer within 100 tokens.');
    expect(queries[0].options).not.toHaveProperty('outputFormat');
    expect(queries[0].options).not.toHaveProperty('maxTurns');

    await generate(utility);
    expect(queries[1].options.model).toBe('haiku');
  });

  it('returns structured output as JSON', async () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    const { utility, queries } = fixture({
      answer: async function* () { yield success('{"title":"Example"}', { structured_output: { title: 'Example' } }); },
    });
    expect(JSON.parse(await generate(utility, { responseSchema: schema }))).toEqual({ title: 'Example' });
    expect(queries[0].options.outputFormat).toEqual({ type: 'json_schema', schema });
  });

  it('rejects failed, errored and empty answers', async () => {
    const failures = [
      [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Claude Code crashed'] }, { message: 'Claude Code crashed' }],
      [success('Invalid API key · Please run /login', { is_error: true }), { message: 'Invalid API key · Please run /login' }],
      [success('   '), { code: 'output-exhausted' }],
    ];
    for (const [frame, failure] of failures) {
      const { utility } = fixture({ answer: async function* () { yield frame; } });
      await expect(generate(utility)).rejects.toMatchObject(failure);
    }
    const unstructured = fixture({ answer: async function* () { yield success('{}'); } });
    await expect(generate(unstructured.utility, { responseSchema: { type: 'object' } })).rejects.toMatchObject({ code: 'output-exhausted' });
    const silent = fixture({ answer: async function* (options) { options.stderr('Claude Code failed to start\n'); } });
    await expect(generate(silent.utility)).rejects.toThrow('Claude Code failed to start');
  });

  it('answers at the deadline and stops the query in the background', async () => {
    const { utility, queries } = fixture({ answer: untilAborted });
    await expect(generate(utility, { timeoutMs: 20 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(queries[0].options.abortController.signal.aborted).toBe(true);
  });

  it("follows the caller's signal, including one aborted before the query starts", async () => {
    const { utility, queries } = fixture({ answer: untilAborted });
    const controller = new AbortController();
    const pending = generate(utility, { signal: controller.signal });
    await vi.waitFor(() => expect(queries).toHaveLength(1));
    controller.abort(new Error('superseded'));
    await expect(pending).rejects.toThrow('superseded');
    expect(queries[0].options.abortController.signal.aborted).toBe(true);

    await expect(generate(utility, { signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone');
    expect(queries).toHaveLength(1);
  });

  it('stops every running query on shutdown', async () => {
    const { utility, queries } = fixture({ answer: untilAborted });
    const pending = generate(utility);
    await vi.waitFor(() => expect(queries).toHaveLength(1));
    utility.shutdown();
    await expect(pending).rejects.toThrow('Claude Code process aborted by user');
  });

  it.skipIf(process.platform === 'win32')('reads the state `claude auth status` prints when it exits 1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-status-'));
    const signedOut = path.join(dir, 'signed-out');
    const broken = path.join(dir, 'broken');
    fs.writeFileSync(signedOut, '#!/bin/sh\necho \'{"loggedIn":false,"authMethod":"none"}\'\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(broken, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const utilityFor = (executable) => createClaudeUtility({
      loadSdk: async () => ({ query: () => { throw new Error('No query expected'); } }),
      launchableExecutable: async () => executable,
      buildEnv: () => ({ PATH: process.env.PATH ?? '' }),
    });
    try {
      expect(await utilityFor(signedOut).available()).toBe(false);
      await expect(utilityFor(broken).available()).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
