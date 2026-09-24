// Builders for the OpenCode-shaped records the UI renders (Session, Message,
// Part from @opencode-ai/sdk/v2). Native projectors produce these for both
// history reads and live events, so the two paths cannot drift apart.
//
// Rendering contract the builders encode (see packages/ui sync and chat docs):
// - an assistant message must carry parentID = its user message id;
// - text and reasoning parts need time.end once finished;
// - finished tool parts need state.time.end;
// - every part carries sessionID (a part without one is an optimistic placeholder).

/**
 * @param {object} input
 * @param {string} input.id
 * @param {'claude' | 'codex'} input.backend
 * @param {string} input.directory
 * @param {string} input.title
 * @param {number} input.created
 * @param {number} input.updated
 * @param {string | null} [input.parentID]
 * @param {number | null} [input.archived]
 */
export const buildSessionRecord = ({ id, backend, directory, title, created, updated, parentID = null, archived = null }) => {
  const time = archived === null ? { created, updated } : { created, updated, archived };
  const record = {
    id,
    slug: id,
    projectID: '',
    directory,
    title,
    version: `${backend}-cli`,
    time,
    metadata: { openchamber: { native: { backend } } },
  };
  if (parentID !== null) record.parentID = parentID;
  return record;
};

/**
 * The session record of a session OpenChamber created that the CLI has not
 * confirmed yet, so it may have no transcript.
 * @param {{ sessionId: string, backend: 'claude' | 'codex', directory: string, createdAt: number, title?: string, archivedAt?: number }} entry
 */
export const unconfirmedSessionRecord = (entry) => buildSessionRecord({
  id: entry.sessionId,
  backend: entry.backend,
  directory: entry.directory,
  title: entry.title ?? (entry.backend === 'claude' ? 'New Claude Code session' : 'New Codex session'),
  created: entry.createdAt,
  updated: entry.createdAt,
  archived: entry.archivedAt ?? null,
});

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {number} input.created
 * @param {string} input.agent
 * @param {{ providerID: string, modelID: string, variant?: string }} input.model
 */
export const buildUserMessage = ({ id, sessionID, created, agent, model }) => ({
  id,
  sessionID,
  role: 'user',
  time: { created },
  agent,
  model,
});

export const EMPTY_TOKENS = Object.freeze({ total: 0, input: 0, output: 0, reasoning: 0, cache: Object.freeze({ read: 0, write: 0 }) });

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {string} input.parentID
 * @param {number} input.created
 * @param {number | null} input.completed
 * @param {string} input.providerID
 * @param {string} input.modelID
 * @param {string} input.agent
 * @param {string} input.cwd
 * @param {{ total: number, input: number, output: number, reasoning: number, cache: { read: number, write: number } }} input.tokens
 * @param {string | null} [input.finish]
 * @param {string | null} [input.variant]
 * @param {{ name: string, data: { message: string } } | null} [input.error]
 * @param {boolean} [input.summary]
 */
export const buildAssistantMessage = ({
  id,
  sessionID,
  parentID,
  created,
  completed,
  providerID,
  modelID,
  agent,
  cwd,
  tokens,
  finish = null,
  variant = null,
  error = null,
  summary = false,
}) => {
  const message = {
    id,
    sessionID,
    role: 'assistant',
    time: completed === null ? { created } : { created, completed },
    parentID,
    modelID,
    providerID,
    mode: agent,
    agent,
    path: { cwd, root: cwd },
    cost: 0,
    tokens: {
      total: tokens.total,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.cache.read, write: tokens.cache.write },
    },
  };
  if (finish !== null) message.finish = finish;
  if (variant !== null) message.variant = variant;
  if (error !== null) message.error = error;
  if (summary) message.summary = true;
  return message;
};

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {string} input.messageID
 * @param {string} input.text
 * @param {number} input.start
 * @param {number | null} input.end null while the text is still streaming
 * @param {boolean} [input.synthetic]
 */
export const buildTextPart = ({ id, sessionID, messageID, text, start, end, synthetic = false }) => {
  const part = {
    id,
    sessionID,
    messageID,
    type: 'text',
    text,
    time: end === null ? { start } : { start, end },
  };
  if (synthetic) part.synthetic = true;
  return part;
};

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {string} input.messageID
 * @param {string} input.text
 * @param {number} input.start
 * @param {number | null} input.end null while reasoning is still streaming
 */
export const buildReasoningPart = ({ id, sessionID, messageID, text, start, end }) => ({
  id,
  sessionID,
  messageID,
  type: 'reasoning',
  text,
  time: end === null ? { start } : { start, end },
});

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {string} input.messageID
 * @param {string} input.mime
 * @param {string} input.url
 * @param {string} input.filename
 */
export const buildFilePart = ({ id, sessionID, messageID, mime, url, filename }) => ({
  id,
  sessionID,
  messageID,
  type: 'file',
  mime,
  url,
  filename,
});

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {string} input.messageID
 * @param {boolean} input.auto
 */
export const buildCompactionPart = ({ id, sessionID, messageID, auto }) => ({
  id,
  sessionID,
  messageID,
  type: 'compaction',
  auto,
});

/**
 * A tool part in one of three states. `result` absent means still running.
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.sessionID
 * @param {string} input.messageID
 * @param {string} input.callID
 * @param {string} input.tool OpenCode tool name the renderers know (bash, edit, task, ...)
 * @param {Record<string, unknown>} input.input
 * @param {string} input.title
 * @param {number} input.start
 * @param {Record<string, unknown>} input.metadata
 * @param {{ status: 'completed', output: string, end: number } | { status: 'error', error: string, end: number } | null} input.result
 */
export const buildToolPart = ({ id, sessionID, messageID, callID, tool, input, title, start, metadata, result }) => {
  let state;
  if (result === null) {
    state = { status: 'running', input, title, metadata, time: { start } };
  } else if (result.status === 'completed') {
    state = { status: 'completed', input, output: result.output, title, metadata, time: { start, end: result.end } };
  } else {
    state = { status: 'error', input, error: result.error, metadata, time: { start, end: result.end } };
  }
  return {
    id,
    sessionID,
    messageID,
    type: 'tool',
    callID,
    tool,
    state,
    metadata: { openchamber: { nativeTool: true } },
  };
};

// A turn the user stopped. The UI shows its own stopped notice for this exact
// shape, the one it writes itself when it settles an interrupted turn.
export const stoppedError = () => ({ name: 'MessageAbortedError', data: { message: 'aborted' } });
export const unknownError = (message) => ({ name: 'UnknownError', data: { message } });
