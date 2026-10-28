import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError, invalidRequestError, sessionBusyError } from '../errors.js';
import { nativeBackendOfProviderId, newNativeClientUserMessageId, isUnifiedNativeSessionId as isConversationId } from '../ids.js';
import { JsonRpcError } from '../codex/rpc.js';
import { createConversationStore, conversationSelectionSchema } from './store.js';
import { conversationMessageId, conversationPartId, projectConversationRecord, projectConversationPart, readConversationHistory, readConversationSegment, readConversationPage, conversationPrefix } from './history.js';
import { prepareConversationContext } from './context.js';

const namespaceSchema = z.record(z.string(), z.json()).catch({});
const selectionOf = (request) => conversationSelectionSchema.parse({ model: request.model, agent: request.agent, variant: request.variant });
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

/** The conversation owns logical history; the native runtime owns every CLI operation. */
export const createNativeConversations = ({ dataDir, native, registry, reverts, publishNativeEvent, stopSource, retireSource, smallModels, managedChatsRoots, now = Date.now }) => {
  const store = createConversationStore({ directory: path.join(dataDir, 'native-agents', 'conversations'), now });
  const owned = new Set();
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
      for (const entry of await registry.listSessions()) if (entry.conversationId) owned.add(entry.sessionId);
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
  const hasLiveWork = (manifest) => {
    const active = activeOf(manifest);
    if (!active) return false;
    if (foreground.has(active.sessionId) || (background.get(active.sessionId)?.length ?? 0) > 0) return true;
    for (const child of foreground) if (sourceRoot(child) === active.sessionId) return true;
    return false;
  };
  const blocked = (manifest) => hasLiveWork(manifest) || (waiting.get(activeOf(manifest)?.sessionId)?.size ?? 0) > 0;
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
        kind: 'unified', backend, revision: manifest.selectionRevision, recordRevision: manifest.revision, historyRevision: manifest.historyRevision,
        sourceSessionID: active?.sessionId ?? null,
        switchReady: !blocked(manifest) && !preparing.has(manifest.id) && !manifest.admission && !manifest.deletion,
        preparing: handoffs.has(manifest.id),
        actions: { revert: !manifest.deletion, delete: true, fork: !manifest.deletion },
      } } },
    };
    if (manifest.parentID) record.parentID = manifest.parentID;
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
      if (statuses[id] && statuses[id].type !== 'idle') foreground.add(id);
      else foreground.delete(id);
    }
  };
  const assertQuiet = async (manifest) => {
    await refreshActivity(manifest);
    if (blocked(manifest)) throw sessionBusyError();
  };
  const historyOf = async (manifest) => {
    const history = await readConversationHistory(native, manifest);
    if (get(manifest.id).historyRevision !== manifest.historyRevision) throw new NativeAgentError('Conversation history changed. Reload and retry.', {
      status: 409, code: 'NATIVE_HISTORY_CHANGED',
    });
    return history;
  };
  const stop = async (manifest) => {
    preparing.get(manifest.id)?.abort(new Error('Conversation preparation stopped'));
    const active = activeOf(manifest);
    if (!active) return false;
    try { await stopSource(active.sessionId); }
    catch (error) {
      if (error instanceof NativeAgentError && error.status === 404) return false;
      throw error;
    }
    for (const [child, root] of childRoots) if (root === active.sessionId && foreground.has(child)) await native.abort(child);
    await refreshActivity(manifest);
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

  const prompt = (id, request, signal, automaticSource = null, automaticMessageId = null) => locked(id, async () => {
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
    const switching = !old || old.backend !== backend || manifest.cut !== undefined || old.ownerId !== id || old.through !== undefined;
    if (switching) await assertQuiet(manifest);
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
    let nativeMessageId = automaticMessageId;
    let dispatched = false;
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
        if (old) await retireSource(old.sessionId);
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
          beforePublish: async (source) => {
            owned.add(source.id);
            await registry.updateSession(source.id, { conversationId: id });
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
        if (!current.manualTitle && current.segments.length === 1 && current.segments[0].sends.length <= 1) {
          const preview = request.parts.find((part) => part.type === 'text' && part.text.trim())?.text.trim().split('\n')[0].slice(0, 100);
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
      await update(id, (current) => { current.admission.phase = 'dispatched'; return current; });
      controller.signal.throwIfAborted();
      dispatched = true;
      await native.prompt(segment.sessionId, {
        ...request, directory: manifest.directory, messageID: nativeMessageId,
        instructions: [request.instructions, instructions].filter(Boolean).join('\n\n') || undefined,
      }, controller.signal);
      await update(id, (current) => {
        current.segments.find((entry) => entry.id === segment.id).sends.find((entry) => entry.messageId === request.messageID).state = 'accepted';
        delete current.admission;
        return current;
      });
      if (reverting) await reverts.finishCommit(id);
    } catch (error) {
      const definitelyRefused = !dispatched || error instanceof JsonRpcError || (error instanceof NativeAgentError && !error.code.endsWith('_UNKNOWN'));
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
          try { await native.deleteSession(segment.sessionId, manifest.directory); }
          catch { /* The registry retains ownership for cleanup when the conversation is deleted. */ }
        }
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
      return { ...await native.capabilities(), unifiedSessions: !isEnterpriseMode() };
    },
    async createSession(input) {
      await load();
      if (input.kind !== 'unified') return native.createSession(input);
      checkPolicy();
      if (stopping) throw sessionBusyError();
      const selection = conversationSelectionSchema.parse(input.selection);
      if (nativeBackendOfProviderId(selection.model.providerID) !== input.backend) throw invalidRequestError('The initial model does not match its native backend');
      return publish(await store.create({ directory: directoryKey(input.directory), selection, manualTitle: Boolean(input.title), ...(input.title ? { title: input.title } : {}) }), true);
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
    async replyQuestion(requestId, answers) {
      await load();
      const decision = questionOwners.get(requestId);
      const approves = answers.length === 1 && answers[0].length === 1 && answers[0][0] === 'build';
      if (decision && !(decision.plan && answers.length === 1 && answers[0].length === 1 && answers[0][0] === 'plan')) checkPolicy();
      await native.replyQuestion(requestId, answers);
      if (decision?.plan && approves && store.peek(decision.id)) {
        const expected = JSON.stringify(decision.selection);
        publish(await update(decision.id, (current) => {
          if (JSON.stringify(current.selection) === expected && current.selection.agent !== 'build') {
            current.selection = { ...current.selection, agent: 'build' };
            current.selectionRevision += 1;
          }
          return current;
        }));
      }
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
          segments: conversationPrefix(manifest, history, messageId), metadata: {}, manualTitle: true,
        });
        index(child);
        return publish(child, true);
      });
    },
    async deleteSession(id, directory) {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.deleteSession(id, directory); }
      preparing.get(id)?.abort(new Error('Conversation deleted'));
      return locked(id, async () => {
        let manifest = get(id, directory);
        await stop(manifest);
        await retryUnavailable();
        if (store.unavailable().length > 0) throw new NativeAgentError('Unreadable conversation records prevent safe shared-history cleanup. Restore those records and retry.', {
          status: 409, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
        });
        const sources = new Set(referencedSegments(manifest).map((segment) => segment.sessionId));
        for (const entry of await registry.listSessions()) if (entry.conversationId === id) sources.add(entry.sessionId);
        const retained = new Set(store.list().filter((entry) => entry.id !== id).flatMap((entry) => referencedSegments(entry).map((segment) => segment.sessionId)));
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
      await Promise.allSettled([closing, ...operations.values()]);
      await store.drain();
    },
  };

  const sourceRead = (method, empty) => async (id, directory, ...args) => {
    if (!isConversationId(id)) return native[method](id, directory, ...args);
    const { segment } = await sourceFor(id, directory);
    if (!segment) return empty;
    return native[method](segment.sessionId, directory, ...args);
  };
  api.checklist = sourceRead('checklist', { state: 'unavailable', reason: 'unsupported' });
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
    async automaticPrompt(source, request, signal) {
      await load();
      const owner = owners.get(source);
      if (!owner) return native.prompt(source, request, signal);
      return prompt(owner.id, { ...request, messageID: `ncv_u_${randomUUID()}` }, signal, source, request.messageID);
    },
    publish(event) {
      const { payload } = event;
      const properties = payload.properties;
      const source = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID ?? properties.info?.id;
      if ((payload.type === 'session.created' || payload.type === 'session.updated') && properties.info?.parentID) {
        const root = sourceRoot(properties.info.parentID);
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
        return;
      }
      const manifest = store.peek(owner.id);
      const segment = manifest?.segments.find((entry) => entry.id === owner.segmentId);
      if (!manifest || !segment || manifest.active !== segment.id) return;
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
        if (payload.type === 'session.updated' && manifest.segments[0]?.id === segment.id && !manifest.manualTitle
          && properties.info.title && properties.info.title !== manifest.title
          && properties.info.title !== 'New Codex session' && properties.info.title !== 'New Claude Code session') {
          void update(manifest.id, (current) => {
            if (!current.manualTitle) current.title = properties.info.title;
            return current;
          }).then(publish).catch(() => undefined);
        }
        publish(manifest);
        return;
      }
      const projected = { ...properties, sessionID: manifest.id };
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
        void update(manifest.id, (current) => current).then(publish).catch(() => undefined);
      } else if (payload.type === 'session.status' || payload.type === 'session.background.updated' || payload.type.startsWith('question.')) {
        if (!hasLiveWork(manifest) && !preparing.has(manifest.id)) void reverts.afterTurn(manifest.id);
        publish(manifest);
      }
    },
  };
};
