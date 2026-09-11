import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { stopDirectoryRuns, streamClaudeCode } from './bridge.js';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    stopDirectoryRuns(directory);
    // The CLI can finish flushing its isolated home just after its result.
    await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

describe('Claude Code runtime bridge', () => {
  it('stops the official runtime and cancels an in-flight source request', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-claude-abort-'));
    directories.push(directory);
    const started = Promise.withResolvers();
    const controller = new AbortController();
    let sourceSignal;
    const model = {
      async doStream(params) {
        sourceSignal = params.abortSignal;
        return { stream: new ReadableStream({ start(streamController) {
          sourceSignal.addEventListener('abort', () => streamController.error(new Error('Source cancelled')), { once: true });
          started.resolve();
        } }) };
      },
    };
    const isolatedSdk = { ...sdk, query: ({ prompt, options }) => sdk.query({ prompt, options: { ...options, env: { ...options.env, HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, '.claude') } } }) };
    const response = await streamClaudeCode({
      model,
      params: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Wait for the model.' }] }], tools: [], abortSignal: controller.signal },
      context: { directory, sessionID: 'abort-session', messageID: 'abort-message', agent: 'build', modelID: 'claude-sonnet-4-6', providerID: 'fixture', contextLimit: 200000 },
      providerOptions: {}, sdk: isolatedSdk,
    });
    const stopped = expect(Array.fromAsync(response.stream)).rejects.toThrow('stopped');
    await started.promise;
    controller.abort();
    await stopped;
    expect(sourceSignal.aborted).toBe(true);
  }, 30000);

  it('runs the official runtime against a local model and parks/resumes OpenCode tools', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-claude-'));
    directories.push(directory);
    let calls = 0;
    const model = {
      async doStream(params) {
        calls++;
        expect(params.maxOutputTokens).toBeUndefined();
        const utility = !params.tools?.length;
        const system = [params.providerOptions.openai?.instructions, ...params.prompt.filter((message) => message.role === 'system').map((message) => message.content)].filter(Boolean).join('\n');
        expect(system).toContain('Project fixture rule');
        if (!utility) expect(system).not.toContain('Old OpenCode identity');
        const hasResult = params.prompt.some((message) => message.role === 'tool');
        const name = params.tools?.find((tool) => tool.name.endsWith('__read'))?.name;
        if (!utility) expect(name).toBe('mcp__opencode__read');
        const parts = hasResult || utility ? [
          { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: utility ? 'Fixture title' : 'The fixture contains hello.' }, { type: 'text-end', id: 'answer' },
        ] : [{ type: 'tool-call', toolCallId: 'native_read', toolName: name, input: '{"path":"fixture.txt"}' }];
        return { stream: new ReadableStream({ start(controller) {
          parts.forEach((part) => controller.enqueue(part));
          controller.enqueue({ type: 'finish', finishReason: { unified: hasResult || utility ? 'stop' : 'tool-calls' }, usage: { inputTokens: { total: 12, noCache: 12 }, outputTokens: { total: 3 } } });
          controller.close();
        } }) };
      },
    };
    const params = {
      providerOptions: { openai: { instructions: 'Old OpenCode identity\nYou are powered by the model named fixture.\nProject fixture rule' } },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Read fixture.txt with the read tool, then tell me what it contains.' }] }],
      tools: [{ type: 'function', name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      abortSignal: new AbortController().signal,
    };
    const context = { directory, sessionID: 's1', messageID: 'm1', agent: 'build', modelID: 'claude-sonnet-4-6', providerID: 'fixture', contextLimit: 200000 };
    const isolatedSdk = { ...sdk, query: ({ prompt, options }) => sdk.query({ prompt, options: { ...options, env: { ...options.env, HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, '.claude') } } }) };
    const first = await streamClaudeCode({ model, params, context, providerOptions: params.providerOptions, sourceFormat: 'responses', sdk: isolatedSdk });
    const firstParts = await Array.fromAsync(first.stream);
    const toolCall = firstParts.find((part) => part.type === 'tool-call');
    expect(toolCall).toMatchObject({ toolName: 'read', input: '{"path":"fixture.txt"}' });
    expect(firstParts.at(-1).finishReason.unified).toBe('tool-calls');
    const title = await streamClaudeCode({ model, params: { ...params, tools: [] }, context: { ...context, agent: 'title' }, providerOptions: params.providerOptions, sourceFormat: 'responses', sdk: isolatedSdk });
    expect((await Array.fromAsync(title.stream)).at(-1).finishReason.unified).toBe('stop');
    const second = await streamClaudeCode({ model, params: { ...params, prompt: [...params.prompt, { role: 'tool', content: [{ type: 'tool-result', toolCallId: toolCall.toolCallId, toolName: 'read', output: { type: 'text', value: 'hello' } }] }] }, context, providerOptions: params.providerOptions, sourceFormat: 'responses', sdk: isolatedSdk });
    const secondParts = await Array.fromAsync(second.stream);
    expect(secondParts.filter((part) => part.type === 'text-delta').map((part) => part.delta).join('')).toBe('The fixture contains hello.');
    expect(secondParts.at(-1).finishReason.unified).toBe('stop');
    expect(firstParts.at(-1).usage.inputTokens.total + secondParts.at(-1).usage.inputTokens.total).toBe(24);
    expect(calls).toBe(3);
  }, 60000);
});
