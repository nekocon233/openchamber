import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { cleanSourceCall, EXECUTION_HEADER, readExecutionContext } from './protocol.js';

export function createExecutionProvider(options, format) {
  const factory = format === 'responses' ? createOpenAI : format === 'anthropic' ? createAnthropic : createOpenAICompatible;
  const source = factory(options);
  const wrap = (model) => ({
    specificationVersion: 'v3',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doStream(params) {
      const clean = cleanSourceCall(params, format, options.name);
      if (new Headers(params.headers).get(EXECUTION_HEADER) !== 'enabled') return model.doStream(clean);
      const context = readExecutionContext(params.headers);
      const { streamClaudeCode } = await import('./bridge.js');
      return streamClaudeCode({ model, params: clean, context, providerOptions: clean.providerOptions, sourceFormat: format });
    },
    async doGenerate(params) {
      const clean = cleanSourceCall(params, format, options.name);
      if (new Headers(params.headers).get(EXECUTION_HEADER) !== 'enabled') return model.doGenerate(clean);
      const { stream } = await this.doStream(params);
      const content = [];
      const blocks = new Map();
      let finish;
      for await (const event of stream) {
        if (event.type === 'text-start' || event.type === 'reasoning-start') {
          const block = { type: event.type === 'text-start' ? 'text' : 'reasoning', text: '' };
          blocks.set(event.id, block);
          content.push(block);
        }
        if (event.type === 'text-delta' || event.type === 'reasoning-delta') blocks.get(event.id).text += event.delta;
        if (event.type === 'tool-call') content.push(event);
        if (event.type === 'finish') finish = event;
      }
      if (!finish) throw new Error('Claude Code returned no completion');
      return { content, finishReason: finish.finishReason, usage: finish.usage, warnings: [] };
    },
  });
  return {
    languageModel: (id) => wrap(source.languageModel(id)),
    chat: (id) => wrap(format === 'anthropic' ? source.languageModel(id) : source.chatModel ? source.chatModel(id) : source.chat(id)),
    responses: (id) => wrap(format === 'responses' ? source.responses(id) : source.languageModel(id)),
  };
}
