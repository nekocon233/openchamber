import { describe, expect, it } from 'vitest';
import { createExecutionProvider } from './provider.js';
import { CONTEXT_HEADER, EXECUTION_HEADER } from './protocol.js';

describe('source provider authentication transport', () => {
  it('keeps the OpenAI Responses transport and its credential-owning fetch function', async () => {
    const calls = [];
    const provider = createExecutionProvider({
      name: 'openai', apiKey: 'unused-placeholder',
      fetch: async (url, init) => {
        // The OpenCode OAuth loader owns this function in production. It can
        // refresh credentials and choose the subscription endpoint here.
        calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
        return Response.json({ id: 'resp_fixture', created_at: 1, model: 'gpt-fixture', object: 'response', status: 'completed', output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, incomplete_details: null });
      },
    }, 'responses');
    const result = await provider.responses('gpt-fixture').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      headers: { [EXECUTION_HEADER]: 'disabled', [CONTEXT_HEADER]: 'internal-context', 'x-source': 'preserved' },
      providerOptions: { openai: { reasoningEffort: 'high', store: false } },
      tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    });
    expect(result.content[0].text).toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0].body.model).toBe('gpt-fixture');
    expect(calls[0].body.reasoning.effort).toBe('high');
    expect(calls[0].body.tools[0].strict).toBe(false);
    expect(calls[0].headers.get('x-source')).toBe('preserved');
    expect(calls[0].headers.has(CONTEXT_HEADER)).toBe(false);
  });

  it('keeps the Kimi subscription endpoint, API key and adaptive effort', async () => {
    let captured;
    const provider = createExecutionProvider({
      name: 'kimi-for-coding', apiKey: 'fixture-kimi-key', baseURL: 'https://api.kimi.com/coding/v1',
      fetch: async (url, init) => {
        captured = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
        return Response.json({ id: 'msg_fixture', type: 'message', model: 'kimi-for-coding', role: 'assistant', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } });
      },
    }, 'anthropic');
    const result = await provider.languageModel('kimi-for-coding').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxOutputTokens: 100,
      providerOptions: { 'kimi-for-coding': { effort: 'max' } },
    });
    expect(result.content[0].text).toBe('hello');
    expect(captured.url).toBe('https://api.kimi.com/coding/v1/messages');
    expect(captured.headers.get('x-api-key')).toBe('fixture-kimi-key');
    expect(captured.body.thinking.type).toBe('adaptive');
    expect(captured.body.output_config.effort).toBe('max');
  });
});
