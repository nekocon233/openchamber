import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import express from 'express';
import { createOpenCodeIdentifier } from '@openchamber/ui/lib/opencode/identifier';
import { createClaudeExecutionRuntime } from './runtime.js';

const anthropic = process.env.OPENCHAMBER_TEST_PROVIDER_FORMAT === 'anthropic';
const hasToolResult = (message) => message.role === 'tool' || (Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'));

it.skipIf(!process.env.OPENCHAMBER_TEST_OPENCODE_BINARY)(`switches an existing real OpenCode session through Claude Code and back (${anthropic ? 'Anthropic' : 'Chat Completions'})`, async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'openchamber-execution-e2e-')));
  const settings = path.join(directory, 'settings.json');
  const fixtureFile = path.join(directory, 'fixture.txt');
  await writeFile(settings, JSON.stringify({ claudeCodeExecution: false }));
  await writeFile(fixtureFile, 'hello from the real OpenCode read tool');
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(payload);
    const readTool = payload.tools?.find((tool) => (tool.function?.name ?? tool.name).endsWith('__read'));
    const hasResult = payload.messages.some(hasToolResult);
    const claude = JSON.stringify(payload.system ?? '').includes('running inside OpenChamber') || payload.messages.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('running inside OpenChamber'));
    const call = readTool && !hasResult;
    if (anthropic) {
      const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      emit({ type: 'message_start', message: { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'native_read', name: readTool.name, input: {} } : { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify({ filePath: fixtureFile }) } : { type: 'text_delta', text: claude ? 'Claude execution complete' : 'OpenCode execution complete' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      emit({ type: 'message_stop' });
      response.end();
      return;
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'native_read', type: 'function', function: { name: readTool.function.name, arguments: JSON.stringify({ filePath: fixtureFile }) } }] }
      : { content: claude ? 'Claude execution complete' : 'OpenCode execution complete' };
    const chunk = (delta, finish_reason = null) => ({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}, call ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  const config = {
    $schema: 'https://opencode.ai/config.json',
    plugin: [process.env.OPENCHAMBER_TEST_CLAUDE_PLUGIN ? pathToFileURL(process.env.OPENCHAMBER_TEST_CLAUDE_PLUGIN).href : new URL('./plugin.js', import.meta.url).href],
    model: 'fixture/model', small_model: 'fixture/model',
    enabled_providers: ['fixture'],
    snapshot: false,
    command: { fixture: { template: 'Answer with a short completion message.', agent: 'build' } },
    permission: { '*': 'deny', read: 'allow' },
    provider: { fixture: { npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-key' }, models: { model: { name: 'Fixture', limit: { context: 200000, output: 4000 } } } } },
  };
  const authorityApp = express();
  let authorityServer;
  const authority = createClaudeExecutionRuntime({
    readSettings: async () => JSON.parse(await readFile(settings, 'utf8')),
    getActivePort: () => authorityServer.address().port,
    settingsPath: settings,
    isExternal: () => false,
  });
  authority.registerInternal(authorityApp, express);
  authorityApp.use('/api', (req, res, next) => { if (req.get('x-fixture-user') !== 'yes') return res.sendStatus(401); next(); });
  authority.registerPublic(authorityApp, express);
  authorityServer = authorityApp.listen(0, '127.0.0.1');
  await once(authorityServer, 'listening');
  const authorityEnv = authority.prepareEnv('{}');
  const child = spawn(process.env.OPENCHAMBER_TEST_OPENCODE_BINARY, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: path.join(directory, 'config'),
      XDG_DATA_HOME: path.join(directory, 'data'),
      XDG_CACHE_HOME: path.join(directory, 'cache'),
      XDG_STATE_HOME: path.join(directory, 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCHAMBER_CLAUDE_EXECUTION_SETTINGS: settings,
      OPENCHAMBER_CLAUDE_EXECUTION_URL: authorityEnv.OPENCHAMBER_CLAUDE_EXECUTION_URL,
      OPENCHAMBER_CLAUDE_EXECUTION_TOKEN: authorityEnv.OPENCHAMBER_CLAUDE_EXECUTION_TOKEN,
      OPENCHAMBER_CLAUDE_EXECUTION_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-8000); });
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`OpenCode startup timed out: ${diagnostics}`)), 30000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`OpenCode exited: ${diagnostics}`)); });
    });
    const client = createOpencodeClient({ baseUrl, directory, throwOnError: true, fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(45000) }) });
    const created = await client.session.create({ title: 'Execution integration fixture' });
    const sessionID = created.data.id;
    const send = (text) => client.session.prompt({ sessionID, model: { providerID: 'fixture', modelID: 'model' }, parts: [{ type: 'text', text }] });
    const native = await send('Answer without tools.');
    expect(native.data.parts.some((part) => part.type === 'text' && part.text.includes('OpenCode execution complete'))).toBe(true);
    await writeFile(settings, JSON.stringify({ claudeCodeExecution: true }));
    const bridged = await send('Read fixture.txt with the read tool.');
    expect(bridged.data.parts.some((part) => part.type === 'text' && part.text.includes('Claude execution complete'))).toBe(true);
    const history = await client.session.messages({ sessionID });
    expect(history.data.flatMap((entry) => entry.parts).some((part) => part.type === 'tool' && part.tool === 'read' && part.state.status === 'completed')).toBe(true);
    expect(requests.some((body) => body.messages.some((message) => hasToolResult(message) && JSON.stringify(message.content).includes('hello from the real OpenCode read tool')))).toBe(true);
    expect(requests.some((body) => body.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('OpenCode execution complete')))).toBe(true);
    const messageID = createOpenCodeIdentifier('msg');
    const prepared = await fetch(`http://127.0.0.1:${authorityServer.address().port}/api/claude-execution/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': 'yes' },
      body: JSON.stringify({ directory, sessionID, messageID, executionFramework: 'claude-code' }),
    });
    expect(prepared.status).toBe(200);
    await writeFile(settings, JSON.stringify({ claudeCodeExecution: false }));
    const queuedCommand = await client.session.command({ sessionID, messageID, command: 'fixture', arguments: '', model: 'fixture/model' });
    expect(queuedCommand.data.parts.some((part) => part.type === 'text' && part.text.includes('Claude execution complete'))).toBe(true);
    const restored = await send('Answer without tools again.');
    expect(restored.data.parts.some((part) => part.type === 'text' && part.text.includes('OpenCode execution complete'))).toBe(true);
  } catch (error) {
    throw new Error(`${error.message}; model requests: ${requests.length}; OpenCode diagnostics: ${diagnostics}`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    upstream.closeAllConnections();
    authorityServer.closeAllConnections();
    await new Promise((resolve) => authorityServer.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
