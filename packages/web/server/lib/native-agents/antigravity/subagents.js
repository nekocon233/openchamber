import { encodeAntigravitySessionId, NATIVE_PROVIDER_ANTIGRAVITY } from '../ids.js';
import { buildSessionRecord, unknownError } from '../records.js';
import { agySubagentReferences } from './protocol.js';
import { createAntigravityLiveProjection } from './projector.js';

/** Child ownership is established by the parent's live subagent_info, never
 * by an arbitrary conversation id or a persisted running flag. */
export const createAntigravitySubagents = ({ publisher, now }) => {
  const children = new Map();

  const publishSession = (child, created = false) => {
    child.session.time.updated = now();
    publisher.session(child.session.directory, child.session, { created });
  };
  const captureRecords = (child) => {
    for (const record of child.projection?.records() ?? []) child.records.set(record.info.id, record);
  };
  const announce = (owner, process, step, parent) => {
    for (const agent of agySubagentReferences(step.subagent_info)) {
      const id = encodeAntigravitySessionId(agent.conversation_id);
      if (id === owner.id || id === parent.id) continue;
      const existing = children.get(id);
      if (existing) {
        // A stale process or a different parent cannot reassign a child.
        if (existing.ownerId !== owner.id || existing.session.parentID !== parent.id) continue;
        existing.process = process;
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
      const directory = child.session.directory;
      if (frame.event === 'result') {
        const result = frame.result;
        const outcome = result.status === 'SUCCESS' ? 'success'
          : ['CANCELED', 'INTERRUPTED'].includes(result.status) ? 'aborted' : 'error';
        child.projection?.finish({ outcome, response: result.response, error: result.error ?? '', time: now() });
        captureRecords(child);
        child.phase = 'settled';
        child.session.metadata.openchamber.native.activityKnown = true;
        publishSession(child);
        if (outcome === 'error') publisher.error(directory, child.session.id, unknownError(result.error || 'Antigravity subagent failed'));
        publisher.status(directory, child.session.id, 'idle');
        return true;
      }
      const step = frame.step_update;
      announce(owner, process, step, child.session);
      if (!child.projection || step.step_type === 'user_input') {
        captureRecords(child);
        const userIndex = step.step_type === 'user_input' ? step.step_index : 'context';
        child.projection = createAntigravityLiveProjection({
          sessionId: child.session.id, nativeId: child.nativeId, directory, publisher,
          request: {
            messageID: `nag_u_${child.nativeId.replaceAll('-', '')}_${userIndex}`,
            // A custom child can use a different model; the CLI does not name it here.
            model: { providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: '' },
            agent: 'build', sentAt: now(),
            parts: child.records.size === 0 && child.prompt ? [{ type: 'text', text: child.prompt }] : [],
          },
        });
      }
      if (child.phase !== 'running') {
        child.phase = 'running';
        child.session.metadata.openchamber.native.activityKnown = true;
        publishSession(child);
        publisher.status(directory, child.session.id, 'busy');
      }
      await child.projection.applyStep(step, now(), async () => {});
      return true;
    },

    release(ownerId, process) {
      for (const child of children.values()) {
        if (child.ownerId !== ownerId || child.process !== process || child.phase === 'settled') continue;
        child.phase = 'unknown';
        child.session.metadata.openchamber.native.activityKnown = false;
        publishSession(child);
        publisher.status(child.session.directory, child.session.id, 'idle');
      }
    },

    forget(ownerId, process) {
      for (const [id, child] of children) {
        if (child.ownerId === ownerId && child.process === process) children.delete(id);
      }
    },

    session(id) { return children.get(id)?.session ?? null; },
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
    clear() { children.clear(); },
  };
};
