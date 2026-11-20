import { encodeAntigravitySessionId, NATIVE_PROVIDER_ANTIGRAVITY } from '../ids.js';
import { buildSessionRecord, unknownError } from '../records.js';
import { agySubagentReferences } from './protocol.js';
import { createAntigravityLiveProjection } from './projector.js';
import { agyMissingFileDetails } from './tools.js';

const CHILD_ACTIVITY_INTERVAL_MS = 1000;

/** Child ownership is established by the parent's live subagent_info, never
 * by an arbitrary conversation id or a persisted running flag. */
export const createAntigravitySubagents = ({ publisher, now, loadHistory, readReasoning, readActivity }) => {
  const children = new Map();
  const watched = new Map();
  let activityTimer;

  const publishSession = (child, created = false) => {
    child.session.time.updated = now();
    publisher.session(child.session.directory, child.session, { created });
  };
  const publishPhase = (child, phase, error = null) => {
    if (child.phase === phase && !error) return;
    const { directory, id } = child.session;
    if (child.phase !== phase) {
      child.phase = phase;
      child.session.metadata.openchamber.native.activityKnown = phase !== 'unknown';
      publishSession(child);
    }
    if (error) publisher.error(directory, id, error);
    publisher.status(directory, id, phase === 'running' ? 'busy' : 'idle');
  };
  const refreshActivity = () => {
    let readings;
    try { readings = readActivity([...watched.keys()].map((child) => child.nativeId)); }
    catch { return; /* An unavailable index supplies no activity update. */ }
    for (const [child, minimumTime] of watched) {
      const reading = readings.get(child.nativeId);
      if (!reading || reading.parentId !== child.session.parentID || reading.updatedAt < minimumTime) continue;
      watched.set(child, reading.updatedAt);
      publishPhase(child, reading.busy ? 'running' : 'settled');
    }
  };
  const watchActivity = (child, startedAt) => {
    if (!Number.isFinite(startedAt)) return;
    watched.set(child, startedAt);
    activityTimer ??= setInterval(refreshActivity, CHILD_ACTIVITY_INTERVAL_MS).unref();
  };
  const unwatchActivity = (child) => {
    watched.delete(child);
    if (watched.size > 0) return;
    clearInterval(activityTimer);
    activityTimer = undefined;
  };
  const captureRecords = (child) => {
    for (const record of child.projection?.records() ?? []) child.records.set(record.info.id, record);
  };
  const beginProjection = (child, userIndex) => {
    captureRecords(child);
    child.reasoningAfterTool = false;
    child.projection = createAntigravityLiveProjection({
      sessionId: child.session.id, nativeId: child.nativeId, directory: child.session.directory, publisher,
      request: {
        messageID: 'nag_u_' + child.nativeId.replaceAll('-', '') + '_' + userIndex,
        // A custom child can use a different model; the CLI does not name it here.
        model: { providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: '' },
        agent: 'build', sentAt: now(),
        parts: child.records.size === 0 && child.prompt ? [{ type: 'text', text: child.prompt }] : [],
      },
    });
  };
  const refreshReasoning = (child) => {
    try { child.projection.restoreGenerations(readReasoning(child.nativeId)); }
    catch { /* Optional enrichment preserves the observed child records. */ }
  };
  const announce = (owner, process, step, parent) => {
    for (const agent of agySubagentReferences(step.subagent_info)) {
      const id = encodeAntigravitySessionId(agent.conversation_id);
      if (id === owner.id || id === parent.id) continue;
      const existing = children.get(id);
      if (existing) {
        // A stale process or a different parent cannot reassign a child.
        if (existing.ownerId !== owner.id || existing.session.parentID !== parent.id) continue;
        if (existing.process !== process) {
          existing.process = process;
          watchActivity(existing, owner.turn?.send?.sentAt);
        }
        continue;
      }
      const session = buildSessionRecord({
        id, backend: 'antigravity', directory: owner.directory, parentID: parent.id,
        title: agent.role || agent.type_name, created: now(), updated: now(),
      });
      session.metadata.openchamber.native.activityKnown = false;
      const child = {
        session, nativeId: agent.conversation_id, ownerId: owner.id, process,
        prompt: agent.initial_prompt, phase: 'unknown', projection: null, records: new Map(),
      };
      children.set(id, child);
      publishSession(child, true);
      watchActivity(child, owner.turn?.send?.sentAt);
    }
  };

  return {
    async handle(owner, process, frame) {
      const nativeId = frame.event === 'result' ? frame.result.conversation_id : frame.step_update.conversation_id;
      if (nativeId === owner.nativeId) {
        if (frame.event === 'step_update' && owner.turn?.process === process) announce(owner, process, frame.step_update, owner.record);
        return false;
      }
      const child = children.get(`nag_${nativeId}`);
      if (!child || child.ownerId !== owner.id || child.process !== process) return true;
      // A direct frame supersedes older rows. The index can still report a
      // later completion or a new assignment when those frames are missing.
      const minimumTime = watched.get(child);
      if (minimumTime !== undefined) watched.set(child, Math.max(minimumTime, now() + 1));
      const directory = child.session.directory;
      if (frame.event === 'result') {
        const result = frame.result;
        const outcome = result.status === 'SUCCESS' ? 'success'
          : ['CANCELED', 'INTERRUPTED'].includes(result.status) ? 'aborted' : 'error';
        let history = null;
        try {
          history = await loadHistory(child.session.id, child.nativeId, directory);
        } catch { /* Optional recovery retains live output; history reads report failures. */ }
        const final = history?.records.at(-1);
        const text = final?.parts.find((part) => part.type === 'text' && !part.synthetic && !part.metadata?.nativeSubagentMessage);
        const responseStep = final?.info.role === 'assistant' && final.info.finish === 'stop'
          && final.info.time.completed !== undefined && !final.info.error && text
          ? { step_index: Number(final.info.id.split('_').at(-1)) } : null;
        if (!child.projection) beginProjection(child, 'context');
        child.projection.finish({
          outcome, response: responseStep && !text.metadata?.nativeOutputTruncated ? text.text : result.response,
          error: result.error ?? '', time: now(), responseStep,
        });
        if (history) child.projection.restoreMissingHistory(history.records, { scope: 'session' });
        captureRecords(child);
        publishPhase(child, 'settled', outcome === 'error' ? unknownError(result.error || 'Antigravity subagent failed') : null);
        return true;
      }
      const step = frame.step_update;
      announce(owner, process, step, child.session);
      if (!child.projection || step.step_type === 'user_input') {
        const userIndex = step.step_type === 'user_input' ? step.step_index : 'context';
        beginProjection(child, userIndex);
      }
      publishPhase(child, 'running');
      const tool = await child.projection.applyStep(step, now(), async () => {});
      const settledTool = tool && ['DONE', 'ERROR', 'INVALID'].includes(step.state);
      if (step.step_type === 'agent_response' && step.state === 'DONE') {
        refreshReasoning(child);
        child.reasoningAfterTool = true;
      } else if (settledTool && agyMissingFileDetails(tool)) {
        refreshReasoning(child);
        child.reasoningAfterTool = agyMissingFileDetails(child.projection.toolPart(tool.id));
      } else if (settledTool && child.reasoningAfterTool) {
        child.reasoningAfterTool = false;
        refreshReasoning(child);
      }
      return true;
    },

    beginTurn(ownerId, process, startedAt) {
      for (const child of children.values()) {
        if (child.ownerId === ownerId && child.process === process) watchActivity(child, startedAt);
      }
    },

    release(ownerId, process) {
      for (const child of children.values()) {
        if (child.ownerId !== ownerId || child.process !== process) continue;
        unwatchActivity(child);
        if (child.phase !== 'settled') publishPhase(child, 'unknown');
      }
    },

    forget(ownerId, process) {
      for (const [id, child] of children) {
        if (child.ownerId === ownerId && child.process === process) children.delete(id);
      }
    },

    session(id) { return children.get(id)?.session ?? null; },
    refreshReasoning(id) {
      const child = children.get(id);
      if (child?.projection) refreshReasoning(child);
    },
    records(id) {
      const child = children.get(id);
      // Once observation ends, the native history owns content again. A
      // partial live copy must not overwrite the completed saved response.
      if (!child || child.phase === 'unknown') return [];
      const records = new Map(child.records);
      for (const record of child.projection?.records() ?? []) records.set(record.info.id, record);
      return [...records.values()];
    },
    childrenOf(id) { return [...children.values()].filter((child) => child.session.parentID === id).map((child) => child.session); },
    busyIds(directory) {
      return [...children.values()].filter((child) => child.phase === 'running' && child.session.directory === directory).map((child) => child.session.id);
    },
    clear() {
      clearInterval(activityTimer);
      activityTimer = undefined;
      watched.clear();
      children.clear();
    },
  };
};
