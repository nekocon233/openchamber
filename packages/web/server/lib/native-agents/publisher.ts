import type { JsonObject, JsonValue } from '../shared/json-values.js';

export type NativeEventPayload = {
  id: string;
  type: string;
  properties: JsonObject;
};

export type NativePublishedEvent = {
  directory: string;
  payload: NativeEventPayload;
};

export type NativeIdentifiableRecord = {
  id: string;
};

export type NativePublishableMessage = {
  info: NativeIdentifiableRecord;
  parts: ReadonlyArray<NativeIdentifiableRecord>;
};

export type NativePartDelta = {
  sessionID: string;
  messageID: string;
  partID: string;
  field: string;
  delta: string;
};

export type NativeBackgroundTaskSummary = {
  id: string;
  type: string;
  description: string;
};

export type NativeTodoSnapshotItem = {
  id: string;
  content: string;
  status: string;
};

export type NativeTodoSnapshot = {
  state: string;
  generation: string | null;
  revision: number;
  todos: NativeTodoSnapshotItem[];
};

export type NativeChecklistSnapshotItem = {
  id: string;
  subject: string;
  status: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
};

export type NativeChecklistSnapshot =
  | { state: 'unavailable'; reason: string }
  | {
    state: 'ready';
    identity: string;
    source: string;
    revision: number;
    observedAt: number;
    complete: boolean;
    unreadable: number;
    items: NativeChecklistSnapshotItem[];
  };

export type NativeTaskSnapshot = {
  state: string;
  generation: string | null;
  revision: number;
  tasks: NativeBackgroundTaskSummary[];
  omitted: number;
};

export type NativePublishedError = {
  name: string;
  data: { message: string };
};

export interface NativeEventPublisherOptions {
  publishNativeEvent: (event: NativePublishedEvent) => void;
  now?: (() => number) | undefined;
}

export interface NativeEventPublisher {
  part: (directory: string, sessionID: string, value: NativeIdentifiableRecord) => void;
  emit: (directory: string, type: string, properties: JsonObject) => void;
  records: (directory: string, sessionId: string, records: Iterable<NativePublishableMessage>) => void;
  delta: (directory: string, payload: NativePartDelta) => void;
  status: (directory: string, sessionID: string, type: 'busy' | 'idle') => void;
  error: (directory: string, sessionID: string, error: NativePublishedError) => void;
  session: (directory: string, info: NativeIdentifiableRecord, options: { created: boolean }) => void;
  sessionDeleted: (directory: string, info: NativeIdentifiableRecord) => void;
  todos: (directory: string, sessionID: string, snapshot: NativeTodoSnapshot) => void;
  backgroundTasks: (directory: string, sessionID: string, tasks: ReadonlyArray<NativeBackgroundTaskSummary>) => void;
  checklist: (directory: string, sessionID: string, snapshot: NativeChecklistSnapshot) => void;
  tasks: (directory: string, sessionID: string, snapshot: NativeTaskSnapshot) => void;
  forget: (sessionId: string) => void;
}

const cloneJson = (value: JsonValue): JsonValue => structuredClone(value);

export const createNativeEventPublisher = ({
  publishNativeEvent,
  now = Date.now,
}: NativeEventPublisherOptions): NativeEventPublisher => {
  let sequence = 0;
  const published = new Map<string, Map<string, string>>();

  const emit = (directory: string, type: string, properties: JsonObject): void => {
    sequence += 1;
    publishNativeEvent({ directory, payload: { id: `ncevt_${now()}_${sequence}`, type, properties } });
  };

  const changedCopy = (sessionId: string, key: string, value: JsonValue): JsonValue | null => {
    let session = published.get(sessionId);
    if (!session) {
      session = new Map();
      published.set(sessionId, session);
    }
    const json = JSON.stringify(value);
    if (session.get(key) === json) return null;
    session.set(key, json);
    return JSON.parse(json);
  };

  return {
    part(directory, sessionID, value) {
      const part = changedCopy(sessionID, `p:${value.id}`, value);
      if (part) emit(directory, 'message.part.updated', { sessionID, part, time: now() });
    },
    emit(directory, type, properties) {
      emit(directory, type, structuredClone(properties));
    },
    records(directory, sessionId, records) {
      for (const record of records) {
        const info = changedCopy(sessionId, `m:${record.info.id}`, record.info);
        if (info) emit(directory, 'message.updated', { sessionID: sessionId, info });
        for (const livePart of record.parts) {
          const part = changedCopy(sessionId, `p:${livePart.id}`, livePart);
          if (part) emit(directory, 'message.part.updated', { sessionID: sessionId, part, time: now() });
        }
      }
    },
    delta(directory, { sessionID, messageID, partID, field, delta }) {
      if (delta === '') return;
      emit(directory, 'message.part.delta', { sessionID, messageID, partID, field, delta });
    },
    status(directory, sessionID, type) {
      emit(directory, 'session.status', { sessionID, status: { type } });
      if (type === 'idle') emit(directory, 'session.idle', { sessionID });
    },
    error(directory, sessionID, error) {
      emit(directory, 'session.error', { sessionID, error: cloneJson(error) });
    },
    session(directory, info, { created }) {
      emit(directory, created ? 'session.created' : 'session.updated', { sessionID: info.id, info: cloneJson(info) });
    },
    sessionDeleted(directory, info) {
      emit(directory, 'session.deleted', { sessionID: info.id, info: cloneJson(info) });
      published.delete(info.id);
    },
    todos(directory, sessionID, snapshot) {
      emit(directory, 'session.todos.updated', { sessionID, snapshot: cloneJson(snapshot) });
    },
    backgroundTasks(directory, sessionID, tasks) {
      emit(directory, 'session.background.updated', { sessionID, tasks: cloneJson([...tasks]) });
    },
    checklist(directory, sessionID, snapshot) {
      emit(directory, 'session.checklist.updated', { sessionID, snapshot: cloneJson(snapshot) });
    },
    tasks(directory, sessionID, snapshot) {
      emit(directory, 'session.tasks.updated', { sessionID, snapshot: cloneJson(snapshot) });
    },
    forget(sessionId) {
      published.delete(sessionId);
    },
  };
};
