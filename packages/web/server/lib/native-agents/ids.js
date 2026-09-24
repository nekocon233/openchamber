import { createHash, randomUUID } from 'node:crypto';

// Native CLI sessions live in their own id namespace, so every layer can tell
// them apart from OpenCode sessions without a lookup. The UI mirrors these
// rules in packages/ui/src/lib/native-agents/ids.ts.
//
// Session ids round-trip to the CLI's own id:
//   Claude Code  ncl_<session uuid>             (subagent: ncl_<uuid>_t_<tool_use id>)
//   Codex        ncx_<thread id>                (subagent threads use their own thread id)
// Message and part ids are derived deterministically from native keys, so a
// live event and a later history read name the same record.

export const NATIVE_BACKEND_CLAUDE = 'claude';
export const NATIVE_BACKEND_CODEX = 'codex';

export const NATIVE_PROVIDER_CLAUDE = 'claude-native';
export const NATIVE_PROVIDER_CODEX = 'codex-native';

const CLAUDE_SESSION_PREFIX = 'ncl_';
const CODEX_SESSION_PREFIX = 'ncx_';
const CLAUDE_CHILD_SEPARATOR = '_t_';

// Charset and length accepted by every OpenChamber route that carries a
// session id (the message-queue pattern is the strictest).
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const NATIVE_SESSION_ID_PATTERN = /^nc[lx]_/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {string} sessionId */
export const isNativeSessionId = (sessionId) => NATIVE_SESSION_ID_PATTERN.test(sessionId);

/**
 * @param {string} sessionId
 * @returns {'claude' | 'codex' | null}
 */
export const nativeBackendOfSessionId = (sessionId) => {
  if (sessionId.startsWith(CLAUDE_SESSION_PREFIX)) return NATIVE_BACKEND_CLAUDE;
  if (sessionId.startsWith(CODEX_SESSION_PREFIX)) return NATIVE_BACKEND_CODEX;
  return null;
};

/** @param {string} providerId */
export const nativeBackendOfProviderId = (providerId) => {
  if (providerId === NATIVE_PROVIDER_CLAUDE) return NATIVE_BACKEND_CLAUDE;
  if (providerId === NATIVE_PROVIDER_CODEX) return NATIVE_BACKEND_CODEX;
  return null;
};

const assertSessionId = (sessionId) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Native session id is outside the accepted charset or length: ${sessionId}`);
  }
  return sessionId;
};

/** @param {string} uuid Claude Code session id */
export const encodeClaudeSessionId = (uuid) => {
  if (!UUID_PATTERN.test(uuid)) throw new Error(`Not a Claude session uuid: ${uuid}`);
  return assertSessionId(`${CLAUDE_SESSION_PREFIX}${uuid}`);
};

/**
 * @param {string} parentUuid Claude Code session id of the parent
 * @param {string} toolUseId id of the Agent/Task tool_use that spawned the subagent
 */
export const encodeClaudeChildSessionId = (parentUuid, toolUseId) => {
  if (!UUID_PATTERN.test(parentUuid)) throw new Error(`Not a Claude session uuid: ${parentUuid}`);
  if (!TOOL_USE_ID_PATTERN.test(toolUseId)) throw new Error(`Not a Claude tool_use id: ${toolUseId}`);
  return assertSessionId(`${CLAUDE_SESSION_PREFIX}${parentUuid}${CLAUDE_CHILD_SEPARATOR}${toolUseId}`);
};

/** @param {string} threadId Codex thread id */
export const encodeCodexSessionId = (threadId) => {
  if (!UUID_PATTERN.test(threadId)) throw new Error(`Not a Codex thread id: ${threadId}`);
  return assertSessionId(`${CODEX_SESSION_PREFIX}${threadId}`);
};

/**
 * @typedef {{ backend: 'claude', sessionUuid: string, toolUseId: string | null }
 *   | { backend: 'codex', threadId: string }} NativeSessionRef
 */

/**
 * Resolves an OpenChamber session id to the CLI's own identifiers, or null
 * when the id is not a well-formed native session id.
 * @param {string} sessionId
 * @returns {NativeSessionRef | null}
 */
export const decodeNativeSessionId = (sessionId) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  if (sessionId.startsWith(CLAUDE_SESSION_PREFIX)) {
    const rest = sessionId.slice(CLAUDE_SESSION_PREFIX.length);
    const sessionUuid = rest.slice(0, 36);
    if (!UUID_PATTERN.test(sessionUuid)) return null;
    const suffix = rest.slice(36);
    if (suffix === '') return { backend: NATIVE_BACKEND_CLAUDE, sessionUuid, toolUseId: null };
    if (!suffix.startsWith(CLAUDE_CHILD_SEPARATOR)) return null;
    const toolUseId = suffix.slice(CLAUDE_CHILD_SEPARATOR.length);
    if (!TOOL_USE_ID_PATTERN.test(toolUseId)) return null;
    return { backend: NATIVE_BACKEND_CLAUDE, sessionUuid, toolUseId };
  }
  if (sessionId.startsWith(CODEX_SESSION_PREFIX)) {
    const threadId = sessionId.slice(CODEX_SESSION_PREFIX.length);
    if (!UUID_PATTERN.test(threadId)) return null;
    return { backend: NATIVE_BACKEND_CODEX, threadId };
  }
  return null;
};

// Message and part ids ---------------------------------------------------------
//
// Claude Code:
//   user message       ncl_u_<entry uuid>             (OpenChamber sends the uuid itself)
//   assistant message  ncl_a_<SK>_<API message id>    (SK namespaces by session: forks copy API ids)
//   text/reasoning     <assistant id>_b<content block index>
//   tool               <assistant id>_t_<tool_use id>
// Codex:
//   user message       the clientUserMessageId OpenChamber sent (ncx_u_<uuid>),
//                      else ncx_u_<TK>_<item id> for messages typed elsewhere
//   assistant message  ncx_a_<TK>_<turn id>, or ncx_a_<TK>_<user item id> after a steer
//   compaction         ncx_k_<TK>_<item id>
//   parts              ncx_p_<TK>_<item id>
// User message parts use <user id>_p<k> for text and <user id>_f<k> for files.

const sessionKey = (sessionId) => createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
const threadKey = (threadId) => threadId.replaceAll('-', '');

export const claudeUserMessageId = (entryUuid) => `${CLAUDE_SESSION_PREFIX}u_${entryUuid}`;

/** @param {string} messageId */
export const claudeEntryUuidOfUserMessageId = (messageId) => {
  const prefix = `${CLAUDE_SESSION_PREFIX}u_`;
  if (!messageId.startsWith(prefix)) return null;
  const uuid = messageId.slice(prefix.length);
  return UUID_PATTERN.test(uuid) ? uuid : null;
};

/**
 * @param {string} sessionId OpenChamber id of the session the message belongs to
 * @param {string} apiMessageId
 */
export const claudeAssistantMessageId = (sessionId, apiMessageId) => `${CLAUDE_SESSION_PREFIX}a_${sessionKey(sessionId)}_${apiMessageId}`;

export const codexUserMessageIdForItem = (threadId, itemId) => `${CODEX_SESSION_PREFIX}u_${threadKey(threadId)}_${itemId}`;

export const codexAssistantMessageId = (threadId, segmentKey) => `${CODEX_SESSION_PREFIX}a_${threadKey(threadId)}_${segmentKey}`;

export const codexPartId = (threadId, itemId) => `${CODEX_SESSION_PREFIX}p_${threadKey(threadId)}_${itemId}`;

export const codexCompactionMessageId = (threadId, itemId) => `${CODEX_SESSION_PREFIX}k_${threadKey(threadId)}_${itemId}`;

/** A client-generated user message id OpenChamber sends with a native prompt. */
export const isNativeClientUserMessageId = (messageId) => /^nc[lx]_u_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId);

/** A new id for a prompt OpenChamber's server sends to a native session itself. */
export const newNativeClientUserMessageId = (sessionId) => {
  const backend = nativeBackendOfSessionId(sessionId);
  if (!backend) throw new Error(`Not a native session: ${sessionId}`);
  return `${backend === NATIVE_BACKEND_CLAUDE ? CLAUDE_SESSION_PREFIX : CODEX_SESSION_PREFIX}u_${randomUUID()}`;
};

export const userTextPartId = (messageId, index) => `${messageId}_p${index}`;
export const userFilePartId = (messageId, index) => `${messageId}_f${index}`;
export const blockPartId = (messageId, index) => `${messageId}_b${index}`;
export const toolPartId = (messageId, toolUseId) => `${messageId}_t_${toolUseId}`;
