import { createExecutionHooks, wrapModels } from './hooks.js';

export const ClaudeExecution = async (input) => createExecutionHooks(input);
export const OpenAIExecution = async () => ({ provider: { id: 'openai', models: async (provider) => wrapModels(provider) } });
export const KimiExecution = async () => ({ provider: { id: 'kimi-for-coding', models: async (provider) => wrapModels(provider) } });
export const AnthropicExecution = async () => ({ provider: { id: 'anthropic', models: async (provider) => wrapModels(provider) } });
