import { createHash, randomUUID } from 'node:crypto';

// Native CLI sessions live in their own id namespace, so every layer can tell
// them apart from OpenCode sessions without a lookup. The UI mirrors these
// rules in packages/ui/src/lib/native-agents/ids.ts.
//
// Single-CLI session ids round-trip to the CLI's own id. Unified ncv_<uuid>
// conversations resolve their native sources through conversation manifests:
//   Claude Code  ncl_<session uuid>             (subagent: ncl_<uuid>_t_<tool_use id>)
//   Codex        ncx_<thread id>                (subagent threads use their own thread id)
// Message and part ids are derived deterministically from native keys, so a
// live event and a later history read name the same record.

export const NATIVE_BACKEND_CLAUDE = 'claude';
export const NATIVE_BACKEND_CODEX = 'codex';
export const NATIVE_BACKEND_DEEPSEEK = 'deepseek';
export const NATIVE_BACKEND_ANTIGRAVITY = 'antigravity';

export const NATIVE_PROVIDER_CLAUDE = 'claude-native';
export const NATIVE_PROVIDER_CODEX = 'codex-native';
export const NATIVE_PROVIDER_DEEPSEEK = 'deepseek-native';
export const NATIVE_PROVIDER_ANTIGRAVITY = 'antigravity-native';

const CLAUDE_SESSION_PREFIX = 'ncl_';
const CODEX_SESSION_PREFIX = 'ncx_';
const DEEPSEEK_SESSION_PREFIX = 'ndh_';
const ANTIGRAVITY_SESSION_PREFIX = 'nag_';
const CODEX_PLAN_APPROVAL_PREFIX = 'ncx_u_plan_';
const CLAUDE_CHILD_SEPARATOR = '_t_';

// Charset and length accepted by every OpenChamber route that carries a
// session id (the message-queue pattern is the strictest).
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const NATIVE_SESSION_ID_PATTERN = /^(?:nc[lxv]|ndh|nag)_/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {string} sessionId */
export const isNativeSessionId = (sessionId) => NATIVE_SESSION_ID_PATTERN.test(sessionId);
export const isUnifiedNativeSessionId = (sessionId) => /^ncv_[0-9a-f-]{36}$/.test(sessionId);

/**
 * @param {string} sessionId
 * @returns {'claude' | 'codex' | 'deepseek' | null}
 */
export const nativeBackendOfSessionId = (sessionId) => {
  if (sessionId.startsWith(CLAUDE_SESSION_PREFIX)) return NATIVE_BACKEND_CLAUDE;
  if (sessionId.startsWith(CODEX_SESSION_PREFIX)) return NATIVE_BACKEND_CODEX;
  if (sessionId.startsWith(DEEPSEEK_SESSION_PREFIX)) return NATIVE_BACKEND_DEEPSEEK;
  if (sessionId.startsWith(ANTIGRAVITY_SESSION_PREFIX)) return NATIVE_BACKEND_ANTIGRAVITY;
  return null;
};

/** @param {string} providerId */
export const nativeBackendOfProviderId = (providerId) => {
  if (providerId === NATIVE_PROVIDER_CLAUDE) return NATIVE_BACKEND_CLAUDE;
  if (providerId === NATIVE_PROVIDER_CODEX) return NATIVE_BACKEND_CODEX;
  if (providerId === NATIVE_PROVIDER_DEEPSEEK) return NATIVE_BACKEND_DEEPSEEK;
  if (providerId === NATIVE_PROVIDER_ANTIGRAVITY) return NATIVE_BACKEND_ANTIGRAVITY;
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

/** Antigravity conversation ids use the same UUID route shape. */
export const encodeAntigravitySessionId = (conversationId) => {
  if (!UUID_PATTERN.test(conversationId)) throw new Error(`Not an Antigravity conversation uuid: ${conversationId}`);
  return assertSessionId(`${ANTIGRAVITY_SESSION_PREFIX}${conversationId}`);
};

// DSH identities are opaque and may exceed the route's length or charset.
// The registry retains the original identity; hashing keeps every route bounded.
export const encodeDeepseekSessionId = (nativeId) => assertSessionId(
  `${DEEPSEEK_SESSION_PREFIX}${createHash('sha256').update(nativeId).digest('hex')}`,
);

/**
 * @typedef {{ backend: 'claude', sessionUuid: string, toolUseId: string | null }
 *   | { backend: 'codex', threadId: string }
 *   | { backend: 'deepseek', key: string }
 *   | { backend: 'antigravity', conversationId: string }} NativeSessionRef
 */

/**
 * Resolves an OpenChamber session id to the CLI's own identifiers, or null
 * when the id is not a well-formed native session id.
 * @param {string} sessionId
 * @returns {NativeSessionRef | null}
 */
export const decodeNativeSessionId = (sessionId) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  if (/^ndh_[0-9a-f]{64}$/.test(sessionId)) {
    return { backend: NATIVE_BACKEND_DEEPSEEK, key: sessionId.slice(DEEPSEEK_SESSION_PREFIX.length) };
  }
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
  if (sessionId.startsWith(ANTIGRAVITY_SESSION_PREFIX)) {
    const conversationId = sessionId.slice(ANTIGRAVITY_SESSION_PREFIX.length);
    if (!UUID_PATTERN.test(conversationId)) return null;
    return { backend: NATIVE_BACKEND_ANTIGRAVITY, conversationId };
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
//   user message       the clientUserMessageId OpenChamber sent (ncx_u_<uuid>,
//                      or ncx_u_plan_<uuid> for an automatic plan approval),
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

/** Approval provenance travels with Codex's persisted user-item clientId. */
export const newCodexPlanApprovalMessageId = () => `${CODEX_PLAN_APPROVAL_PREFIX}${randomUUID()}`;

/** @param {string} messageId */
export const isCodexPlanApprovalMessageId = (messageId) => (
  messageId.startsWith(CODEX_PLAN_APPROVAL_PREFIX) && UUID_PATTERN.test(messageId.slice(CODEX_PLAN_APPROVAL_PREFIX.length))
);

/** A client-generated user message id OpenChamber sends with a native prompt. */
export const isNativeClientUserMessageId = (messageId) => (
  /^(?:nc[lx]_u_|nag_u_|ndh_u_[0-9a-f]{24}_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
  || isCodexPlanApprovalMessageId(messageId)
);

/** A new id for a prompt OpenChamber's server sends to a native session itself. */
export const newNativeClientUserMessageId = (sessionId) => {
  if (isUnifiedNativeSessionId(sessionId)) return `ncv_u_${randomUUID()}`;
  const backend = nativeBackendOfSessionId(sessionId);
  if (!backend) throw new Error(`Not a native session: ${sessionId}`);
  if (backend === NATIVE_BACKEND_DEEPSEEK) return `ndh_u_${sessionId.slice(4, 28)}_${randomUUID()}`;
  const prefix = { claude: CLAUDE_SESSION_PREFIX, codex: CODEX_SESSION_PREFIX, deepseek: DEEPSEEK_SESSION_PREFIX, antigravity: ANTIGRAVITY_SESSION_PREFIX }[backend];
  return `${prefix}u_${randomUUID()}`;
};

export const userTextPartId = (messageId, index) => `${messageId}_p${index}`;
export const userFilePartId = (messageId, index) => `${messageId}_f${index}`;
export const blockPartId = (messageId, index) => `${messageId}_b${index}`;
export const toolPartId = (messageId, toolUseId) => `${messageId}_t_${toolUseId}`;
