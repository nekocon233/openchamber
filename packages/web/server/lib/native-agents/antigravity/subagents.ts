import type { AgyStore } from './store.js';
import { encodeAntigravitySessionId, NATIVE_PROVIDER_ANTIGRAVITY } from '../ids.js';
import { buildSessionRecord, unknownError } from '../records.js';
import type { NativeMessageRecord, NativeSessionRecord, NativeTextPart } from '../records.js';
import type { NativeEventPublisher } from '../publisher.js';
import { agySubagentReferences } from './protocol.js';
import type { AgyStepUpdate, AgyStreamFrame, AgyTranscriptStep } from './protocol.js';
import { createAntigravityLiveProjection } from './projector.js';
import type { AgyLiveProjection } from './projector.js';
import type { AgyProcessHandle } from './process.js';
import { agyMissingFileDetails } from './tools.js';

export type AgySubagentsPublisher = Pick<
  NativeEventPublisher,
  'records' | 'delta' | 'checklist' | 'emit' | 'session' | 'status' | 'error'
>;

export interface AgySubagentOwner {
  id: string;
  nativeId: string;
  directory: string;
  record: NativeSessionRecord;
  turn: { process: AgyProcessHandle | null; send?: { sentAt: number } } | null;
}

export interface AgySubagentsDependencies {
  readActivity: AgyStore['readChildActivity'];
  publisher: AgySubagentsPublisher;
  now: () => number;
  loadHistory: (sessionId: string, nativeId: string, directory: string) => Promise<{ records: NativeMessageRecord[] } | null>;
  readReasoning: (nativeId: string) => AgyTranscriptStep[];
}

export interface AgySubagentsController {
  beginTurn: (ownerId: string, process: AgyProcessHandle | null, startedAt: number) => void;
  handle: (owner: AgySubagentOwner, process: AgyProcessHandle, frame: AgyStreamFrame) => Promise<boolean>;
  release: (ownerId: string, process: AgyProcessHandle) => void;
  forget: (ownerId: string, process: AgyProcessHandle) => void;
  session: (id: string) => NativeSessionRecord | null;
  refreshReasoning: (id: string) => void;
  records: (id: string) => NativeMessageRecord[];
  childrenOf: (id: string) => NativeSessionRecord[];
  busyIds: (directory: string) => string[];
  clear: () => void;
}

interface AgySubagentChild {
  session: NativeSessionRecord;
  nativeId: string;
  ownerId: string;
  process: AgyProcessHandle;
  prompt: string;
  phase: 'unknown' | 'running' | 'settled';
  projection: AgyLiveProjection | null;
  records: Map<string, NativeMessageRecord>;
  reasoningAfterTool?: boolean;
}

const CHILD_ACTIVITY_INTERVAL_MS = 1000;


export const createAntigravitySubagents = ({
  publisher,
  now,
  loadHistory,
  readReasoning,
  readActivity,
}: AgySubagentsDependencies): AgySubagentsController => {
  const children = new Map<string, AgySubagentChild>();
  const watched = new Map<AgySubagentChild, number>();
  let activityTimer: ReturnType<typeof setInterval> | undefined;

  const publishSession = (child: AgySubagentChild, created = false): void => {
    child.session.time.updated = now();
    publisher.session(child.session.directory, child.session, { created });
  };
  const publishPhase = (child: AgySubagentChild, phase: AgySubagentChild['phase'], error: ReturnType<typeof unknownError> | null = null) => {
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
    let readings: ReturnType<AgyStore['readChildActivity']>;
    try { readings = readActivity([...watched.keys()].map((child) => child.nativeId)); }
    catch { return; }
    for (const [child, minimumTime] of watched) {
      const reading = readings.get(child.nativeId);
      if (!reading || reading.parentId !== child.session.parentID || reading.updatedAt < minimumTime) continue;
      watched.set(child, reading.updatedAt);
      publishPhase(child, reading.busy ? 'running' : 'settled');
    }
  };
  const watchActivity = (child: AgySubagentChild, startedAt: number | undefined) => {
    if (startedAt === undefined || !Number.isFinite(startedAt)) return;
    watched.set(child, startedAt);
    activityTimer ??= setInterval(refreshActivity, CHILD_ACTIVITY_INTERVAL_MS).unref();
  };
  const unwatchActivity = (child: AgySubagentChild) => {
    watched.delete(child);
    if (watched.size > 0) return;
    clearInterval(activityTimer);
    activityTimer = undefined;
  };
  const captureRecords = (child: AgySubagentChild): void => {
    for (const record of child.projection?.records() ?? []) child.records.set(record.info.id, record);
  };

  const beginProjection = (child: AgySubagentChild, userIndex: number | string): AgyLiveProjection => {
    captureRecords(child);
    child.reasoningAfterTool = false;
    const projection = createAntigravityLiveProjection({
      sessionId: child.session.id,
      nativeId: child.nativeId,
      directory: child.session.directory,
      publisher,
      request: {
        messageID: `nag_u_${child.nativeId.replaceAll('-', '')}_${userIndex}`,
        model: { providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: '' },
        agent: 'build',
        sentAt: now(),
        parts: child.records.size === 0 && child.prompt ? [{ type: 'text', text: child.prompt }] : [],
      },
    });
    child.projection = projection;
    return projection;
  };

  const refreshReasoning = (child: AgySubagentChild): void => {
    if (!child.projection) return;
    try {
      child.projection.restoreGenerations(readReasoning(child.nativeId));
    } catch {
      return;
    }
  };

  const announce = (
    owner: AgySubagentOwner,
    process: AgyProcessHandle,
    step: AgyStepUpdate,
    parent: NativeSessionRecord,
  ): void => {
    for (const agent of agySubagentReferences(step.subagent_info)) {
      const id = encodeAntigravitySessionId(agent.conversation_id);
      if (id === owner.id || id === parent.id) continue;
      const existing = children.get(id);
      if (existing) {
        if (existing.ownerId !== owner.id || existing.session.parentID !== parent.id) continue;
        if (existing.process !== process) {
          existing.process = process;
          watchActivity(existing, owner.turn?.send?.sentAt);
        }
        continue;
      }
      const session = buildSessionRecord({
        id,
        backend: 'antigravity',
        directory: owner.directory,
        parentID: parent.id,
        title: agent.role || agent.type_name,
        created: now(),
        updated: now(),
      });
      session.metadata.openchamber.native.activityKnown = false;
      const child: AgySubagentChild = {
        session,
        nativeId: agent.conversation_id,
        ownerId: owner.id,
        process,
        prompt: agent.initial_prompt,
        phase: 'unknown',
        projection: null,
        records: new Map(),
      };
      children.set(id, child);
      publishSession(child, true);
      watchActivity(child, owner.turn?.send?.sentAt);
    }
  };

  return {
    async handle(owner, process, frame) {
      if (frame.event === 'init') return false;
      const nativeId = frame.event === 'result' ? frame.result.conversation_id : frame.step_update.conversation_id;
      if (nativeId === owner.nativeId) {
        if (frame.event === 'step_update' && owner.turn?.process === process) {
          announce(owner, process, frame.step_update, owner.record);
        }
        return false;
      }
      const child = children.get(`nag_${nativeId}`);
      if (!child || child.ownerId !== owner.id || child.process !== process) return true;
      const minimumTime = watched.get(child);
      if (minimumTime !== undefined) watched.set(child, Math.max(minimumTime, now() + 1));
      const directory = child.session.directory;
      if (frame.event === 'result') {
        const result = frame.result;
        const outcome: 'success' | 'aborted' | 'error' = result.status === 'SUCCESS'
          ? 'success'
          : (result.status === 'CANCELED' || result.status === 'INTERRUPTED')
            ? 'aborted'
            : 'error';
        let history: { records: NativeMessageRecord[] } | null = null;
        try {
          history = await loadHistory(child.session.id, child.nativeId, directory);
        } catch {
          history = null;
        }
        const final = history?.records.at(-1);
        const text = final?.parts.find((part): part is NativeTextPart => (
          part.type === 'text' && !part.synthetic && !part.metadata?.nativeSubagentMessage
        ));
        const responseStep = final?.info.role === 'assistant' && final.info.finish === 'stop'
          && final.info.time.completed !== undefined && !final.info.error && text
          ? { step_index: Number(final.info.id.split('_').at(-1)) }
          : null;
        const projection = child.projection ?? beginProjection(child, 'context');
        projection.finish({
          outcome,
          response: responseStep && text && !text.metadata?.nativeOutputTruncated ? text.text : result.response,
          error: result.error ?? '',
          time: now(),
          responseStep,
        });
        if (history) projection.restoreMissingHistory(history.records, { scope: 'session' });
        captureRecords(child);
        publishPhase(child, 'settled', outcome === 'error' ? unknownError(result.error || 'Antigravity subagent failed') : null);
        return true;
      }
      const step = frame.step_update;
      announce(owner, process, step, child.session);
      const projection = (!child.projection || step.step_type === 'user_input')
        ? beginProjection(child, step.step_type === 'user_input' ? step.step_index : 'context')
        : child.projection;
      publishPhase(child, 'running');
      const tool = await projection.applyStep(step, now(), async () => {});
      const settledTool = tool && ['DONE', 'ERROR', 'INVALID'].includes(step.state);
      if (step.step_type === 'agent_response' && step.state === 'DONE') {
        refreshReasoning(child);
        child.reasoningAfterTool = true;
      } else if (settledTool && agyMissingFileDetails(tool)) {
        refreshReasoning(child);
        child.reasoningAfterTool = agyMissingFileDetails(projection.toolPart(tool.id));
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

    session(id) {
      return children.get(id)?.session ?? null;
    },
    refreshReasoning(id) {
      const child = children.get(id);
      if (child?.projection) refreshReasoning(child);
    },
    records(id) {
      const child = children.get(id);
      if (!child || child.phase === 'unknown') return [];
      const records = new Map(child.records);
      for (const record of child.projection?.records() ?? []) records.set(record.info.id, record);
      return [...records.values()];
    },
    childrenOf(id) {
      return [...children.values()]
        .filter((child) => child.session.parentID === id)
        .map((child) => child.session);
    },
    busyIds(directory) {
      return [...children.values()]
        .filter((child) => child.phase === 'running' && child.session.directory === directory)
        .map((child) => child.session.id);
    },
    clear() {
      clearInterval(activityTimer);
      activityTimer = undefined;
      watched.clear();
      children.clear();
    },
  };
};
