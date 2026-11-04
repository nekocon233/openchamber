import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError, invalidRequestError, sessionBusyError } from '../errors.js';
import { NATIVE_BACKENDS, nativeBackendSchema, nativeBackendOfProviderId, newNativeClientUserMessageId, isUnifiedNativeSessionId as isConversationId } from '../ids.js';
import { JsonRpcError } from '../codex/rpc.js';
import { createConversationStore, conversationSelectionSchema } from './store.js';
import { conversationMessageId, conversationPartId, projectConversationRecord, projectConversationPart, readConversationHistory, readConversationSegment, readConversationPage, conversationPrefix } from './history.js';
import { prepareConversationContext } from './context.js';
import { agentConfigurationWriteSchema } from '../agent-configuration.js';
import { conversationTitlePreview, createConversationAutoTitles } from './auto-title.js';
import { antigravityChecklistSnapshot } from '../antigravity/checklist.js';

const namespaceSchema = z.record(z.string(), z.json()).catch({});
const lifecycleSchema = z.record(nativeBackendSchema, z.object({
  stop: z.function(), retire: z.function(), delete: z.boolean(), compact: z.boolean(),
}));
const selectionOf = (request) => conversationSelectionSchema.parse({ model: request.model, agent: request.agent, variant: request.variant });
const checklistIdentity = (manifest, segment) => `antigravity:${manifest.id}:${segment.id}:${manifest.cut ?? 'full'}`;
const directoryKey = (directory) => {
  try { return fs.realpathSync.native(directory); }
  catch { return path.resolve(directory); }
};
const enterpriseError = () => new NativeAgentError('Unified native conversations are unavailable in enterprise mode.', {
  status: 403, code: 'enterprise_mode',
});
const unknownAdmission = () => new NativeAgentError('The previous send is unconfirmed. Reload its history before sending again.', {
  status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN',
});
const definiteRefusal = (error) => error instanceof JsonRpcError ? error.kind === 'response'
  : error instanceof NativeAgentError && !error.code.endsWith('_UNKNOWN');

/** The conversation owns logical history; the native runtime owns every CLI operation. */
export const createNativeConversations = ({ dataDir, native, registry, reverts, publishNativeEvent, sourceLifecycle, smallModels, managedChatsRoots, now = Date.now }) => {
  for (const backend of NATIVE_BACKENDS) {
    if (!sourceLifecycle[backend]) throw new Error(`Native backend ${backend} needs unified conversation lifecycle support`);
  }
  const lifecycles = lifecycleSchema.parse(sourceLifecycle);
  const store = createConversationStore({ directory: path.join(dataDir, 'native-agents', 'conversations'), now });
  const owned = new Set();
  // Includes sources left in the registry after an interrupted preparation.
  const undeletableOwners = new Set();
  const owners = new Map();
  const childRoots = new Map();
  const foreground = new Set();
  const background = new Map();
  const waiting = new Map();
  const questionOwners = new Map();
  const preparing = new Map();
  const handoffs = new Set();
  const operations = new Map();
  const clocks = new Map();
  const recoveryFailures = new Set();
  let ready;
  let sequence = 0;
  let stopping = false;

  const referencedSegments = (manifest) => [...manifest.segments, ...(manifest.admission?.rollback.segments ?? [])];
  const index = (manifest) => {
    for (const segment of referencedSegments(manifest)) {
      owned.add(segment.sessionId);
      owners.set(segment.sessionId, { id: segment.ownerId, segmentId: segment.id });
    }
  };
  const load = () => {
    ready ??= (async () => {
      await store.load();
      for (const entry of await registry.listSessions()) if (entry.conversationId) {
        owned.add(entry.sessionId);
        if (!lifecycles[entry.backend].delete) undeletableOwners.add(entry.conversationId);
      }
      for (const manifest of store.list()) index(manifest);
      for (const manifest of store.list()) if (manifest.admission?.phase === 'preparing') {
        try { await restorePreparation(manifest); }
        catch { recoveryFailures.add(manifest.id); }
      }
    })().catch((error) => { ready = undefined; throw error; });
    return ready;
  };
  const checkPolicy = () => { if (isEnterpriseMode()) throw enterpriseError(); };
  const retryUnavailable = async () => {
    for (const manifest of await store.retryUnavailable()) {
      index(manifest);
      if (manifest.admission?.phase === 'preparing' && !preparing.has(manifest.id)) recoveryFailures.add(manifest.id);
    }
    for (const id of [...recoveryFailures]) {
      try { await restorePreparation(store.get(id)); recoveryFailures.delete(id); }
      catch { /* The other readable conversations remain independently available. */ }
    }
  };
  const get = (id, directory) => {
    if (recoveryFailures.has(id)) throw new NativeAgentError('The conversation recovery could not be saved. Reload and retry.', {
      status: 500, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
    });
    const manifest = store.get(id);
    if (directory && directoryKey(directory) !== directoryKey(manifest.directory)) throw invalidRequestError('The conversation belongs to another directory');
    return manifest;
  };
  const activeOf = (manifest) => manifest.segments.find((segment) => segment.id === manifest.active);
  const sourceRoot = (id) => childRoots.get(id) ?? id;
  const hasLiveWork = (manifest, allowedForeground = null) => {
    if (native.hasActiveDelegations?.(manifest.id)) return true;
    const active = activeOf(manifest);
    if (!active) return false;
    if ((active.sessionId !== allowedForeground && foreground.has(active.sessionId)) || (background.get(active.sessionId)?.length ?? 0) > 0) return true;
    for (const child of childRoots.keys()) if (sourceRoot(child) === active.sessionId
      && (foreground.has(child) || (background.get(child)?.length ?? 0) > 0 || (waiting.get(child)?.size ?? 0) > 0)) return true;
    return false;
  };
  const blocked = (manifest, approval = null) => {
    if (hasLiveWork(manifest, approval?.allowedForeground)) return true;
    const requests = waiting.get(activeOf(manifest)?.sessionId);
    if (!approval) return Boolean(requests?.size);
    for (const id of requests ?? []) if (id !== approval.requestId) return true;
    return false;
  };
  const canDelete = (manifest) => (!native.canDeleteDelegations || native.canDeleteDelegations(manifest.id)) && !undeletableOwners.has(manifest.id)
    && referencedSegments(manifest).every((segment) => lifecycles[segment.backend].delete && (!native.canDeleteSource || native.canDeleteSource(segment.backend)));
  const recordOf = (manifest) => {
    const active = activeOf(manifest);
    const backend = active?.backend ?? nativeBackendOfProviderId(manifest.selection.model.providerID);
    const namespace = namespaceSchema.parse(manifest.metadata.openchamber);
    const record = {
      id: manifest.id, slug: manifest.id, projectID: '', directory: manifest.directory,
      title: manifest.title, version: 'unified-native', agent: manifest.selection.agent,
      model: { providerID: manifest.selection.model.providerID, id: manifest.selection.model.modelID, ...(manifest.selection.variant ? { variant: manifest.selection.variant } : {}) },
      time: { created: manifest.createdAt, updated: manifest.updatedAt, ...(manifest.archivedAt === undefined ? {} : { archived: manifest.archivedAt }) },
      metadata: { ...manifest.metadata, openchamber: { ...namespace, native: {
        kind: 'unified', backend, unifiedBackends: NATIVE_BACKENDS,
        revision: manifest.selectionRevision, recordRevision: manifest.revision, historyRevision: manifest.historyRevision,
        sourceSessionID: active?.sessionId ?? null,
        switchReady: !blocked(manifest) && !preparing.has(manifest.id) && !manifest.admission && !manifest.deletion,
        preparing: handoffs.has(manifest.id),
        actions: { revert: !manifest.deletion, delete: canDelete(manifest), fork: !manifest.deletion, compact: lifecycles[backend].compact },
      } } },
    };
    if (manifest.parentID) record.parentID = manifest.parentID;
    if (manifest.agents) record.metadata.openchamber.native.agents = manifest.agents;
    if (manifest.cut) record.revert = { messageID: manifest.cut };
    return record;
  };
  const emit = (manifest, type, properties) => publishNativeEvent({
    directory: manifest.directory,
    payload: { id: `ncvevt_${now()}_${++sequence}`, type, properties },
  });
  const publish = (manifest, created = false) => {
    emit(manifest, created ? 'session.created' : 'session.updated', { info: recordOf(manifest) });
    return recordOf(manifest);
  };
  const titles = createConversationAutoTitles({ store, native, smallModels, publish });
  const update = async (id, change) => {
    const manifest = await store.update(id, change);
    index(manifest);
    return manifest;
  };
  const restorePreparation = async (manifest) => {
    const admission = manifest.admission;
    if (!admission || admission.phase !== 'preparing') return manifest;
    await reverts.cancelCommit(manifest.id);
    const restored = await update(manifest.id, (current) => {
      current.segments = admission.rollback.segments;
      current.active = admission.rollback.active;
      current.cut = admission.rollback.cut;
      current.checkpoint = admission.rollback.checkpoint;
      current.historyRevision += 1;
      delete current.admission;
      return current;
    });
    await registry.dropTurns(manifest.id, [admission.messageId]);
    return restored;
  };
  const locked = (id, work) => {
    const previous = operations.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => { await load(); return work(); });
    operations.set(id, run);
    run.finally(() => { if (operations.get(id) === run) operations.delete(id); }).catch(() => undefined);
    return run;
  };
  const assertStandalone = (id) => {
    if (owned.has(id)) throw new NativeAgentError('This native session is managed by a unified conversation. Open that conversation to continue.', {
      status: 409, code: 'NATIVE_CONVERSATION_OWNS_SESSION',
    });
  };
  const refreshActivity = async (manifest) => {
    const [statuses, tasks, questions] = await Promise.all([
      native.statuses(manifest.directory), native.backgroundTasks(), native.questions(manifest.directory),
    ]);
    for (const segment of manifest.segments) {
      if (statuses[segment.sessionId] && statuses[segment.sessionId].type !== 'idle') foreground.add(segment.sessionId);
      else foreground.delete(segment.sessionId);
      background.set(segment.sessionId, tasks[segment.sessionId]?.tasks ?? []);
      waiting.set(segment.sessionId, new Set(questions.filter((question) => question.sessionID === segment.sessionId).map((question) => question.id)));
    }
    for (const id of childRoots.keys()) {
      background.set(id, tasks[id]?.tasks ?? []);
      if (statuses[id] && statuses[id].type !== 'idle') foreground.add(id);
      else foreground.delete(id);
    }
  };
  const assertQuiet = async (manifest, approval = null) => {
    await refreshActivity(manifest);
    if (native.hasActiveDelegations?.(manifest.id)) throw sessionBusyError();
    if (approval && activeOf(manifest) && await native.hasPendingDelegationTool?.(activeOf(manifest).sessionId)) throw sessionBusyError();
    if (blocked(manifest, approval)) throw sessionBusyError();
  };
  const historyOf = async (manifest) => {
    const history = await readConversationHistory(native, manifest);
    if (get(manifest.id).historyRevision !== manifest.historyRevision) throw new NativeAgentError('Conversation history changed. Reload and retry.', {
      status: 409, code: 'NATIVE_HISTORY_CHANGED',
    });
    return history;
  };
  const stop = async (manifest) => {
    let delegationError;
    try { await native.cancelDelegations?.(manifest.id); }
    catch (error) { delegationError = error; }
    preparing.get(manifest.id)?.abort(new Error('Conversation preparation stopped'));
    const active = activeOf(manifest);
    if (!active) { if (delegationError) throw delegationError; return false; }
    try { await lifecycles[active.backend].stop(active.sessionId); }
    catch (error) {
      if (error instanceof NativeAgentError && error.status === 404) return false;
      throw error;
    }
    for (const [child, root] of childRoots) if (root === active.sessionId && foreground.has(child)) await native.abort(child);
    await refreshActivity(manifest);
    if (delegationError) throw delegationError;
    if (blocked(manifest)) throw sessionBusyError();
    return true;
  };

  const recoverAdmission = async (manifest, messageId) => {
    if (!manifest.admission) return false;
    if (manifest.admission.phase === 'preparing') {
      if (preparing.has(manifest.id)) throw unknownAdmission();
      await restorePreparation(manifest);
      return false;
    }
    const segment = manifest.segments.find((entry) => entry.id === manifest.admission.segmentId);
    const send = segment?.sends.find((entry) => entry.messageId === manifest.admission.messageId);
    if (!segment || !send) throw unknownAdmission();
    const history = await readConversationSegment(native, manifest, segment);
    if (!history.records.some((record) => record.info.id === send.nativeMessageId)) throw unknownAdmission();
    await update(manifest.id, (current) => {
      const admitted = current.segments.find((entry) => entry.id === segment.id)?.sends.find((entry) => entry.messageId === send.messageId);
      if (admitted) admitted.state = 'accepted';
      delete current.admission;
      return current;
    });
    if (send.messageId === messageId) return true;
    return false;
  };

  const prompt = (id, request, signal, automaticSource = null, automaticMessageId = null, approval = null) => locked(id, async () => {
    checkPolicy();
    if (stopping) throw sessionBusyError();
    let manifest = get(id, request.directory);
    if (manifest.archivedAt !== undefined || manifest.deletion) throw invalidRequestError('Restore this conversation before sending');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      parts: request.parts, model: request.model, variant: request.variant, agent: request.agent, instructions: request.instructions,
    })).digest('hex');
    let previousSend = manifest.segments.filter((segment) => segment.ownerId === id).flatMap((segment) => segment.sends).find((send) => send.messageId === request.messageID);
    let replacesRevertedSend = false;
    if (manifest.cut && previousSend) {
      const history = await historyOf(manifest);
      const cut = history.entries.findIndex((entry) => entry.record.info.id === manifest.cut);
      const previous = history.entries.findIndex((entry) => entry.record.info.id === request.messageID);
      if (cut === -1) throw invalidRequestError('Unknown conversation rewind point');
      if (previous >= cut) { previousSend = undefined; replacesRevertedSend = true; }
    }
    if (previousSend && previousSend.fingerprint !== fingerprint) throw new NativeAgentError('This message id already belongs to another send.', {
      status: 409, code: 'NATIVE_CONVERSATION_MESSAGE_CONFLICT',
    });
    if (await recoverAdmission(manifest, request.messageID)) return;
    manifest = get(id);
    const existing = replacesRevertedSend ? undefined : manifest.segments.filter((segment) => segment.ownerId === id).flatMap((segment) => segment.sends).find((send) => send.messageId === request.messageID);
    if (existing?.state === 'accepted') return;
    const target = selectionOf(request);
    const backend = nativeBackendOfProviderId(target.model.providerID);
    const old = activeOf(manifest);
    if (automaticSource && (!old || old.sessionId !== automaticSource)) throw invalidRequestError('The original planning session is no longer active');
    if (approval?.expectedRevision !== undefined && manifest.selectionRevision !== approval.expectedRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', {
      status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT',
    });
    const switching = !old || old.backend !== backend || manifest.cut !== undefined || old.ownerId !== id || old.through !== undefined;
    if (switching || approval) await assertQuiet(manifest, approval);
    if (!request.preserveSelection && !automaticSource && JSON.stringify(manifest.selection) !== JSON.stringify(target)) {
      manifest = await update(id, (current) => ({ ...current, selection: target, selectionRevision: current.selectionRevision + 1 }));
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    preparing.set(id, controller);
    if (switching && manifest.segments.length > 0) handoffs.add(id);
    publish(manifest);
    const prior = { segments: structuredClone(manifest.segments), active: manifest.active, cut: manifest.cut, checkpoint: manifest.checkpoint };
    let segment = old;
    let nativeMessageId = automaticSource && old?.backend !== backend ? null : automaticMessageId;
    let dispatched = false;
    let accepted = false;
    let reverting = false;
    try {
      let instructions;
      if (switching) {
        const history = await historyOf(manifest);
        if (!history.metadataComplete) throw new NativeAgentError('Some conversation history is unavailable. Reload before preparing the handoff.', {
          status: 502, code: 'NATIVE_CONVERSATION_HISTORY_UNAVAILABLE',
        });
        const end = manifest.cut ? history.entries.findIndex((entry) => entry.record.info.id === manifest.cut) : history.entries.length;
        if (end === -1) throw invalidRequestError('Unknown conversation rewind point');
        const catalog = (await native.catalog()).backends[backend];
        if (catalog?.status !== 'ok') throw new NativeAgentError('The selected native model catalog is unavailable. Retry after reconnecting the backend.', {
          status: 503, code: 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE',
        });
        instructions = await prepareConversationContext({
          manifest, entries: history.entries.slice(0, end), target, catalog, smallModels,
          signal: controller.signal, saveCheckpoint: (checkpoint) => update(id, (current) => ({ ...current, checkpoint })),
        });
        controller.signal.throwIfAborted();
        if (old) await lifecycles[old.backend].retire(old.sessionId);
        if (manifest.cut) {
          reverting = true;
        }
        const retained = manifest.cut ? conversationPrefix(manifest, history, manifest.cut) : structuredClone(manifest.segments);
        if (!manifest.cut && old) {
          const last = history.entries.findLast((entry) => entry.segmentId === old.id);
          const previous = retained.find((entry) => entry.id === old.id);
          if (last && previous) previous.through = last.nativeMessageId;
        }
        await native.createSession({ backend, directory: manifest.directory, ...(manifest.manualTitle ? { title: manifest.title } : {}) }, {
          toolLaunch: { subagentModel: request.subagentModel !== undefined ? request.subagentModel : manifest.agents?.subagent ?? null },
          beforePublish: async (source) => {
            owned.add(source.id);
            await registry.updateSession(source.id, { conversationId: id });
            if (!lifecycles[backend].delete) undeletableOwners.add(id);
            segment = { id: randomUUID(), ownerId: id, sessionId: source.id, backend, createdAt: now(), sends: [] };
            nativeMessageId = newNativeClientUserMessageId(source.id);
            segment.sends.push({ messageId: request.messageID, nativeMessageId, createdAt: now(), state: 'pending', fingerprint, selection: target });
            manifest = await update(id, (current) => {
              current.segments = [...retained, segment];
              current.active = segment.id;
              current.admission = { segmentId: segment.id, messageId: request.messageID, phase: 'preparing', rollback: prior };
              if (current.cut) {
                current.historyRevision += 1;
                delete current.cut;
                delete current.checkpoint;
              }
              return current;
            });
          },
        });
      }
      controller.signal.throwIfAborted();
      nativeMessageId ??= newNativeClientUserMessageId(segment.sessionId);
      manifest = await update(id, (current) => {
        if (!current.manualTitle && !current.generatedTitle && current.segments.length === 1
          && current.segments[0].sends.every((send) => send.messageId === request.messageID)) {
          const preview = conversationTitlePreview(request.parts);
          if (preview) current.title = preview;
        }
        if (!switching) {
          current.segments.find((entry) => entry.id === segment.id).sends.push({
            messageId: request.messageID, nativeMessageId, createdAt: now(), state: 'pending', fingerprint, selection: target,
          });
        }
        current.admission = { segmentId: segment.id, messageId: request.messageID, phase: 'preparing', rollback: prior };
        return current;
      });
      await reverts.beforePrompt(id, manifest.directory, request.messageID);
      controller.signal.throwIfAborted();
      if (reverting) await reverts.beginCommit(id);
      if (manifest.agents) await registry.updateSession(segment.sessionId, { agentConfiguration: manifest.agents });
      await update(id, (current) => { current.admission.phase = 'dispatched'; return current; });
      controller.signal.throwIfAborted();
      await approval?.onDispatched?.();
      controller.signal.throwIfAborted();
      dispatched = true;
      await native.prompt(segment.sessionId, {
        ...request, directory: manifest.directory, messageID: nativeMessageId,
        instructions: [request.instructions, instructions].filter(Boolean).join('\n\n') || undefined,
      }, controller.signal);
      accepted = true;
      await update(id, (current) => {
        current.segments.find((entry) => entry.id === segment.id).sends.find((entry) => entry.messageId === request.messageID).state = 'accepted';
        delete current.admission;
        return current;
      });
      if (reverting) await reverts.finishCommit(id);
      if (!foreground.has(segment.sessionId)) void titles.generate(id);
    } catch (error) {
      const definitelyRefused = !accepted && (!dispatched || definiteRefusal(error));
      if (definitelyRefused) {
        await update(id, (current) => {
          if (switching) {
            current.segments = prior.segments;
            current.active = prior.active;
            current.cut = prior.cut;
            current.checkpoint = prior.checkpoint;
            if (reverting) current.historyRevision += 1;
          } else {
            const active = current.segments.find((entry) => entry.id === segment.id);
            if (active) active.sends = active.sends.filter((entry) => entry.messageId !== request.messageID);
          }
          delete current.admission;
          return current;
        });
        if (reverting) await reverts.cancelCommit(id);
        await registry.dropTurns(id, [request.messageID]);
        if (switching && segment && segment.id !== old?.id) {
          try {
            await lifecycles[segment.backend].retire(segment.sessionId);
            if (lifecycles[segment.backend].delete) await native.deleteSession(segment.sessionId, manifest.directory);
          }
          catch { /* The registry retains ownership for cleanup when the conversation is deleted. */ }
        }
        await approval?.onRefused?.();
      } else {
        throw new NativeAgentError('The native send may have been accepted. Reload to confirm it before retrying.', {
          status: 502, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN',
        });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      preparing.delete(id);
      handoffs.delete(id);
      publish(get(id));
    }
  });

  const sourceFor = async (id, directory) => {
    await load();
    const manifest = get(id, directory);
    const segment = activeOf(manifest);
    return { manifest, segment };
  };

  const api = {
    ...native,
    async capabilities() {
      await load();
      const capabilities = await native.capabilities();
      for (const backend of Object.keys(capabilities.backends)) {
        if (!lifecycles[backend]) throw new Error(`Native backend ${backend} needs unified conversation lifecycle support`);
      }
      const enabled = !isEnterpriseMode();
      return { ...capabilities, unifiedSessions: enabled, unifiedBackends: enabled ? NATIVE_BACKENDS : [] };
    },
    async createSession(input) {
      await load();
      if (input.kind !== 'unified') return native.createSession(input);
      checkPolicy();
      if (stopping) throw sessionBusyError();
      const selection = conversationSelectionSchema.parse(input.selection);
      const agents = input.configuration ? { ...await native.validateAgentConfiguration(input.configuration, selection), revision: 1 } : undefined;
      if (nativeBackendOfProviderId(selection.model.providerID) !== input.backend) throw invalidRequestError('The initial model does not match its native backend');
      return publish(await store.create({ directory: directoryKey(input.directory), selection, agents, manualTitle: Boolean(input.title), ...(input.title ? { title: input.title } : {}) }), true);
    },
    async selectModel(id, directory, selection, expectedRevision) {
      await load(); checkPolicy(); get(id, directory);
      const next = conversationSelectionSchema.parse(selection);
      return publish(await update(id, (current) => {
        if (current.selectionRevision !== expectedRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', {
          status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT',
        });
        current.selection = next;
        current.selectionRevision += 1;
        return current;
      }));
    },
    async configureAgents(id, directory, configuration, expectedRevision, main, expectedSelectionRevision) {
      await load(); checkPolicy();
      if (!isConversationId(id)) { assertStandalone(id); return native.configureAgents(id, directory, configuration, expectedRevision, main); }
      get(id, directory);
      const parsed = agentConfigurationWriteSchema.parse(configuration);
      await native.validateAgentConfiguration(parsed, main);
      const selection = main ? conversationSelectionSchema.parse(main) : null;
      return publish(await update(id, (current) => {
        if ((current.agents?.revision ?? 0) !== expectedRevision || selection && current.selectionRevision !== expectedSelectionRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', { status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT' });
        current.agents = { ...parsed, revision: expectedRevision + 1 };
        if (selection) { current.selection = selection; current.selectionRevision += 1; }
        return current;
      }));
    },
    async listSessions(directory) {
      await load();
      await retryUnavailable();
      const result = await native.listSessions(directory);
      for (const partition of Object.values(result.backends)) if (partition.status === 'ok') partition.sessions = partition.sessions.filter((session) => !owned.has(session.id));
      return { ...result, unified: {
        status: 'ok', sessions: store.list().filter((manifest) => !recoveryFailures.has(manifest.id) && directoryKey(manifest.directory) === directoryKey(directory)).map(recordOf),
        unavailable: [...store.unavailable(), ...recoveryFailures],
      } };
    },
    async managedChatDirectories() {
      await load();
      const roots = new Set(managedChatsRoots.flatMap((root) => [path.resolve(root), directoryKey(root)]));
      const unified = store.list().filter((manifest) => [...roots].some((root) => manifest.directory.startsWith(`${root}${path.sep}`)));
      return [...new Set([...await native.managedChatDirectories(), ...unified.map((manifest) => manifest.directory)])];
    },
    async getSession(id, directory) {
      await load();
      if (!isConversationId(id)) return native.getSession(id, directory);
      if (store.unavailable().includes(id) || recoveryFailures.has(id)) await retryUnavailable();
      let manifest = get(id, directory);
      if (manifest.admission) {
        try { await recoverAdmission(manifest); manifest = get(id, directory); }
        catch (error) { if (!(error instanceof NativeAgentError) || error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') throw error; }
      }
      await refreshActivity(manifest);
      return recordOf(manifest);
    },
    async sessionExists(id, directory) {
      await load();
      if (!isConversationId(id)) return native.sessionExists(id, directory);
      if (store.unavailable().includes(id)) get(id, directory);
      if (!store.peek(id)) return false;
      get(id, directory);
      return true;
    },
    async prompt(id, request, signal) {
      await load();
      if (isConversationId(id)) return prompt(id, request, signal);
      assertStandalone(id);
      return native.prompt(id, request, signal);
    },
    async loadMessages(id, directory, page) {
      await load();
      if (!isConversationId(id)) return native.loadMessages(id, directory, page);
      const manifest = get(id, directory);
      const result = await readConversationPage(native, manifest, page);
      if (native.delegatedChildren) {
        try {
          const children = await native.delegatedChildren(id);
          result.childSessions = [...result.childSessions, ...children.filter((child) => !result.childSessions.some((entry) => entry.id === child.id))];
        } catch { result.metadataComplete = false; }
      }
      if (get(id).historyRevision !== manifest.historyRevision) throw new NativeAgentError('Conversation history changed. Reload and retry.', { status: 409, code: 'NATIVE_HISTORY_CHANGED' });
      return result;
    },
    async statuses(directory) {
      await load();
      const statuses = await native.statuses(directory);
      const result = Object.fromEntries(Object.entries(statuses).filter(([id]) => !owned.has(id)));
      for (const manifest of store.list()) {
        if (directoryKey(manifest.directory) !== directoryKey(directory)) continue;
        const source = activeOf(manifest)?.sessionId;
        if (preparing.has(manifest.id) || (source && statuses[source])) result[manifest.id] = statuses[source] ?? { type: 'busy' };
      }
      return result;
    },
    async backgroundTasks() {
      await load();
      const result = {};
      for (const [id, tasks] of Object.entries(await native.backgroundTasks())) {
        const owner = owners.get(id);
        if (owner) result[owner.id] = tasks;
        else if (!owned.has(id)) result[id] = tasks;
      }
      return result;
    },
    async questions(directory) {
      await load();
      return (await native.questions(directory)).map((question) => {
        const owner = owners.get(question.sessionID);
        const manifest = owner && store.peek(owner.id);
        const segment = manifest?.segments.find((entry) => entry.id === owner.segmentId);
        if (!segment) return question;
        questionOwners.set(question.id, { id: manifest.id, selection: manifest.selection, plan: question.kind?.endsWith('-plan-exit') === true });
        return { ...question, sessionID: manifest.id, ...(question.tool ? { tool: {
          ...question.tool, messageID: conversationMessageId(manifest.id, segment, question.tool.messageID),
        } } : {}) };
      }).filter((question) => !owned.has(question.sessionID));
    },
    async replyQuestion(requestId, answers, execution) {
      await load();
      const decision = questionOwners.get(requestId);
      const approves = answers.length === 1 && answers[0].length === 1 && answers[0][0] === 'build';
      if (decision && !(decision.plan && answers.length === 1 && answers[0].length === 1 && answers[0][0] === 'plan')) checkPolicy();
      const result = await (execution ? native.replyQuestion(requestId, answers, execution) : native.replyQuestion(requestId, answers));
      if (decision?.plan && approves && store.peek(decision.id)) {
        const expected = JSON.stringify(decision.selection);
        publish(await update(decision.id, (current) => {
          const applied = result?.execution ?? execution;
          if (applied && current.selectionRevision === applied.expectedRevision) {
            current.selection = { model: applied.model, variant: applied.variant, agent: 'build' };
            current.selectionRevision += 1;
          } else if (!applied && JSON.stringify(current.selection) === expected && current.selection.agent !== 'build') {
            current.selection = { ...current.selection, agent: 'build' };
            current.selectionRevision += 1;
          }
          return current;
        }));
      }
      return result;
    },
    async abort(id) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.abort(id); }
      const controller = preparing.get(id);
      controller?.abort(new Error('Conversation preparation stopped'));
      const source = activeOf(get(id))?.sessionId;
      return source ? await native.abort(source) || Boolean(controller) : Boolean(controller);
    },
    async updateSession(id, directory, patch) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.updateSession(id, directory, patch); }
      if (patch.title !== undefined || patch.archived) titles.cancel(id);
      if (patch.archived) preparing.get(id)?.abort(new Error('Conversation archived'));
      return locked(id, async () => {
        const manifest = get(id, directory);
        if (patch.archived) await stop(manifest);
        return publish(await update(id, (current) => {
          if (patch.title !== undefined) { current.title = patch.title; current.manualTitle = true; }
          if (patch.archived === true) current.archivedAt = now();
          if (patch.archived === false) delete current.archivedAt;
          if (patch.metadata !== undefined) {
            const namespace = namespaceSchema.parse(patch.metadata.openchamber);
            delete namespace.native;
            current.metadata = { ...patch.metadata, openchamber: namespace };
          }
          return current;
        }));
      });
    },
    async revert(id, messageId, directory) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.revert(id, messageId, directory); }
      titles.cancel(id);
      preparing.get(id)?.abort(new Error('Conversation rewound'));
      return locked(id, async () => {
        const manifest = get(id, directory);
        await stop(manifest);
        if (manifest.admission) await recoverAdmission(manifest);
        const history = await historyOf(manifest);
        const index = history.entries.findIndex((entry) => entry.record.info.id === messageId && entry.record.info.role === 'user');
        if (index === -1) throw invalidRequestError('Unknown conversation user message');
        const result = await reverts.revert({ sessionId: id, messageId,
          messageIds: history.entries.slice(index).filter((entry) => entry.record.info.role === 'user').map((entry) => entry.record.info.id), rewind: {} });
        return { session: publish(await update(id, (current) => ({ ...current, cut: messageId }))), ...result };
      });
    },
    async unrevert(id, directory) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.unrevert(id, directory); }
      return locked(id, async () => {
        get(id, directory);
        await reverts.unrevert(id);
        return publish(await update(id, (current) => { delete current.cut; return current; }));
      });
    },
    async fork(id, messageId, directory) {
      await load();
      if (!isConversationId(id)) return native.fork(id, messageId, directory);
      return locked(id, async () => {
        const manifest = get(id, directory);
        const history = await historyOf(manifest);
        const child = await store.create({
          directory: manifest.directory, title: `${manifest.title} (fork)`, selection: manifest.selection,
          segments: conversationPrefix(manifest, history, messageId), agents: manifest.agents, metadata: {}, manualTitle: true,
        });
        index(child);
        return publish(child, true);
      });
    },
    async deleteSession(id, directory) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.deleteSession(id, directory); }
      await native.assertDelegatedDeletion?.(id);
      preparing.get(id)?.abort(new Error('Conversation deleted'));
      return locked(id, async () => {
        let manifest = get(id, directory);
        if (!canDelete(manifest)) throw new NativeAgentError('A native source does not support deletion. Archive this conversation instead.', {
          status: 409, code: 'NATIVE_CONVERSATION_DELETE_UNSUPPORTED',
        });
        await stop(manifest);
        await retryUnavailable();
        if (store.unavailable().length > 0) throw new NativeAgentError('Unreadable conversation records prevent safe shared-history cleanup. Restore those records and retry.', {
          status: 409, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
        });
        const sources = new Set(referencedSegments(manifest).map((segment) => segment.sessionId));
        for (const entry of await registry.listSessions()) if (entry.conversationId === id) sources.add(entry.sessionId);
        const retained = new Set(store.list().filter((entry) => entry.id !== id).flatMap((entry) => referencedSegments(entry).map((segment) => segment.sessionId)));
        await native.removeDelegatedChildren?.(id, retained);
        manifest = await update(id, (current) => ({ ...current, deletion: current.deletion ?? [...sources].filter((source) => !retained.has(source)) }));
        for (const source of [...manifest.deletion]) {
          try { await native.deleteSession(source, manifest.directory); }
          catch (error) { if (!(error instanceof NativeAgentError) || error.status !== 404) throw new NativeAgentError('Some native history could not be deleted. Retry deletion to finish cleanup.', {
            status: 502, code: 'NATIVE_CONVERSATION_DELETE_INCOMPLETE',
          }); }
          manifest = await update(id, (current) => ({ ...current, deletion: current.deletion.filter((entry) => entry !== source) }));
        }
        await registry.removeSession(id);
        await store.remove(id);
        for (const source of sources) {
          if (retained.has(source)) continue;
          owned.delete(source);
          owners.delete(source);
          foreground.delete(source);
          background.delete(source);
          waiting.delete(source);
          clocks.delete(source);
          for (const [child, root] of childRoots) if (root === source) { foreground.delete(child); childRoots.delete(child); }
        }
        emit(manifest, 'session.deleted', { sessionID: id });
        return { deleted: true };
      });
    },
    async compact(id, request) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.compact(id, request); }
      return locked(id, async () => {
        const { manifest, segment } = await sourceFor(id, request.directory);
        checkPolicy();
        await assertQuiet(manifest);
        if (segment && !lifecycles[segment.backend].compact) throw new NativeAgentError('This native source does not support manual compaction. Select and send to another backend before compacting.', {
          status: 409, code: 'NATIVE_CONVERSATION_COMPACT_UNSUPPORTED',
        });
        if (!segment) return;
        if (manifest.admission) throw unknownAdmission();
        if (manifest.cut || segment.ownerId !== id || segment.through !== undefined
          || segment.backend !== nativeBackendOfProviderId(request.model.providerID)) throw invalidRequestError('Send a message to the selected backend before compacting it');
        return native.compact(segment.sessionId, { ...request, directory: manifest.directory });
      });
    },
    async commands(backend, directory, id) {
      if (!id || !isConversationId(id)) return native.commands(backend, directory, id);
      const { segment } = await sourceFor(id, directory);
      return native.commands(backend, directory, segment?.backend === backend ? segment.sessionId : undefined);
    },
    async codexCommand(input) {
      if (!input.sessionId || !isConversationId(input.sessionId)) {
        await load();
        if (input.sessionId) assertStandalone(input.sessionId);
        return native.codexCommand(input);
      }
      return locked(input.sessionId, async () => {
        const { manifest, segment } = await sourceFor(input.sessionId, input.directory);
        checkPolicy();
        if (segment?.backend !== 'codex') throw invalidRequestError('Send a message to Codex before using its session commands');
        if (input.name === 'review') {
          await assertQuiet(manifest);
          if (manifest.cut || manifest.admission) throw sessionBusyError();
        }
        return native.codexCommand({ ...input, sessionId: segment.sessionId });
      });
    },
    async deepseekCommand(input) {
      if (!isConversationId(input.sessionId)) { await load(); assertStandalone(input.sessionId); return native.deepseekCommand(input); }
      return locked(input.sessionId, async () => {
        const { manifest, segment } = await sourceFor(input.sessionId, input.directory);
        checkPolicy();
        if (segment?.backend !== 'deepseek') throw invalidRequestError('Send a message to DeepSeek before using its session commands');
        if (manifest.cut || manifest.admission) throw sessionBusyError();
        return native.deepseekCommand({ ...input, sessionId: segment.sessionId });
      });
    },
    hasPendingPlanDecision(id) {
      const source = isConversationId(id) ? activeOf(get(id))?.sessionId : id;
      return source ? native.hasPendingPlanDecision(source) : false;
    },
    async setSessionAssist(id, directory, assist) {
      if (!isConversationId(id)) return native.setSessionAssist(id, directory, assist);
      await load(); get(id, directory);
      return publish(await update(id, (current) => ({ ...current, metadata: { ...current.metadata,
        openchamber: { ...namespaceSchema.parse(current.metadata.openchamber), assist } } })));
    },
    async setSessionWork(id, directory, work) {
      if (!isConversationId(id)) return native.setSessionWork(id, directory, work);
      await load(); get(id, directory);
      return publish(await update(id, (current) => ({ ...current, metadata: { ...current.metadata,
        openchamber: { ...namespaceSchema.parse(current.metadata.openchamber), work } } })));
    },
    async shutdown() {
      stopping = true;
      for (const controller of preparing.values()) controller.abort(new Error('Native conversations are shutting down'));
      const closing = native.shutdown();
      await Promise.allSettled([closing, titles.stop(), ...operations.values()]);
      await store.drain();
    },
  };

  const sourceRead = (method, empty) => async (id, directory, ...args) => {
    if (!isConversationId(id)) return native[method](id, directory, ...args);
    const { segment } = await sourceFor(id, directory);
    if (!segment) return empty;
    return native[method](segment.sessionId, directory, ...args);
  };
  api.checklist = async (id, directory) => {
    if (!isConversationId(id)) return native.checklist(id, directory);
    const { manifest, segment: active } = await sourceFor(id, directory);
    let segment = active ?? manifest.segments.at(-1);
    if (!segment) return { state: 'unavailable', reason: nativeBackendOfProviderId(manifest.selection.model.providerID) === 'antigravity' ? 'source_unknown' : 'unsupported' };
    if (segment.backend !== 'antigravity') return active
      ? native.checklist(active.sessionId, directory) : { state: 'unavailable', reason: 'unsupported' };
    let records;
    let complete;
    if (manifest.cut) {
      const history = await historyOf(manifest);
      const end = history.entries.findIndex((entry) => entry.record.info.id === manifest.cut);
      if (end === -1) throw invalidRequestError('Unknown conversation rewind point');
      const retained = history.entries.slice(0, end);
      segment = manifest.segments.find((entry) => entry.id === retained.at(-1)?.segmentId);
      if (segment?.backend !== 'antigravity') return { state: 'unavailable', reason: 'source_unknown' };
      records = retained.filter((entry) => entry.segmentId === segment.id).map((entry) => entry.record);
      complete = history.metadataComplete;
    } else {
      const history = await readConversationSegment(native, manifest, segment);
      records = history.records;
      complete = history.metadataComplete;
    }
    const snapshot = antigravityChecklistSnapshot({ sessionId: segment.sessionId, records, complete, observedAt: now() });
    return snapshot.state === 'ready' ? { ...snapshot, identity: checklistIdentity(manifest, segment) } : snapshot;
  };
  api.plan = sourceRead('plan', { state: 'empty' });
  api.codexTodos = sourceRead('codexTodos', { state: 'unsupported', generation: null, revision: 0, todos: [] });
  api.sessionTasks = sourceRead('sessionTasks', { state: 'unsupported', generation: null, revision: 0, tasks: [], omitted: 0 });
  api.taskOutput = sourceRead('taskOutput', { state: 'unavailable', reason: 'not_recorded' });
  api.stopTask = async (id, directory, taskId, generation) => {
    if (!isConversationId(id)) return native.stopTask(id, directory, taskId, generation);
    const { segment } = await sourceFor(id, directory);
    if (!segment) throw new NativeAgentError('Task stopping is unsupported', { status: 501, code: 'NATIVE_TASK_STOP_UNAVAILABLE' });
    return native.stopTask(segment.sessionId, directory, taskId, generation);
  };

  return {
    api,
    delegationActivity(id) {
      const manifest = store.peek(id);
      if (manifest) publish(manifest);
    },
    async validatePlanExecution(source, directory, requestId, execution, handoff, approves = true) {
      await load();
      const owner = owners.get(source);
      if (!owner) { assertStandalone(source); return false; }
      checkPolicy();
      const manifest = get(owner.id, directory);
      if (activeOf(manifest)?.sessionId !== source) throw invalidRequestError('The original planning session is no longer active');
      if (approves && execution.expectedRevision !== manifest.selectionRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', {
        status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT',
      });
      if (handoff) await assertQuiet(manifest, { requestId, allowedForeground: source });
      return true;
    },
    async planExecutionOutcome(source, directory, state) {
      await load();
      const owner = owners.get(source);
      if (!owner) { assertStandalone(source); return null; }
      let manifest = get(owner.id, directory);
      try { await recoverAdmission(manifest, state.logicalMessageID); }
      catch (error) {
        if (!(error instanceof NativeAgentError) || error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') throw error;
        return 'unknown';
      }
      manifest = get(owner.id, directory);
      const send = manifest.segments.flatMap((segment) => segment.sends).find((send) => send.messageId === state.logicalMessageID);
      if (send?.state === 'accepted') return 'accepted';
      if (send || manifest.admission || activeOf(manifest)?.sessionId !== source) return 'unknown';
      const retained = new Set(manifest.segments.map((segment) => segment.sessionId));
      const orphan = (await registry.listSessions({ directory })).some((entry) => entry.conversationId === manifest.id && !retained.has(entry.sessionId));
      return orphan ? 'unknown' : 'not-dispatched';
    },
    async automaticPrompt(source, request, signal, approval = null) {
      await load();
      const owner = owners.get(source);
      if (!owner) {
        assertStandalone(source);
        await approval?.onDispatched?.();
        try { return await native.prompt(source, request, signal); }
        catch (error) { if (definiteRefusal(error)) await approval?.onRefused?.(); throw error; }
      }
      return prompt(owner.id, { ...request, messageID: approval?.logicalMessageId ?? `ncv_u_${randomUUID()}` }, signal, source, request.messageID, approval);
    },
    publishInteraction(source, part) {
      const owner = owners.get(source);
      const manifest = owner && store.peek(owner.id);
      const segment = manifest?.segments.find((entry) => entry.id === owner.segmentId);
      if (!segment) return false;
      emit(manifest, 'message.part.updated', {
        sessionID: manifest.id,
        part: projectConversationPart(manifest.id, { ...segment, timeOffset: segment.timeOffset ?? clocks.get(source) ?? 0 }, part),
      });
      return true;
    },
    publish(event) {
      const { payload } = event;
      const properties = payload.properties;
      const questionId = payload.type === 'question.asked' ? properties.id
        : payload.type === 'question.replied' || payload.type === 'question.rejected' ? properties.requestID : null;
      const questionOwner = questionId ? questionOwners.get(questionId) : null;
      const source = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID ?? properties.info?.id;
      if ((payload.type === 'session.created' || payload.type === 'session.updated') && properties.info?.parentID) {
        const logicalParent = store.peek(properties.info.parentID);
        const root = logicalParent ? activeOf(logicalParent)?.sessionId : sourceRoot(properties.info.parentID);
        if (owned.has(root)) {
          childRoots.set(properties.info.id, root);
          const owner = owners.get(root);
          if (owner && properties.info.parentID === root) properties.info = { ...properties.info, parentID: owner.id };
        }
      }
      if (payload.type === 'session.status') {
        if (properties.status.type === 'idle') foreground.delete(source);
        else foreground.add(source);
      }
      if (payload.type === 'session.idle' || payload.type === 'session.deleted') foreground.delete(source);
      if (payload.type === 'session.background.updated') background.set(source, properties.tasks);
      if (payload.type === 'question.asked') {
        const questions = waiting.get(source) ?? new Set();
        questions.add(properties.id); waiting.set(source, questions);
      }
      if (payload.type === 'question.replied' || payload.type === 'question.rejected') {
        waiting.get(source)?.delete(properties.requestID);
        questionOwners.delete(properties.requestID);
      }
      const owner = owners.get(source);
      if (!owner) {
        if (!owned.has(source)) publishNativeEvent(event);
        const parent = owners.get(childRoots.get(source));
        const manifest = parent && store.peek(parent.id);
        if (manifest && ['session.status', 'session.idle', 'session.background.updated', 'question.asked', 'question.replied', 'question.rejected'].includes(payload.type)) {
          if (!hasLiveWork(manifest)) void reverts.afterTurn(manifest.id);
          publish(manifest);
        }
        return;
      }
      const manifest = store.peek(owner.id);
      const segment = manifest?.segments.find((entry) => entry.id === owner.segmentId);
      if (!manifest || !segment || manifest.active !== segment.id && questionOwner?.id !== manifest.id) return;
      if (payload.type === 'question.asked') questionOwners.set(properties.id, { id: manifest.id, selection: manifest.selection, plan: properties.kind?.endsWith('-plan-exit') === true });
      if (payload.type === 'message.updated' && segment.timeOffset === undefined && !clocks.has(segment.sessionId)) {
        const offset = Math.max(0, segment.createdAt - properties.info.time.created);
        clocks.set(segment.sessionId, offset);
        void update(manifest.id, (current) => {
          const source = current.segments.find((entry) => entry.id === segment.id);
          if (source) source.timeOffset = offset;
          return current;
        }).catch(() => undefined);
      }
      const projection = { ...segment, timeOffset: segment.timeOffset ?? clocks.get(segment.sessionId) ?? 0 };
      if (payload.type === 'session.created' || payload.type === 'session.updated' || payload.type === 'session.deleted') {
        if (payload.type === 'session.updated' && manifest.segments[0]?.id === segment.id && !manifest.manualTitle && !manifest.generatedTitle
          && properties.info.title && properties.info.title !== manifest.title
          && properties.info.title !== 'New Codex session' && properties.info.title !== 'New Claude Code session'
          && properties.info.title !== 'New Antigravity session') {
          void update(manifest.id, (current) => {
            if (!current.manualTitle && !current.generatedTitle) current.title = conversationTitlePreview([{ type: 'text', text: properties.info.title }]) || current.title;
            return current;
          }).then(publish).catch(() => undefined);
        }
        publish(manifest);
        return;
      }
      const projected = { ...properties, sessionID: manifest.id };
      if (payload.type === 'session.checklist.updated' && segment.backend === 'antigravity') {
        if (manifest.cut || segment.through || segment.before) return;
        if (properties.snapshot.state === 'ready') projected.snapshot = { ...properties.snapshot, identity: checklistIdentity(manifest, segment) };
      }
      if (payload.type === 'message.updated') projected.info = projectConversationRecord(manifest.id, projection, { info: properties.info, parts: [] }).info;
      if (payload.type === 'message.part.updated') {
        const part = properties.part;
        projected.part = projectConversationPart(manifest.id, projection, part);
      }
      if (properties.messageID) projected.messageID = conversationMessageId(manifest.id, segment, properties.messageID);
      if (properties.partID) projected.partID = conversationPartId(manifest.id, segment, properties.partID, properties.messageID);
      if (payload.type === 'question.asked' && properties.tool) projected.tool = {
        ...properties.tool, messageID: conversationMessageId(manifest.id, segment, properties.tool.messageID),
      };
      publishNativeEvent({ ...event, payload: { ...payload, properties: projected } });
      if (payload.type === 'session.idle') {
        if (!hasLiveWork(manifest)) void reverts.afterTurn(manifest.id);
        void update(manifest.id, (current) => current).then((current) => { publish(current); void titles.generate(current.id); }).catch(() => undefined);
      } else if (payload.type === 'session.status' || payload.type === 'session.background.updated' || payload.type.startsWith('question.')) {
        if (!hasLiveWork(manifest) && !preparing.has(manifest.id)) void reverts.afterTurn(manifest.id);
        publish(manifest);
      }
    },
  };
};
