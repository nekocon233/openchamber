import { NativeAgentError } from '../errors.js';
import { createChatgptAuth } from './chatgpt-auth.js';
import { createChatgptBridge } from './chatgpt-bridge.js';
import { claudeConnectionEnvironment } from './connections.js';

// The account catalog can also advertise modes such as ultra that need a
// different agent protocol. Offer only efforts supported by Responses here.
const RESPONSE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// SIWC's catalog omits output limits. These exact model pages under
// https://developers.openai.com/api/docs/models/ were verified on 2026-10-08.
const MODEL_OUTPUT_LIMITS = new Map([
  ['gpt-6.1-sol', 128_000],
  ['gpt-6-astra', 128_000],
  ['gpt-6-sol', 128_000],
  ['gpt-6-luna', 128_000],
  ['gpt-5.6-sol', 128_000],
  ['gpt-5.6-terra', 128_000],
  ['gpt-5.6-luna', 128_000],
]);

const descriptor = (account, model, includeAccount) => {
  const efforts = [...new Set((model.supported_reasoning_levels ?? [])
    .map((level) => level.effort).filter((effort) => RESPONSE_EFFORTS.has(effort)))];
  return {
    id: `chatgpt:${account.id}:${Buffer.from(model.slug).toString('base64url')}`,
    name: includeAccount ? `${model.display_name} / ${account.label}` : model.display_name,
    contextWindow: model.max_context_window ?? model.context_window ?? null,
    outputLimit: MODEL_OUTPUT_LIMITS.get(model.slug) ?? null, efforts,
    defaultEffort: efforts.includes(model.default_reasoning_level) ? model.default_reasoning_level : null,
    fast: false, input: { image: model.input_modalities?.includes('image') === true, pdf: false }, billing: 'chatgpt-plan',
  };
};

/** The account model catalog and the per-query grants share one lifetime with native sessions. */
export const createChatgptConnections = ({ dataDir, fetchImpl = fetch }) => {
  const auth = createChatgptAuth({ dataDir, fetchImpl });
  const bridge = createChatgptBridge({ auth, fetchImpl });
  const catalogFailures = new Set();
  return {
    auth,
    async accounts() {
      return (await auth.accounts()).map((account) => ({ ...account, catalogUnavailable: catalogFailures.has(account.id) }));
    },
    async catalog() {
      const accounts = (await auth.accounts()).filter((account) => account.status === 'connected');
      const partitions = await Promise.all(accounts.map(async (account) => {
        let models;
        try { models = await auth.models(account.id); catalogFailures.delete(account.id); }
        catch {
          if ((await auth.getAccount(account.id)).status !== 'connected') { catalogFailures.delete(account.id); return []; }
          models = await auth.cachedModels(account.id); catalogFailures.add(account.id);
        }
        return models.map((model) => descriptor(account, model, accounts.length > 1));
      }));
      return partitions.flat();
    },
    async resolve(modelID, effort = null) {
      const accountId = modelID.split(':')[1];
      const accounts = await auth.accounts();
      const account = accounts.find((entry) => entry.id === accountId);
      if (!account) throw new NativeAgentError('CHATGPT_ACCOUNT_NOT_FOUND', { status: 404, code: 'CHATGPT_ACCOUNT_NOT_FOUND' });
      if (account.status !== 'connected') throw new NativeAgentError('Sign in to ChatGPT and enable plan usage', { status: 401, code: 'CHATGPT_REAUTH_REQUIRED' });
      const includeAccount = accounts.filter((entry) => entry.status === 'connected').length > 1;
      const models = await auth.cachedModels(accountId);
      const model = models.find((entry) => descriptor(account, entry, includeAccount).id === modelID);
      if (!model) throw new NativeAgentError('This model is unavailable for the selected ChatGPT account', { status: 404, code: 'CHATGPT_MODEL_UNAVAILABLE' });
      const selected = descriptor(account, model, includeAccount);
      if (effort !== null && !selected.efforts.includes(effort)) {
        throw new NativeAgentError('This model does not support the selected reasoning effort', { status: 400, code: 'CHATGPT_UNSUPPORTED_EFFORT' });
      }
      return {
        key: `chatgpt:${accountId}:${await auth.revision(accountId)}:${model.slug}:${effort ?? 'default'}:${selected.contextWindow}:${selected.outputLimit}:${selected.input.image}`, model: model.slug,
        env: null, descriptor: selected,
        async acquire() {
          const grant = await bridge.acquire(accountId, model.slug, effort, selected.input.image);
          const env = claudeConnectionEnvironment({ baseURL: grant.baseURL, apiKey: grant.token, auth: 'api-key' }, { modelID: model.slug, contextWindow: selected.contextWindow, outputLimit: selected.outputLimit });
          env.ENABLE_TOOL_SEARCH = 'false';
          return { env, dispose: grant.dispose };
        },
      };
    },
    async signOut(id) { bridge.revoke(id); return auth.signOut(id); },
    async shutdown() { await Promise.all([auth.shutdown(), bridge.shutdown()]); },
  };
};
