// Publishes live native session state as the OpenCode events the UI reducer
// already handles. Records are compared with what was last published for the
// session, so a projector can hand over a whole turn after every change and
// only the messages and parts that changed go out. Streamed text goes out as
// `message.part.delta`, never as repeated whole parts.
//
// Events carry copies: projectors keep mutating their records, and the hub
// serializes an event later, after delta coalescing.

/**
 * @param {object} options
 * @param {(event: { directory: string, payload: { id: string, type: string, properties: object } }) => void} options.publishNativeEvent
 * @param {() => number} [options.now]
 */
export const createNativeEventPublisher = ({ publishNativeEvent, now = Date.now }) => {
  let sequence = 0;
  /** @type {Map<string, Map<string, string>>} session id → record key → published JSON */
  const published = new Map();

  const emit = (directory, type, properties) => {
    sequence += 1;
    publishNativeEvent({ directory, payload: { id: `ncevt_${now()}_${sequence}`, type, properties } });
  };

  /** A copy of `value` when it differs from what was last published, else null. */
  const changedCopy = (sessionId, key, value) => {
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
    /** Publishes one event of any type, such as the question registry's. */
    emit(directory, type, properties) {
      emit(directory, type, structuredClone(properties));
    },

    /**
     * Publishes the messages and parts of `records` that differ from what was
     * last published for the session, message before its parts.
     * @param {string} directory
     * @param {string} sessionId
     * @param {Iterable<{ info: { id: string }, parts: Array<{ id: string }> }>} records
     */
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

    /**
     * Appends streamed text to a part the UI already holds. The caller keeps
     * its own copy of the part current; the next whole-part publish carries
     * the accumulated text.
     */
    delta(directory, { sessionID, messageID, partID, field, delta }) {
      if (delta === '') return;
      emit(directory, 'message.part.delta', { sessionID, messageID, partID, field, delta });
    },

    /** @param {'busy' | 'idle'} type */
    status(directory, sessionID, type) {
      emit(directory, 'session.status', { sessionID, status: { type } });
      if (type === 'idle') emit(directory, 'session.idle', { sessionID });
    },

    error(directory, sessionID, error) {
      emit(directory, 'session.error', { sessionID, error: structuredClone(error) });
    },

    /** @param {{ id: string }} info */
    session(directory, info, { created }) {
      emit(directory, created ? 'session.created' : 'session.updated', { sessionID: info.id, info: structuredClone(info) });
    },

    /** Announces a deleted session and forgets what was published for it. */
    sessionDeleted(directory, info) {
      emit(directory, 'session.deleted', { sessionID: info.id, info: structuredClone(info) });
      published.delete(info.id);
    },

    todos(directory, sessionID, todos) {
      emit(directory, 'todo.updated', { sessionID, todos: structuredClone(todos) });
    },

    /** Drops what was published for a session whose live state ended. */
    forget(sessionId) {
      published.delete(sessionId);
    },
  };
};
