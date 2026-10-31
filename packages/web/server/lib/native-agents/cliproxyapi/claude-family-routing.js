import { NativeAgentError } from '../errors.js';
import { isEnterpriseMode } from '../../enterprise-mode.js';
import { activeClaudeRoutes, latestFamilyBinding, CLAUDE_ROUTE_MODELS, claudeRouteAliases, claudeFamilyVersion, restoredFamilyModel, unifiedFamilyModel } from './claude-family-route.js';

const requireAllowed = () => {
  if (isEnterpriseMode()) throw new NativeAgentError('Provider connections are managed by your organization', { status: 403, code: 'enterprise_mode' });
};
// Preserve the deployed /opus-route error codes while sharing the implementation.
const changedDuringRefresh = () => new NativeAgentError('The Claude model connection changed. Refresh and try again.', { status: 409, code: 'CLIPROXYAPI_OPUS_CHANGED' });

/** Applies reserved aliases, auth priorities and the saved model as one recoverable operation. */
export const createClaudeFamilyRouting = ({ store, connections, clientFor, onModelsUpdated }) => {
  const commit = async (document, previous, models, route, accounts, removing = false) => {
    const active = activeClaudeRoutes(route).length > 0;
    if (active && !removing) requireAllowed();
    const client = clientFor(document);
    const aliases = await client.modelAliases();
    const oldRebind = await client.affinityRebind();
    const priorities = route?.priorities.slice() ?? [];
    const edits = active ? accounts.filter((account) => ['claude', 'antigravity'].includes(account.provider) && !account.disabled
      && account.priority !== (account.provider === 'claude' ? 100 : 0)) : [];
    const restore = active ? [] : document.claudeRoutes.priorities.filter((original) => accounts.some((account) => account.name === original.name));
    const applied = [];
    let changed = false;
    try {
      for (const account of edits) {
        if (!priorities.some((entry) => entry.name === account.name)) priorities.push({ name: account.name, priority: account.priority });
        await client.setAccountPriority(account.name, account.provider === 'claude' ? 100 : 0);
        applied.push({ name: account.name, priority: account.priority });
      }
      for (const original of restore) {
        const current = accounts.find((account) => account.name === original.name);
        await client.setAccountPriority(original.name, original.priority);
        applied.push({ name: original.name, priority: current.priority });
      }
      await client.setFamilyAliases(claudeRouteAliases(aliases, route), active ? 'quota' : document.claudeRoutes.previousRebind ?? 'any');
      if (active && !removing) requireAllowed();
      if (previous) {
        changed = await connections.refreshModelBindings(previous.id, previous.revision, models);
        if (!changed && JSON.stringify(previous.models) !== JSON.stringify(models)) throw changedDuringRefresh();
      }
      await store.update((current) => {
        if (JSON.stringify(current.claudeRoutes) !== JSON.stringify(document.claudeRoutes)) throw changedDuringRefresh();
        return { ...current, claudeRoutes: route ? { ...route, priorities: active ? priorities : [], previousRebind: active ? route.previousRebind ?? oldRebind : null } : null };
      });
    } catch (error) {
      try {
        if (changed) {
          const latest = (await connections.list()).find((connection) => connection.id === previous.id);
          if (latest && latest.revision === previous.revision + 1) await connections.refreshModelBindings(latest.id, latest.revision, previous.models);
        }
        await client.setFamilyAliases(aliases, oldRebind);
        for (const original of applied.reverse()) await client.setAccountPriority(original.name, original.priority);
      } catch {
        throw new NativeAgentError('Could not restore the previous Claude model routes. Check the gateway connection before continuing.', { status: 500, code: 'CLIPROXYAPI_OPUS_ROLLBACK_FAILED' });
      }
      throw error;
    }
    onModelsUpdated();
    return true;
  };

  return {
    async request(family, enabled) {
      if (enabled) requireAllowed();
      const document = await store.read();
      const saved = (await connections.list()).find((connection) => connection.baseURL === `http://127.0.0.1:${document.port}`
        && (!document.claudeRoutes || connection.id === document.claudeRoutes.connectionId));
      const current = document.claudeRoutes;
      const configured = current?.[family];
      if (!enabled) {
        if (!configured) return;
        const remaining = { ...current, [family]: null };
        const next = remaining.opus || remaining.sonnet ? remaining : null;
        const target = saved?.models.find((model) => model.id === configured.modelId && model.modelID === CLAUDE_ROUTE_MODELS[family]);
        if (!target && activeClaudeRoutes(current).length === 0) {
          await store.update((document) => ({ ...document, claudeRoutes: next }));
        } else {
          if (target && !configured.antigravity) throw new NativeAgentError('The saved Antigravity binding is unavailable. Reconnect Antigravity first.', { status: 409, code: 'CLIPROXYAPI_OPUS_UNAVAILABLE' });
          const models = target ? saved.models.map((model) => model.id === target.id ? restoredFamilyModel(family, target.id, configured.antigravity) : model) : null;
          await commit(document, target ? saved : null, models, next, await clientFor(document).accounts(), true);
        }
        return;
      }
      if (configured) return;
      const target = saved?.models.find((model) => model.followFamily === `antigravity-${family}`)
        ?? saved?.models.find((model) => claudeFamilyVersion(model.modelID)?.family === family);
      if (!saved || !target) throw new NativeAgentError(`Connect Antigravity and import its ${family === 'opus' ? 'Opus' : 'Sonnet'} model first.`, { status: 409, code: 'CLIPROXYAPI_OPUS_UNAVAILABLE' });
      await store.update((document) => ({ ...document, claudeRoutes: {
        ...(current ?? { connectionId: saved.id, opus: null, sonnet: null, priorities: [], previousRebind: null }),
        [family]: { modelId: target.id, claude: null, antigravity: null },
      } }));
    },

    async clear() {
      const document = await store.read();
      if (!document.claudeRoutes) return;
      if (activeClaudeRoutes(document.claudeRoutes).length > 0) await commit(document, null, null, null, await clientFor(document).accounts());
      else await store.update((current) => ({ ...current, claudeRoutes: null }));
    },

    async refresh(document, previous, models, primary, backup, accounts) {
      const current = document.claudeRoutes;
      if (!current || current.connectionId !== previous.id) return false;
      const next = { ...current };
      const replacements = new Map();
      for (const family of ['opus', 'sonnet']) {
        const route = current[family];
        if (!route || !models.some((model) => model.id === route.modelId)) continue;
        const binding = { ...route, claude: latestFamilyBinding(primary, route.claude, family), antigravity: latestFamilyBinding(backup, route.antigravity, family) };
        const model = unifiedFamilyModel(family, binding);
        if (!model) continue;
        next[family] = binding;
        replacements.set(route.modelId, model);
      }
      if (replacements.size === 0) return false;
      const updated = models.map((entry) => replacements.get(entry.id) ?? entry);
      const prioritiesChanged = accounts.some((account) => !account.disabled && ['claude', 'antigravity'].includes(account.provider)
        && account.priority !== (account.provider === 'claude' ? 100 : 0));
      if (JSON.stringify(current) === JSON.stringify(next) && JSON.stringify(previous.models) === JSON.stringify(updated) && !prioritiesChanged) return false;
      return commit(document, previous, updated, next, accounts);
    },
  };
};
