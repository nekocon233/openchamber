import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CONTEXT_HEADER, EXECUTION_HEADER } from './protocol.js';

const settingsSchema = z.object({ claudeCodeExecution: z.boolean().optional() });
const adapters = new Map([
  ['@ai-sdk/openai', new URL('./openai-provider.js', import.meta.url).href],
  ['@ai-sdk/anthropic', new URL('./anthropic-provider.js', import.meta.url).href],
  ['@ai-sdk/openai-compatible', new URL('./compatible-provider.js', import.meta.url).href],
]);
const adapterUrls = new Set(adapters.values());

export function wrapModels(provider) {
  return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => {
    const npm = adapters.get(model.api.npm);
    if (!npm) return [id, model];
    return [id, { ...model, api: { ...model.api, npm } }];
  }));
}

export function createExecutionHooks({ directory }, { readEnabled, onStop, onDispose } = {}) {
  const decisions = new Map();
  const customAgentPrompts = new Set();
  const enabled = readEnabled ?? (async (sessionID, messageID) => {
    const url = process.env.OPENCHAMBER_CLAUDE_EXECUTION_URL;
    if (url) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENCHAMBER_CLAUDE_EXECUTION_TOKEN}` },
        body: JSON.stringify({ directory, sessionID, messageID }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Could not resolve the execution framework');
      return z.object({ enabled: z.boolean() }).parse(await response.json()).enabled;
    }
    const filename = process.env.OPENCHAMBER_CLAUDE_EXECUTION_SETTINGS;
    if (!filename) return false;
    try { return settingsSchema.parse(JSON.parse(await readFile(filename, 'utf8'))).claudeCodeExecution === true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Could not read the Claude Code execution setting'); }
  });
  const stop = onStop ?? (async (sessionID, deleted) => { const { stopSessionRuns } = await import('./bridge.js'); stopSessionRuns(directory, sessionID, deleted); });
  const decide = async (sessionID, messageID) => {
    const key = `${sessionID}\0${messageID}`;
    let result = decisions.get(key);
    if (!result) {
      result = Promise.resolve(enabled(sessionID, messageID));
      decisions.set(key, result);
    }
    return result;
  };
  return {
    config(config) {
      customAgentPrompts.clear();
      for (const [name, agent] of Object.entries(config.agent ?? {})) if (agent.prompt) customAgentPrompts.add(name);
      for (const provider of Object.values(config.provider ?? {})) {
        const replacement = adapters.get(provider.npm);
        if (replacement) provider.npm = replacement;
        for (const model of Object.values(provider.models ?? {})) {
          const npm = model.provider?.npm;
          const adapter = adapters.get(npm);
          if (adapter) {
            model.provider = { ...model.provider, npm: adapter };
          }
        }
      }
    },
    async 'chat.message'(input, output) {
      await decide(input.sessionID, output.message.id);
    },
    async 'chat.headers'(input, output) {
      const selected = await decide(input.sessionID, input.message.id);
      if (input.model.providerID === 'claude-code') return;
      if (selected && !adapterUrls.has(input.model.api.npm)) throw new Error(`Claude Code execution is not supported for ${input.model.providerID}/${input.model.id}. Choose a supported provider or turn off Claude Code execution.`);
      if (!adapterUrls.has(input.model.api.npm)) return;
      output.headers[EXECUTION_HEADER] = selected ? 'enabled' : 'disabled';
      output.headers[CONTEXT_HEADER] = Buffer.from(JSON.stringify({
        sessionID: input.sessionID,
        messageID: input.message.id,
        directory,
        agent: input.agent,
        preserveSystemPrefix: customAgentPrompts.has(input.agent),
        providerID: input.model.providerID,
        modelID: input.model.api.id,
        contextLimit: input.model.limit.context,
        variant: input.message.model?.variant,
      })).toString('base64url');
    },
    async event({ event }) {
      const idle = event.type === 'session.status' && event.properties.status.type === 'idle';
      const deleted = event.type === 'session.deleted';
      if (!idle && !deleted) return;
      const sessionID = deleted ? event.properties.info.id : event.properties.sessionID;
      for (const key of decisions.keys()) if (key.startsWith(`${sessionID}\0`)) decisions.delete(key);
      await stop(sessionID, deleted);
    },
    async dispose() {
      decisions.clear();
      if (onDispose) await onDispose();
      else { const { stopDirectoryRuns } = await import('./bridge.js'); stopDirectoryRuns(directory); }
    },
  };
}
