import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { NativeAgentError, invalidRequestError, sessionNotFoundError } from '../errors.js';
import { encodeDeepseekSessionId, isNativeClientUserMessageId } from '../ids.js';
import { withInstructions } from '../prompt-parts.js';
import { buildSessionRecord, unknownError } from '../records.js';
import { createDeepseekProjection } from './projector.js';
import * as wire from './protocol.js';
import { createDeepseekTransport } from './transport.js';
import { createDeepseekConfiguration } from './configuration.js';
import { appendDeepseekBranch, initialDeepseekHistory, deepseekIdentityScope, deepseekHistoryCursor, deepseekCursorPosition } from './history.js';

const controlFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), value: z.object({ projections: z.record(z.string(), z.object({ asOfSeq: z.number(), values: wire.jsonObject })) }) }),
  z.object({ type: z.literal('projection'), sessionId: z.string(), key: z.string(), value: z.json(), seq: z.number() }),
]);
const titleProjection = z.string();
const planProjection = z.object({ active: z.boolean(), pending: z.boolean() });
const modelProjection = z.object({ next: wire.selection.nullable(), lastUsed: wire.selection.nullable() });
const timedQuestions = z.object({ active: wire.pendingQuestions });
const MAX_FOLLOWERS = 12;
const sameDirectory = (left, right) => {
  const canonical = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  return canonical(left) === canonical(right);
};
const deepseekUnsupported = () => new NativeAgentError('DeepSeek Harness does not support this session action', {
  status: 501, code: 'NATIVE_DEEPSEEK_ACTION_UNSUPPORTED',
});

export const createDeepseekBackend = ({
  resolveExecutable, buildEnv, registry, publisher, questions, readGlobalInstructions, now = Date.now,
  resolveNodeExecutable, reverts = null, memory = null, maintenance = null,
  decorateSession = async (session) => session,
  createTransport = createDeepseekTransport,
}) => {
  const summaries = new Map();
  const histories = new Map();
  let bindingRevision = 0;
  const deletionIntents = new Map();
  let stopping = false;
  const mutations = new Map();
  const markMutation = (id) => mutations.set(id, (mutations.get(id) ?? 0) + 1);
  const owners = new Map();
  const turnWork = new Map();
  const managedTurns = new Map();
  const progressSuppressed = new Set();
  const turnIdentity = z.object({ turn: z.number().int().nonnegative() });
  const deferredAdded = new Map();
  let internalForks = 0;
  let maintaining = false;
  let bindings = null;
  const bind = (id, history) => {
    const previous = histories.get(id);
    if (!previous || previous.active !== history.active || previous.revision !== history.revision) bindingRevision += 1;
    histories.set(id, history);
    for (const branch of history.branches) owners.set(branch.nativeId, id);
  };
  const loadBindings = () => bindings ??= registry.listSessions({ backend: 'deepseek' }).then((entries) => {
    for (const entry of entries) {
      bind(entry.sessionId, entry.deepseekHistory ?? initialDeepseekHistory(entry.sessionId, entry.nativeId));
      if (entry.deepseekDeletion) deletionIntents.set(entry.sessionId, entry);
    }
  }).catch((error) => { bindings = null; throw error; });
  const logicalId = (nativeId) => owners.get(nativeId) ?? encodeDeepseekSessionId(nativeId);
  const visible = (nativeId) => !owners.has(nativeId) || histories.get(owners.get(nativeId)).active === nativeId;
  const saveHistory = async (id, history) => {
    markMutation(id);
    await registry.setDeepseekHistory(id, history);
    bind(id, history);
  };
  const projectionFor = (id, source, publish = false) => {
    const branch = histories.get(id)?.branches.find((branch) => branch.nativeId === source.nativeId);
    return createDeepseekProjection({ sessionId: id, directory: source.directory, publisher: publish ? publisher : null,
      identityScope: branch ? (seq) => deepseekIdentityScope(branch, seq) : () => id });
  };
  // A DSH event this build cannot read must not make the session unreadable and
  // unsendable. Skip that event, keep every other one, and report it once per
  // session so a partial transcript is never mistaken for a complete one.
  const unreadableEvents = new Set();
  const applyProjected = (id, directory, projection, event, options) => {
    try {
      projection.apply(event, options);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      if (unreadableEvents.has(id)) return;
      unreadableEvents.add(id);
      const issue = error.issues?.[0];
      console.warn(`[deepseek] skipped an unreadable ${event.type} event in ${id}${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}`);
      publisher.error(directory, id, unknownError('DeepSeek Harness sent a session event this version cannot read; part of the transcript may be missing'));
    }
  };
  const writable = () => {
    transport.assertAllowed();
    if (stopping) throw new NativeAgentError('DeepSeek Harness is shutting down', { status: 503, code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
    if (maintaining) throw new NativeAgentError('DeepSeek Harness maintenance is in progress. Retry shortly.', { status: 409, code: 'NATIVE_DEEPSEEK_MAINTENANCE_BUSY' });
  };
  const followers = new Map();
  const pending = new Map();
  const operations = new Map();
  const configured = new Set();
  const announcedRunning = new Set();
  const liveProjections = new Map();
  const summaryRevisions = new Map();
  let summaryRevision = 0;
  let archived = new Set();
  let globals = null;
  let listing = null;
  let generation = 0;

  const recordOf = (summary, entry) => {
    const id = logicalId(summary.sessionId);
    const title = titleProjection.safeParse(summary.projections?.values.title).data;
    const record = buildSessionRecord({ id, backend: 'deepseek', directory: summary.cwd ?? entry?.directory,
      title: title ?? entry?.title ?? 'DeepSeek Harness', created: entry?.createdAt ?? followers.get(id)?.createdAt ?? summary.updatedAt,
      updated: summary.updatedAt, archived: archived.has(summary.sessionId) ? summary.updatedAt : null });
    if (summary.projections?.kind === 'sequenced') {
      const plan = planProjection.safeParse(summary.projections.values.plan).data;
      const model = modelProjection.safeParse(summary.projections.values.modelSelection).data;
      if (plan) record.agent = (plan.pending ? !plan.active : plan.active) ? 'plan' : 'build';
      const selected = model?.next ?? model?.lastUsed;
      if (selected) {
        record.model = { providerID: 'deepseek-native', id: wire.modelId(selected.provider, selected.model) };
        if (selected.reasoningEffort) record.model.variant = selected.reasoningEffort;
      }
    }
    record.metadata.openchamber.native.historyRevision = histories.get(id)?.revision ?? 0;
    record.metadata.openchamber.native.actions = { revert: reverts !== null, delete: Boolean(maintenance && transport.supportsMaintenance?.()) };
    return record;
  };

  const observeActivity = (summary) => {
    if (!summary.cwd || summary.origin === 'subagent') return;
    const id = logicalId(summary.sessionId);
    if (summary.running) {
      if (!announcedRunning.has(id)) publisher.status(summary.cwd, id, 'busy');
      announcedRunning.add(id);
      if (!followers.has(id)) void follow(id, summary.cwd).then((state) => state.projection.publishAll()).catch(() => {
        publisher.error(summary.cwd, id, unknownError('Could not follow the running DeepSeek Harness session'));
      });
    } else if (announcedRunning.delete(id)) publisher.status(summary.cwd, id, 'idle');
  };

  const updateSummary = (summary) => {
    if (!visible(summary.sessionId)) return;
    const id = logicalId(summary.sessionId);
    const previous = summaries.get(id);
    summaries.set(id, summary);
    summaryRevision += 1;
    summaryRevisions.set(id, summaryRevision);
    if (summary.cwd && summary.origin !== 'subagent') {
      const revision = summaryRevision;
      const mutation = mutations.get(id);
      void (async () => {
        const record = await decorateSession(recordOf(summary, await registry.getSession(id)));
        if (summaryRevisions.get(id) !== revision || mutations.get(id) !== mutation || !visible(summary.sessionId)) return;
        publisher.session(summary.cwd, record, { created: !previous });
      })().catch(() => publisher.error(summary.cwd, id, unknownError('Could not refresh DeepSeek Harness session metadata')));
      observeActivity(summary);
    }
  };

  const answerBatch = (items, answers) => ({ answers: items.map((item, index) => {
    const values = answers[index] ?? [];
    const labels = new Set(item.options?.map((option) => option.label) ?? []);
    const selected = values.filter((value) => labels.has(value));
    const custom = values.filter((value) => !labels.has(value)).join('\n');
    const answer = { id: item.id, selected };
    if (custom) answer.custom = custom;
    return answer;
  }) });

  const ask = (nativeId, items, { eventId, callId } = {}) => {
    if (!visible(nativeId)) return false;
    const id = logicalId(nativeId);
    const summary = summaries.get(id);
    if (!summary?.cwd || summary.origin === 'subagent') return false;
    const identity = eventId ?? `${nativeId}:${callId}`;
    if (pending.has(identity)) return true;
    const controller = new AbortController();
    const plan = items.some((item) => item.intent?.kind === 'plan-review');
    // The plan's approve label is explicit in DSH; its position has no meaning.
    const presented = items.map((item) => ({
      question: [item.question, item.detail].filter(Boolean).join('\n\n'), header: item.header ?? item.question,
      options: (item.options ?? []).map((option) => ({
        label: item.intent?.approve === option.label ? 'build' : option.label,
        description: option.description ?? '',
      })), multiple: item.multiSelect ?? false,
    }));
    pending.set(identity, { controller, nativeId, plan });
    const input = { directory: summary.cwd, sessionID: id, questions: presented, signal: controller.signal };
    if (plan) input.kind = 'deepseek-plan-exit';
    input.onReply = async (outcome) => {
      if (controller.signal.aborted) return;
      let accepted;
      if (outcome.status === 'replied') {
        await applyPermissions(id, nativeId);
        const answers = outcome.answers.map((values, index) => values.map((value) => value === 'build' && items[index].intent ? items[index].intent.approve : value));
        const value = answerBatch(items, answers);
        if (eventId) accepted = await transport.answer(eventId, { kind: 'result', value }, controller.signal);
        else accepted = await transport.request('userQuestions/answer', { agentId: nativeId, callId, answer: value }, z.boolean(), controller.signal);
      } else if (eventId) accepted = await transport.answer(eventId, { kind: 'next' }, controller.signal);
      if (accepted === false) {
        controller.abort();
        throw new NativeAgentError('The DeepSeek Harness question is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
      }
    };
    void questions.ask(input).catch(() => {
      publisher.error(summary.cwd, id, unknownError('Could not deliver the answer to DeepSeek Harness'));
    }).finally(() => { if (pending.get(identity)?.controller === controller) pending.delete(identity); });
    return true;
  };

  const applyProjection = (nativeId, name, value, seq) => {
    if (!visible(nativeId)) return;
    const id = logicalId(nativeId);
    const summary = summaries.get(id);
    let held = liveProjections.get(nativeId);
    if (!held) { held = new Map(); liveProjections.set(nativeId, held); }
    if ((held.get(name)?.seq ?? -1) > seq) return;
    held.set(name, { seq, value });
    if (name === 'userQuestions') {
      const active = timedQuestions.parse(value).active;
      for (const question of active) ask(nativeId, question.questions, { callId: question.callId });
      const retained = new Set(active.map((item) => `${nativeId}:${item.callId}`));
      for (const [identity, entry] of pending) if (entry.nativeId === nativeId && identity.startsWith(`${nativeId}:`) && !retained.has(identity)) {
        entry.controller.abort();
        pending.delete(identity);
      }
    }
    if (summary) {
      const previous = summary.projections;
      const next = { ...summary, projections: {
        kind: 'sequenced', asOfSeq: Math.max(previous?.asOfSeq ?? -1, seq), values: { ...previous?.values, [name]: value },
      } };
      if (['title', 'plan', 'modelSelection'].includes(name)) updateSummary(next);
      else { summaries.set(id, next); summaryRevision += 1; summaryRevisions.set(id, summaryRevision); }
    }
  };

  const transport = createTransport({ resolveExecutable, resolveNodeExecutable, buildEnv, maintenance,
    onEvent: (event) => {
      if (event.type === 'cancel') {
        pending.get(event.eventId)?.controller.abort();
        pending.delete(event.eventId);
      } else if (event.type === 'waterfall') {
        if (event.event === 'approval/request') {
          void transport.answer(event.eventId, { kind: 'result', value: 'allowed-once' }).catch(() => {});
        } else if (event.event === 'user-questions/request') {
          const request = wire.questionRequest.parse(event.request);
          if (!ask(event.agentId, request.questions, { eventId: event.eventId, callId: request.callId })) {
            void transport.answer(event.eventId, { kind: 'next' }).catch(() => {});
          }
        } else void transport.answer(event.eventId, { kind: 'next' }).catch(() => {});
      } else if (event.type === 'emit') {
        if (event.event === 'api-session/added') {
          const summary = wire.sessionSummary.parse(event.args[0]);
          if (internalForks) deferredAdded.set(summary.sessionId, summary);
          else updateSummary(summary);
        }
        if (event.event === 'api-session/status') {
          const [nativeId, running] = z.tuple([z.string(), z.boolean()]).parse(event.args);
          const summary = summaries.get(logicalId(nativeId));
          if (summary) updateSummary({ ...summary, running });
        }
        if (event.event === 'api-session/activity') {
          const [nativeId, updatedAt] = z.tuple([z.string(), z.number()]).parse(event.args);
          const summary = summaries.get(logicalId(nativeId));
          if (summary) updateSummary({ ...summary, updatedAt });
        }
        if (event.event === 'api-session/error') {
          const [nativeId, message] = z.tuple([z.string(), z.string()]).parse(event.args);
          const summary = summaries.get(logicalId(nativeId));
          if (summary?.cwd) publisher.error(summary.cwd, logicalId(nativeId), unknownError(message));
        }
      }
    },
    onDisconnect: () => {
      generation += 1;
      globals = null;
      listing = null;
      configured.clear();
      announcedRunning.clear();
      liveProjections.clear();
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
      for (const [id, state] of followers) {
        state.projection.interrupt(now());
        for (const turn of state.ownedTurns) queueTurnCheckpoint(state, id, turn, true);
        state.ownedTurns.clear();
      }
      followers.clear();
      managedTurns.clear();
      for (const [id, summary] of summaries) if (summary.running && summary.cwd) {
        summaries.set(id, { ...summary, running: false });
        publisher.error(summary.cwd, id, unknownError('DeepSeek Harness disconnected'));
        publisher.status(summary.cwd, id, 'idle');
      }
    },
  });

  const ensureGlobals = async () => {
    await loadBindings();
    if (globals) return globals;
    const handles = [];
    const current = (async () => {
      const workspace = await transport.open('workspace/follow', {}, (raw) => {
        const frame = wire.workspaceFrame.parse(raw);
        if (frame.type === 'baseline') archived = new Set(frame.value.archivedSessionIds);
        if (frame.type === 'archived') {
          archived = new Set(frame.archivedSessionIds);
          for (const summary of summaries.values()) if (summary.cwd && summary.origin !== 'subagent') publisher.session(summary.cwd, recordOf(summary), { created: false });
        }
      });
      handles.push(workspace);
      const control = await transport.open('session/control', {}, (raw) => {
        const frame = controlFrame.parse(raw);
        if (frame.type === 'baseline') {
          for (const [nativeId, projection] of Object.entries(frame.value.projections)) for (const [name, value] of Object.entries(projection.values)) applyProjection(nativeId, name, value, projection.asOfSeq);
        } else applyProjection(frame.sessionId, frame.key, frame.value, frame.seq);
      });
      handles.push(control);
      const closed = () => {
        if (globals !== current) return;
        globals = null;
        for (const handle of handles) handle.cancel();
      };
      for (const handle of handles) handle.done.then(closed, closed);
      await Promise.all([workspace.first, control.first]);
    })();
    globals = current;
    current.catch(() => {
      if (globals === current) globals = null;
      for (const handle of handles) handle.cancel();
    });
    return current;
  };

  const retireSession = (id, entry) => {
    bindingRevision += 1;
    markMutation(id);
    for (const branch of histories.get(id)?.branches ?? [{ nativeId: entry.nativeId }]) { owners.delete(branch.nativeId); liveProjections.delete(branch.nativeId); }
    histories.delete(id);
    summaries.delete(id);
    managedTurns.delete(id);
    progressSuppressed.delete(id);
  };
  const recoverLogicalDeletions = async (list) => {
    if (!deletionIntents.size) return;
    let config;
    try { config = await transport.inspectMaintenance(); }
    catch (error) { if (error.code === 'NATIVE_DEEPSEEK_ACTION_UNSUPPORTED') return; throw error; }
    const present = new Set(list.items.map((item) => item.sessionId));
    for (const [id, entry] of deletionIntents) {
      if (!sameDirectory(entry.deepseekDeletion.root, config.root)) continue;
      const ids = (entry.deepseekHistory?.branches ?? [{ nativeId: entry.nativeId }]).map((branch) => branch.nativeId);
      try {
        if (ids.every((nativeId) => !present.has(nativeId))) {
          await memory?.forget(id, entry.directory);
          await registry.removeSession(id);
          deletionIntents.delete(id);
          retireSession(id, entry);
          publisher.sessionDeleted(entry.directory, buildSessionRecord({ id, backend: 'deepseek', directory: entry.directory, title: entry.title ?? 'DeepSeek Harness', created: entry.createdAt, updated: now() }));
        } else if (ids.every((nativeId) => present.has(nativeId))) {
          await registry.setDeepseekDeletion(id, null);
          deletionIntents.delete(id);
        }
      } catch {
        publisher.error(entry.directory, id, unknownError('The deleted session still has integration metadata awaiting cleanup.'));
      }
    }
  };

  const listAll = () => {
    if (listing) return listing;
    const revision = generation;
    const current = (async () => {
      await ensureGlobals();
      const startedAtRevision = summaryRevision;
      let observedBinding = bindingRevision;
      let list = await transport.request('session/list', { _request: {} }, wire.sessionList);
      if (observedBinding !== bindingRevision) {
        observedBinding = bindingRevision;
        list = await transport.request('session/list', { _request: {} }, wire.sessionList);
        if (observedBinding !== bindingRevision) throw new NativeAgentError('Session history changed during listing. Reload and retry.', { status: 409, code: 'NATIVE_HISTORY_CHANGED' });
      }
      await recoverLogicalDeletions(list);
      if (revision !== generation) throw new Error('DeepSeek Harness restarted during listing');
      const next = new Map(list.items.filter((summary) => visible(summary.sessionId)).map((summary) => [logicalId(summary.sessionId), summary]));
      for (const [id, summary] of summaries) if ((summaryRevisions.get(id) ?? -1) > startedAtRevision) next.set(id, summary);
      summaries.clear();
      for (const [id, summary] of next) summaries.set(id, summary);
      for (const [nativeId, held] of liveProjections) for (const [name, projection] of held) applyProjection(nativeId, name, projection.value, projection.seq);
      for (const summary of summaries.values()) observeActivity(summary);
      return Array.from(summaries.values());
    })();
    listing = current;
    current.finally(() => { if (listing === current) listing = null; }).catch(() => {});
    return current;
  };

  const resolve = async (id, directory) => {
    await ensureGlobals();
    if (!summaries.has(id)) await listAll();
    const summary = summaries.get(id);
    if (summary?.origin === 'subagent') throw deepseekUnsupported();
    const entry = await registry.getSession(id);
    const nativeId = histories.get(id)?.active ?? summary?.sessionId ?? entry?.nativeId;
    const cwd = summary?.cwd ?? entry?.directory;
    if (!summary || !nativeId || !cwd) throw sessionNotFoundError(id);
    if (directory && !sameDirectory(directory, cwd)) throw invalidRequestError('DeepSeek Harness session belongs to another directory');
    return { nativeId, directory: cwd, summary, entry };
  };

  const serial = (id, operation) => {
    writable();
    const run = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(() => { writable(); return operation(); });
    operations.set(id, run);
    run.finally(() => { if (operations.get(id) === run) operations.delete(id); }).catch(() => {});
    return run;
  };

  const command = async (nativeId, line) => {
    const result = await transport.request('commands/execute', { agentId: nativeId, line, submittedAttachments: [] }, wire.commandExecution.optional());
    if (!result) throw invalidRequestError('Unknown DeepSeek Harness command');
    if (result.result.kind === 'error') throw invalidRequestError(result.result.text);
    return result.result.text;
  };

  const applyPermissions = async (id, nativeId) => {
    if (configured.has(id)) return;
    await command(nativeId, '/permission danger-full-access');
    configured.add(id);
  };

  const follow = async (id, directory) => {
    const existing = followers.get(id);
    if (existing) {
      if (existing.events.length <= 1000 || summaries.get(id)?.running || existing.attemptId || existing.ownedTurns.size || managedTurns.get(id)?.size) { await existing.ready; return existing; }
      existing.handle?.cancel();
      followers.delete(id);
      publisher.forget(id);
    }
    const source = await resolve(id, directory);
    const concurrent = followers.get(id);
    if (concurrent) { await concurrent.ready; return concurrent; }
    // Bound only idle observations; another session's active turn is never evicted.
    if (followers.size >= MAX_FOLLOWERS) {
      const idle = Array.from(followers).find(([sessionId, state]) => !summaries.get(sessionId)?.running && !state.attemptId && !state.ownedTurns.size && !managedTurns.get(sessionId)?.size);
      if (idle) { idle[1].handle?.cancel(); followers.delete(idle[0]); publisher.forget(idle[0]); }
    }
    const state = { ...source, events: [], staged: [], projection: projectionFor(id, source, true), cursor: -1, hasMore: false, attemptId: null, nextIndex: 0, currentTurn: null, ownedTurns: new Set() };
    followers.set(id, state);
    state.ready = (async () => {
      const handle = await transport.open('session/follow', { request: {
        address: { kind: 'session', sessionId: source.nativeId }, assistantStream: true, maxMessages: 100,
        turnWindow: { minMessages: 50, minTurns: 2 },
      } }, (raw) => {
        const frame = wire.followFrame.parse(raw);
        if (frame.type === 'snapshot') {
          if (frame.header.id !== source.nativeId) throw new Error('DeepSeek Harness returned another session');
          state.events = frame.records.map((record) => record.event);
          state.createdAt = frame.header.createdAt;
          state.cursor = frame.cursor;
          state.hasMore = frame.hasMore;
          const activeAttempt = frame.assistantStream?.activeAttempt;
          for (const event of state.events) {
            const turn = turnIdentity.safeParse(event.data).data?.turn;
            if (turn !== undefined) state.currentTurn = turn;
            if (event.type === 'user/message' && managedTurns.get(id)?.has(event.data.source?.rpcId) && state.currentTurn !== null) state.ownedTurns.add(state.currentTurn);
            if (event.type === 'turn/end') state.ownedTurns.delete(turn);
            if (activeAttempt && event.seq > activeAttempt.startedAfterSeq && ['assistant/message', 'assistant/attempt'].includes(event.type)) state.staged.push(event);
            else if (state.staged.length > 0) state.staged.push(event);
            else applyProjected(id, source.directory, state.projection, event);
          }
          state.projection.restoreStream(frame.assistantStream);
          state.attemptId = frame.assistantStream?.activeAttempt?.attemptId ?? null;
          state.nextIndex = frame.assistantStream?.activeAttempt?.nextIndex ?? 0;
          for (const [name, value] of Object.entries(frame.projections.values)) applyProjection(source.nativeId, name, value, frame.projections.asOfSeq);
        } else if (frame.type === 'event') {
          if (frame.event.seq <= state.cursor) return;
          if (frame.event.seq !== state.cursor + 1) throw new Error('DeepSeek Harness history has a sequence gap');
          state.cursor = frame.event.seq;
          state.events.push(frame.event);
          if (state.staged.length > 0 || state.attemptId && ['assistant/message', 'assistant/attempt'].includes(frame.event.type)) state.staged.push(frame.event);
          else applyLive(state, id, frame.event);
        } else {
          const item = frame.frame;
          if (item.type === 'start') {
            state.attemptId = item.attemptId;
            state.nextIndex = 0;
            state.projection.begin(item);
          } else if (item.attemptId === state.attemptId) {
            if (item.index < state.nextIndex) return;
            if (item.index !== state.nextIndex) throw new Error('DeepSeek Harness output has a sequence gap');
            if (item.type === 'chunk') { state.nextIndex += 1; state.projection.chunk(item.chunk, item.time); }
            else {
              state.attemptId = null;
              for (const event of state.staged) applyLive(state, id, event);
              state.staged = [];
            }
          }
        }
      });
      state.handle = handle;
      handle.done.catch(() => { if (followers.get(id) === state) followers.delete(id); });
      await handle.first;
    })();
    try { await state.ready; return state; }
    catch (error) { if (followers.get(id) === state) followers.delete(id); throw error; }
  };

  const forgetFollower = (id) => {
    followers.get(id)?.handle?.cancel();
    followers.delete(id);
    publisher.forget(id);
    configured.delete(id);
  };

  const applyLive = (state, id, event) => {
    applyProjected(id, state.directory, state.projection, event, { live: true });
    const turn = turnIdentity.safeParse(event.data).data?.turn;
    if (turn !== undefined) state.currentTurn = turn;
    if (event.type === 'user/message' && managedTurns.get(id)?.has(event.data.source?.rpcId) && state.currentTurn !== null) {
      state.ownedTurns.add(state.currentTurn);
      managedTurns.get(id).delete(event.data.source.rpcId);
      if (!managedTurns.get(id).size) managedTurns.delete(id);
    }
    if (event.type !== 'turn/end' || !state.ownedTurns.delete(turn) || !visible(state.nativeId)) return;
    queueTurnCheckpoint(state, id, turn, ['aborted', 'interrupted', 'error'].includes(event.data.reason?.kind));
  };

  const queueTurnCheckpoint = (state, id, turn, interrupted) => {
    const records = state.projection.records();
    const lastUser = records.findLastIndex((record) => record.info.role === 'user');
    const last = records.slice(lastUser + 1).reverse().find((record) => record.info.role === 'assistant');
    const summary = last?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n').slice(0, 12000) ?? '';
    const work = (turnWork.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (progressSuppressed.has(id)) return;
      await reverts?.afterTurn(id);
      if (memory) {
        if (!await memory.enabled()) { memory.release(id); return; }
        await memory.checkpoint({ backend: 'deepseek', sessionId: id, directory: state.directory,
          delivery: 'managed', turnId: `${histories.get(id)?.revision ?? 0}:${turn}`, summary,
          status: last?.info.error || interrupted ? 'interrupted' : 'completed', observedAt: now() });
      }
    }).catch(() => { memory?.release(id); });
    turnWork.set(id, work);
    work.finally(() => { if (turnWork.get(id) === work) turnWork.delete(id); }).catch(() => {});
  };

  const stopAndWait = async (id, directory) => {
    const source = await resolve(id, directory);
    // cancel addresses a live Agent, not a cold persisted Session. Native
    // adoption also claims its writer before any file restoration begins.
    if (!source.summary.agentAvailable) {
      const adopted = await transport.request('session/create', { request: { sessionId: source.nativeId, cwd: source.directory } }, wire.sessionCreated);
      if (adopted.sessionId !== source.nativeId) throw new NativeAgentError('DeepSeek Harness returned another session during adoption', { status: 502, code: 'NATIVE_DEEPSEEK_PROTOCOL' });
    }
    await transport.request('session/cancel', { request: { sessionId: source.nativeId } }, wire.accepted);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const list = await transport.request('session/list', { _request: {} }, wire.sessionList);
      const current = list.items.find((item) => item.sessionId === source.nativeId);
      if (!current) throw sessionNotFoundError(id);
      updateSummary(current);
      if (!current.running && !followers.get(id)?.attemptId) break;
      if (Date.now() >= deadline) throw new NativeAgentError('Wait for DeepSeek Harness to stop before retrying.', { status: 409, code: 'NATIVE_SESSION_BUSY' });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await turnWork.get(id);
    await reverts?.afterTurn(id);
    memory?.release(id);
  };

  const rewindTarget = async (id, messageId, directory) => {
    const state = await follow(id, directory);
    let events = state.events;
    let hasMore = state.hasMore;
    const found = [];
    for (;;) {
      const projection = projectionFor(id, state);
      for (const event of events) applyProjected(id, directory, projection, event);
      for (const record of projection.records()) {
        const seq = projection.position(record.info.id);
        if (seq !== undefined) found.push({ record, seq });
      }
      const target = found.find((item) => item.record.info.id === messageId && item.record.info.role === 'user');
      if (target) return { seq: target.seq,
        messageIds: found.filter((item) => item.seq >= target.seq && item.record.info.role === 'user').map((item) => item.record.info.id) };
      const beforeSeq = events[0]?.seq;
      if (!hasMore || beforeSeq === undefined) throw invalidRequestError('Unknown DeepSeek Harness revert message');
      const page = await transport.request('session/page', { request: {
        address: { kind: 'session', sessionId: state.nativeId }, throughSeq: state.cursor, beforeSeq,
        maxMessages: 500, turnWindow: { minMessages: 100, minTurns: 2 },
      } }, wire.historyPage);
      if (page.records[0]?.event.seq === undefined || page.records[0].event.seq >= beforeSeq) throw invalidRequestError('DeepSeek Harness history paging made no progress');
      events = page.records.map((item) => item.event);
      hasMore = page.hasMore;
    }
  };

  const commitRevert = async (id, directory, messageId) => {
    const pending = await reverts?.pending(id);
    if (!pending?.deepseek) return null;
    let history = histories.get(id);
    if (history.admission) {
      const state = await follow(id, directory);
      if (state.events.some((event) => event.type === 'user/message' && event.data.source?.rpcId === history.admission.messageId)) {
        await reverts.finishCommit(id);
        const { admission, ...settled } = history;
        await saveHistory(id, settled);
        return null;
      }
      if (history.admission.messageId === messageId) return null;
      throw new NativeAgentError('Confirm the previous message in history before sending another.', { status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    }
    const source = await resolve(id, directory);
    internalForks += 1;
    let created;
    try {
      try {
        created = pending.deepseek.seq === 0
          ? await transport.request('session/create', { request: { cwd: source.directory } }, wire.sessionCreated)
          : await transport.request('session/fork', { request: { sessionId: source.nativeId, atSeq: pending.deepseek.seq - 1 } }, wire.sessionCreated);
      } catch {
        throw new NativeAgentError('Could not confirm the DeepSeek Harness fork. The original session is retained.', { status: 502, code: 'NATIVE_DEEPSEEK_FORK_OUTCOME_UNKNOWN' });
      }
      const title = recordOf(source.summary, source.entry).title;
      await transport.request('session/rename', { request: { sessionId: created.sessionId, title } }, z.object({ title: z.string(), seq: z.number() }));
      const next = appendDeepseekBranch(history, created.sessionId, pending.deepseek.seq);
      next.admission = { messageId, source: history.active };
      await saveHistory(id, next);
      forgetFollower(id);
      summaries.delete(id);
      publisher.emit(source.directory, 'session.revert.committed', { sessionID: id, to: pending.messageId, nativeHistoryRevision: next.revision });
      await reverts.beginCommit(id);
      return { source: history.active };
    } finally {
      internalForks -= 1;
      if (!internalForks) {
        for (const summary of deferredAdded.values()) updateSummary(summary);
        deferredAdded.clear();
      }
    }
  };

  const settleAdmission = async (id) => {
    const history = histories.get(id);
    if (!history?.admission) return;
    await reverts.finishCommit(id);
    const { admission, ...next } = history;
    await saveHistory(id, next);
  };

  const rollbackAdmission = async (id, directory) => {
    const history = histories.get(id);
    if (!history?.admission) return;
    const { admission, ...rest } = history;
    await saveHistory(id, { ...rest, active: admission.source, revision: history.revision + 1 });
    await reverts.cancelCommit(id);
    forgetFollower(id);
    summaries.delete(id);
    await listAll();
    publisher.session(directory, await decorateSession(await backend.getSession(id, directory)), { created: false });
  };

  const partsFor = async (nativeId, parts, signal) => {
    const content = [];
    for (const part of parts) {
      if (part.type === 'text') { content.push({ type: 'text', text: part.text }); continue; }
      if (part.url.startsWith('file://')) {
        const filePath = fileURLToPath(part.url);
        const uploaded = await transport.uploadFile(nativeId, filePath, part.filename ?? path.basename(filePath), signal);
        content.push({ type: 'file', receiptId: uploaded.receiptId });
        continue;
      }
      const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(part.url);
      if (!match) throw invalidRequestError('DeepSeek Harness requires an inline attachment or a local file reference');
      const data = match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString('base64');
      if (match[1].startsWith('image/')) {
        const image = { type: 'image', mediaType: match[1], data };
        if (part.filename) image.name = part.filename;
        content.push(image);
      }
      else {
        const upload = { data };
        if (part.filename) upload.name = part.filename;
        const uploaded = await transport.request('fileUploads/upload', { agentId: nativeId, request: upload }, wire.fileReceipt, signal);
        content.push({ type: 'file', receiptId: uploaded.receiptId });
      }
    }
    return content;
  };

  const configuration = createDeepseekConfiguration({ transport });

  const backend = {
    configuration,
    async listStatisticsSessions(signal) {
      await loadBindings();
      const list = await transport.request('session/list', { _request: {} }, wire.sessionList, signal);
      const byId = new Map(list.items.map((item) => [item.sessionId, item]));
      return list.items.filter((item) => visible(item.sessionId)).flatMap((item) => {
        const directory = item.cwd ?? byId.get(item.parentSessionId)?.cwd;
        if (!directory) return [];
        return [{ ...buildSessionRecord({ id: logicalId(item.sessionId), backend: 'deepseek', directory, title: '',
          created: item.updatedAt, updated: item.updatedAt,
          parentID: item.origin === 'subagent' && item.parentSessionId ? logicalId(item.parentSessionId) : null }), nativeId: item.sessionId }];
      });
    },
    // A short snapshot stream and fixed-watermark pages never enter `followers`
    // or publish chat events. In particular they cannot evict an open chat.
    async loadStatistics(id, directory, { signal, nativeId: listedNativeId } = {}) {
      await loadBindings();
      const nativeId = histories.get(id)?.active ?? listedNativeId ?? (await registry.getSession(id))?.nativeId;
      if (!nativeId) throw invalidRequestError('Invalid DeepSeek Harness session');
      signal?.throwIfAborted();
      let snapshot = null;
      const handle = await transport.open('session/follow', { request: {
        address: { kind: 'session', sessionId: nativeId }, maxMessages: 500,
        turnWindow: { minMessages: 100, minTurns: 2 },
      } }, (raw) => {
        const frame = wire.followFrame.parse(raw);
        if (frame.type === 'snapshot' && snapshot === null) snapshot = frame;
      });
      const cancel = () => handle.cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (signal?.aborted) cancel();
        await handle.first;
      } finally {
        signal?.removeEventListener('abort', cancel);
        handle.cancel();
      }
      signal?.throwIfAborted();
      if (!snapshot || snapshot.header.id !== nativeId) throw new Error('DeepSeek Harness returned another session snapshot');
      const historyRevision = histories.get(id)?.revision ?? 0;
      const pages = [snapshot.records.map((record) => record.event)];
      let hasMore = snapshot.hasMore;
      let beforeSeq = pages[0][0]?.seq;
      while (hasMore && beforeSeq !== undefined) {
        const page = await transport.request('session/page', { request: {
          address: { kind: 'session', sessionId: nativeId }, throughSeq: snapshot.cursor, beforeSeq,
          maxMessages: 500, turnWindow: { minMessages: 100, minTurns: 2 },
        } }, wire.historyPage, signal);
        const events = page.records.map((record) => record.event);
        if (!events.length || events[0].seq >= beforeSeq) throw new Error('DeepSeek Harness history did not advance');
        pages.unshift(events);
        beforeSeq = events[0].seq;
        hasMore = page.hasMore;
      }
      if ((histories.get(id)?.active ?? nativeId) !== nativeId || (histories.get(id)?.revision ?? 0) !== historyRevision) throw new NativeAgentError('Session history changed while reading statistics', { status: 409, code: 'NATIVE_HISTORY_CHANGED' });
      const projection = projectionFor(id, { nativeId, directory });
      const seen = new Set();
      let complete = !hasMore;
      let reasoningKnown = true;
      let tokensComplete = true;
      for (const events of pages) for (const event of events) {
        if (seen.has(event.seq)) continue;
        seen.add(event.seq);
        if (event.type === 'assistant/message' && !z.object({ usage: z.object({ reasoningTokens: z.number() }) }).safeParse(event.data).success) reasoningKnown = false;
        if (event.type === 'assistant/message' && !z.object({ usage: z.object({ cacheReadTokens: z.number(), cacheWriteTokens: z.number() }) }).safeParse(event.data).success) tokensComplete = false;
        try { projection.apply(event); }
        catch (error) { if (!(error instanceof z.ZodError)) throw error; complete = false; }
      }
      return { records: projection.records(), childSessions: [], complete, reasoningKnown, tokensComplete };
    },
    async catalog() {
      await ensureGlobals();
      const catalog = await transport.request('session/modelCatalog', {}, wire.modelCatalog);
      if (catalog.groups.length === 0 && catalog.failures.length > 0) throw new Error(catalog.failures.map((failure) => failure.message).join('\n'));
      // The session catalog names models but not their windows. The provider
      // settings do, and a profile that cannot answer leaves them null.
      const limits = await configuration.modelLimits().catch(() => new Map());
      const routable = new Set(catalog.routableProviders);
      return catalog.groups.filter((group) => routable.has(group.id)).flatMap((group) => group.models.map((model) => ({
        id: wire.modelId(group.id, model.id), name: model.name,
        contextWindow: limits.get(model.id)?.contextWindow ?? null,
        outputLimit: limits.get(model.id)?.outputLimit ?? null,
        efforts: model.reasoning?.efforts.map((effort) => effort.id) ?? [], defaultEffort: model.reasoning?.defaultEffort ?? null,
        input: { image: false, pdf: true },
      })));
    },
    async listRootSessions(directory) {
      // A create may be registering a conversation owner before its public
      // announcement. Its source must not appear as an independent root.
      await operations.get('new-session')?.catch(() => undefined);
      const list = await listAll();
      return Promise.all(list.filter((summary) => summary.origin !== 'subagent' && summary.cwd && sameDirectory(summary.cwd, directory))
        .map(async (summary) => recordOf(summary, await registry.getSession(logicalId(summary.sessionId)))));
    },
    async getSession(id, directory) {
      const source = await resolve(id, directory);
      return source.summary ? recordOf(source.summary, source.entry) : buildSessionRecord({
        id, backend: 'deepseek', directory: source.directory, title: source.entry.title ?? 'DeepSeek Harness', created: source.entry.createdAt, updated: source.entry.createdAt,
      });
    },
    async adopt(id, directory) {
      const source = await resolve(id, directory);
      const entry = await registry.registerSession(id, { backend: 'deepseek', nativeId: source.nativeId, directory: source.directory, origin: 'adopted', createdAt: source.summary?.updatedAt ?? now(), confirmedAt: now() });
      bind(id, entry.deepseekHistory ?? initialDeepseekHistory(id, entry.nativeId));
      return entry;
    },
    createSession(directory, title, beforePublish = async () => undefined) {
      return serial('new-session', async () => {
      await ensureGlobals();
      internalForks += 1;
      try {
      const created = await transport.request('session/create', { request: { cwd: directory } }, wire.sessionCreated);
      const id = encodeDeepseekSessionId(created.sessionId);
      const entry = { backend: 'deepseek', nativeId: created.sessionId, directory, origin: 'openchamber', createdAt: now(), confirmedAt: now() };
      if (title) entry.title = title;
      await registry.registerSession(id, entry);
      bind(id, initialDeepseekHistory(id, created.sessionId));
      await beforePublish(buildSessionRecord({ id, backend: 'deepseek', directory, title: title ?? 'DeepSeek Harness', created: entry.createdAt, updated: entry.createdAt }));
      if (title) await transport.request('session/rename', { request: { sessionId: created.sessionId, title } }, z.object({ title: z.string(), seq: z.number() }));
      await listAll();
      const summary = summaries.get(id);
      return summary ? recordOf(summary, await registry.getSession(id)) : buildSessionRecord({ id, backend: 'deepseek', directory, title: title ?? 'DeepSeek Harness', created: now(), updated: now() });
      } finally {
        internalForks -= 1;
        if (!internalForks) {
          for (const summary of deferredAdded.values()) updateSummary(summary);
          deferredAdded.clear();
        }
      }
      });
    },
    prompt(id, request, signal) {
      return serial(id, async () => {
        signal?.throwIfAborted();
        if (!request.messageID.startsWith(`ndh_u_${id.slice(4, 28)}_`) || !isNativeClientUserMessageId(request.messageID)) throw invalidRequestError('DeepSeek Harness message id belongs to another session');
        await backend.adopt(id, request.directory);
        await commitRevert(id, request.directory, request.messageID);
        let admitted = false;
        try {
          const source = await resolve(id, request.directory);
          const route = wire.modelRoute(request.model.modelID);
          const model = { sessionId: source.nativeId, ...route };
          if (request.variant) model.reasoningEffort = request.variant;
          await transport.request('session/selectModel', { request: model }, z.object({ selected: wire.selection }), signal);
          await applyPermissions(id, source.nativeId);
          await command(source.nativeId, request.agent === 'plan' ? '/plan' : '/plan off');
          if (!managedTurns.has(id)) managedTurns.set(id, new Set());
          managedTurns.get(id).add(request.messageID);
          const state = await follow(id, source.directory);
          const duplicate = state.events.some((event) => event.type === 'user/message' && event.data.source?.rpcId === request.messageID);
          const instructions = [await readGlobalInstructions(), request.instructions].filter(Boolean).join('\n\n');
          const content = await partsFor(source.nativeId, withInstructions(request.parts, instructions || undefined), signal);
          signal?.throwIfAborted();
          if (duplicate) {
            managedTurns.get(id)?.delete(request.messageID);
            if (managedTurns.get(id)?.size === 0) managedTurns.delete(id);
          } else await reverts?.beforePrompt(id, source.directory, request.messageID);
          signal?.throwIfAborted();
          progressSuppressed.delete(id);
          await transport.request('session/prompt', { request: { sessionId: source.nativeId, requestId: request.messageID,
            mode: source.summary?.running ? 'steer' : 'queue', content } }, wire.accepted, signal);
          admitted = true;
          await settleAdmission(id);
        } catch (error) {
          if (admitted) throw new NativeAgentError('The message was accepted, but its local history update is unconfirmed. Reload before continuing.', { status: 502, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
          if (error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') {
            managedTurns.get(id)?.delete(request.messageID);
            if (managedTurns.get(id)?.size === 0) managedTurns.delete(id);
            memory?.release(id);
            await rollbackAdmission(id, request.directory);
          }
          throw error;
        }
      });
    },
    deleteSession(id, directory) {
      return serial(id, async () => {
        if (!maintenance) throw deepseekUnsupported();
        await loadBindings();
        const unfinished = deletionIntents.get(id);
        if (unfinished && !sameDirectory(unfinished.directory, directory)) throw invalidRequestError('DeepSeek Harness session belongs to another directory');
        if (!unfinished) await backend.adopt(id, directory);
        const session = unfinished ? buildSessionRecord({ id, backend: 'deepseek', directory: unfinished.directory, title: unfinished.title ?? 'DeepSeek Harness', created: unfinished.createdAt, updated: now() }) : await decorateSession(await backend.getSession(id, directory));
        maintaining = true;
        let closed = false;
        try {
          await Promise.allSettled([...operations].filter(([key]) => key !== id).map(([, work]) => work));
          const inspection = await transport.inspectMaintenance();
          const history = histories.get(id) ?? (unfinished ? unfinished.deepseekHistory ?? initialDeepseekHistory(id, unfinished.nativeId) : null);
          if (!history) throw sessionNotFoundError(id);
          const nativeIds = history.branches.map((branch) => branch.nativeId);
          const owned = new Set(nativeIds);
          let changed = true;
          while (changed) {
            changed = false;
            for (const item of inspection.sessions) if (item.origin === 'subagent' && owned.has(item.parent) && !owned.has(item.id)) { owned.add(item.id); changed = true; }
          }
          const foreignQuestion = [...pending.values()].some((question) => !owned.has(question.nativeId));
          if (foreignQuestion || inspection.active.some((nativeId) => !owned.has(nativeId))) throw new NativeAgentError('Another DeepSeek Harness session is active. Retry deletion when it is idle.', { status: 409, code: 'NATIVE_DEEPSEEK_MAINTENANCE_BUSY' });
          progressSuppressed.add(id);
          if (inspection.sessions.some((item) => item.id === history.active)) await stopAndWait(id, directory);
          else await turnWork.get(id);
          const settled = await transport.inspectMaintenance();
          if (settled.active.length) throw new NativeAgentError('Wait for DeepSeek Harness activity to stop before deleting.', { status: 409, code: 'NATIVE_SESSION_BUSY' });
          const entry = await registry.setDeepseekDeletion(id, { root: inspection.root });
          deletionIntents.set(id, entry);
          await transport.closeForMaintenance();
          closed = true;
          const result = await maintenance.remove(inspection, nativeIds);
          let cleanupFailed = false;
          try {
            await memory?.forget(id, directory);
            await registry.removeSession(id);
            deletionIntents.delete(id);
          } catch { cleanupFailed = true; }
          retireSession(id, entry);
          publisher.sessionDeleted(directory, session);
          if (!result.ok || cleanupFailed) throw new NativeAgentError('The session was deleted, but some saved metadata or temporary artifacts could not be cleaned up. Reload before retrying.', { status: 500, code: 'NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED' });
          return { deleted: true };
        } finally {
          try { if (closed) { await transport.resumeAfterMaintenance(); await listAll(); } }
          finally { maintaining = false; }
        }
      });
    },
    revert(id, messageId, directory) {
      return serial(id, async () => {
        if (!reverts) throw deepseekUnsupported();
        markMutation(id);
        await backend.adopt(id, directory);
        if (histories.get(id).admission) throw new NativeAgentError('Confirm the previous message before reverting.', { status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
        progressSuppressed.add(id);
        await stopAndWait(id, directory);
        const source = await resolve(id, directory);
        const target = await rewindTarget(id, messageId, directory);
        const wasPending = (await reverts.pending(id))?.phase === 'pending';
        await memory?.setProgressVisible(id, directory, false);
        let restored;
        try {
          restored = await reverts.revert({ sessionId: id, messageId, messageIds: target.messageIds,
            rewind: { deepseek: { nativeId: source.nativeId, seq: target.seq } } });
        } catch (error) {
          if (!wasPending) await memory?.setProgressVisible(id, directory, true);
          throw error;
        }
        const session = await decorateSession(await backend.getSession(id, directory));
        publisher.session(directory, session, { created: false });
        return { session, ...restored };
      });
    },
    unrevert(id, directory) {
      return serial(id, async () => {
        markMutation(id);
        if (histories.get(id)?.admission) throw new NativeAgentError('Confirm the previous message before restoring.', { status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
        await resolve(id, directory);
        await memory?.setProgressVisible(id, directory, true);
        try { await reverts?.unrevert(id); }
        catch (error) { await memory?.setProgressVisible(id, directory, false); throw error; }
        progressSuppressed.delete(id);
        const state = await follow(id, directory);
        state.projection.publishAll();
        const session = await decorateSession(await backend.getSession(id, directory));
        publisher.session(directory, session, { created: false });
        return session;
      });
    },
    async commands(id, directory) {
      if (!id) return { commands: [] };
      const source = await resolve(id, directory);
      const list = await transport.request('commands/list', { agentId: source.nativeId }, wire.commandList);
      return { commands: list.filter((item) => item.name !== 'permission').map((item) => ({ name: item.name, description: item.description, argumentHint: item.input?.hint ?? '' })) };
    },
    executeCommand(id, directory, line) {
      return serial(id, async () => {
        if (/^\/permission(?:\s|$)/i.test(line)) throw deepseekUnsupported();
        const committing = /^\/compact(?:\s|$)/i.test(line);
        if (committing) {
          await backend.adopt(id, directory);
          await commitRevert(id, directory, `command:${randomUUID()}`);
          await settleAdmission(id);
        }
        const source = await resolve(id, directory);
        await applyPermissions(id, source.nativeId);
        await follow(id, source.directory);
        const text = await command(source.nativeId, line);
        return { kind: 'output', entries: [], notices: text ? [text] : [] };
      });
    },
    rename(id, directory, title) {
      return serial(id, async () => {
      const source = await resolve(id, directory);
      await transport.request('session/rename', { request: { sessionId: source.nativeId, title } }, z.object({ title: z.string(), seq: z.number() }));
      await listAll();
      });
    },
    setArchived(id, directory, value) {
      return serial(id, async () => {
      const source = await resolve(id, directory);
      const request = { sessionId: source.nativeId };
      if (value) request.stopActivity = true;
      const result = await transport.request(`workspace/${value ? 'archiveSession' : 'unarchiveSession'}`, { request }, z.object({ archivedSessionIds: z.array(z.string()) }));
      archived = new Set(result.archivedSessionIds);
      });
    },
    async loadMessages(id, directory, { limit, before }) {
      const state = await follow(id, directory);
      const historyRevision = histories.get(id)?.revision ?? 0;
      const assertCurrentHistory = () => {
        const current = histories.get(id);
        if ((current?.active ?? state.nativeId) !== state.nativeId || (current?.revision ?? 0) !== historyRevision) throw new NativeAgentError('Session history changed while loading. Reload and retry.', { status: 409, code: 'NATIVE_HISTORY_CHANGED' });
      };
      assertCurrentHistory();
      let events = state.events;
      let hasMore = state.hasMore;
      let projection = state.projection;
      if (before) {
        let beforeSeq;
        try { beforeSeq = deepseekCursorPosition(id, histories.get(id) ?? initialDeepseekHistory(id, state.nativeId), before); }
        catch { throw invalidRequestError('Unknown DeepSeek Harness message cursor'); }
        const page = await transport.request('session/page', { request: {
          address: { kind: 'session', sessionId: state.nativeId }, throughSeq: state.cursor, beforeSeq,
          maxMessages: Math.min(500, Math.max(100, limit)), turnWindow: { minMessages: Math.min(100, Math.max(50, limit)), minTurns: 2 },
        } }, wire.historyPage);
        events = page.records.map((record) => record.event);
        hasMore = page.hasMore;
        projection = projectionFor(id, state);
        for (const event of events) applyProjected(id, directory, projection, event);
      }
      assertCurrentHistory();
      const records = projection.records();
      const end = records.length;
      const start = Math.max(0, end - limit);
      const complete = start === 0 && !hasMore;
      const position = projection.position(records[start]?.info.id) ?? events[0]?.seq ?? 0;
      return { records: records.slice(start, end), cursor: complete ? null : deepseekHistoryCursor(id, state.nativeId, position), complete, childSessions: [], historyRevision };
    },
    fork(id, messageId, directory) {
      return serial(id, async () => {
      const source = await resolve(id, directory);
      const state = await follow(id, directory);
      let atSeq = messageId ? state.projection.position(messageId) : undefined;
      let beforeSeq = state.events[0]?.seq;
      let hasMore = state.hasMore;
      while (messageId && atSeq === undefined && hasMore && beforeSeq !== undefined) {
        const page = await transport.request('session/page', { request: {
          address: { kind: 'session', sessionId: source.nativeId }, throughSeq: state.cursor, beforeSeq, maxMessages: 500,
          turnWindow: { minMessages: 100, minTurns: 2 },
        } }, wire.historyPage);
        const first = page.records[0]?.event.seq;
        if (first === undefined || first >= beforeSeq) throw new NativeAgentError('DeepSeek Harness history paging made no progress', { code: 'NATIVE_DEEPSEEK_PROTOCOL', status: 502 });
        const projection = projectionFor(id, source);
        for (const record of page.records) applyProjected(id, directory, projection, record.event);
        atSeq = projection.position(messageId);
        beforeSeq = first;
        hasMore = page.hasMore;
      }
      if (messageId && atSeq === undefined) throw invalidRequestError('Unknown DeepSeek Harness fork message');
      if (atSeq === 0) return this.createSession(source.directory);
      const request = { sessionId: source.nativeId };
      if (atSeq !== undefined) request.atSeq = atSeq - 1;
      const result = await transport.request('session/fork', { request }, wire.sessionCreated);
      const forkedId = encodeDeepseekSessionId(result.sessionId);
      await registry.registerSession(forkedId, { backend: 'deepseek', nativeId: result.sessionId, directory: source.directory, origin: 'openchamber', createdAt: now(), confirmedAt: now() });
      await listAll();
      return backend.getSession(forkedId, source.directory);
      });
    },
    stop(id, directory) {
      return serial(id, () => stopAndWait(id, directory));
    },
    async abort(id) {
      const source = await resolve(id);
      const running = source.summary?.running ?? false;
      await transport.request('session/cancel', { request: { sessionId: source.nativeId } }, wire.accepted);
      return running;
    },
    busySessionIds(directory) { return Array.from(summaries, ([id, summary]) => summary.origin !== 'subagent' && summary.running && summary.cwd && sameDirectory(summary.cwd, directory) ? id : null).filter(Boolean); },
    childSession: () => null,
    liveRecords: (id) => followers.get(id)?.projection.records() ?? [],
    async sessionExists(id, directory) { try { await resolve(id, directory); return true; } catch (error) { if (error instanceof NativeAgentError && error.code === 'NATIVE_SESSION_NOT_FOUND') return false; throw error; } },
    hasPendingPlanDecision: (id) => Array.from(pending.values()).some((entry) => entry.plan && logicalId(entry.nativeId) === id),
    async shutdown() { stopping = true; await transport.shutdown(); await Promise.allSettled([...turnWork.values(), ...operations.values()]); },
  };
  return backend;
};
