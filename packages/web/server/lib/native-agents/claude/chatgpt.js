import { NativeAgentError } from '../errors.js';
import { createChatgptAuth } from './chatgpt-auth.js';
import { createChatgptBridge } from './chatgpt-bridge.js';
import { claudeConnectionEnvironment } from './connections.js';

const descriptor = (account, model) => ({
  id: `chatgpt:${account.id}:${Buffer.from(model.slug).toString('base64url')}`,
  name: `${account.label} / ${model.display_name}`,
  contextWindow: null, outputLimit: null, efforts: [], defaultEffort: null,
  fast: false, input: { image: false, pdf: false }, billing: 'chatgpt-plan',
});

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
      const accounts = await auth.accounts();
      const partitions = await Promise.all(accounts.filter((account) => account.status === 'connected').map(async (account) => {
        let models;
        try { models = await auth.models(account.id); catalogFailures.delete(account.id); }
        catch {
          if ((await auth.getAccount(account.id)).status !== 'connected') { catalogFailures.delete(account.id); return []; }
          models = await auth.cachedModels(account.id); catalogFailures.add(account.id);
        }
        return models.map((model) => descriptor(account, model));
      }));
      return partitions.flat();
    },
    async resolve(modelID) {
      const accountId = modelID.split(':')[1];
      const account = await auth.getAccount(accountId);
      if (account.status !== 'connected') throw new NativeAgentError('Sign in to ChatGPT and enable plan usage', { status: 401, code: 'CHATGPT_REAUTH_REQUIRED' });
      const models = await auth.cachedModels(accountId);
      const model = models.find((entry) => descriptor(account, entry).id === modelID);
      if (!model) throw new NativeAgentError('This model is unavailable for the selected ChatGPT account', { status: 404, code: 'CHATGPT_MODEL_UNAVAILABLE' });
      return {
        key: `chatgpt:${accountId}:${await auth.revision(accountId)}:${model.slug}`, model: model.slug,
        env: null, descriptor: descriptor(account, model),
        async acquire() {
          const grant = await bridge.acquire(accountId, model.slug);
          const env = claudeConnectionEnvironment({ baseURL: grant.baseURL, apiKey: grant.token, auth: 'api-key' }, { modelID: model.slug, contextWindow: null, outputLimit: null });
          env.ENABLE_TOOL_SEARCH = 'false';
          return { env, dispose: grant.dispose };
        },
      };
    },
    async signOut(id) { bridge.revoke(id); return auth.signOut(id); },
    async shutdown() { await Promise.all([auth.shutdown(), bridge.shutdown()]); },
  };
};
