import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const NATIVE_BACKEND_CLAUDE = 'claude';
export const NATIVE_BACKEND_CODEX = 'codex';
export const NATIVE_BACKEND_DEEPSEEK = 'deepseek';
export const NATIVE_BACKEND_ANTIGRAVITY = 'antigravity';

export const nativeBackendSchema = z.enum([
  NATIVE_BACKEND_CLAUDE,
  NATIVE_BACKEND_CODEX,
  NATIVE_BACKEND_DEEPSEEK,
  NATIVE_BACKEND_ANTIGRAVITY,
]);
export type NativeBackend = z.infer<typeof nativeBackendSchema>;
export const NATIVE_BACKENDS = nativeBackendSchema.options;

export const NATIVE_PROVIDER_CLAUDE = 'claude-native';
export const NATIVE_PROVIDER_CODEX = 'codex-native';
export const NATIVE_PROVIDER_DEEPSEEK = 'deepseek-native';
export const NATIVE_PROVIDER_ANTIGRAVITY = 'antigravity-native';

export const nativeProviderSchema = z.enum([
  NATIVE_PROVIDER_CLAUDE,
  NATIVE_PROVIDER_CODEX,
  NATIVE_PROVIDER_DEEPSEEK,
  NATIVE_PROVIDER_ANTIGRAVITY,
]);
export type NativeProviderId = z.infer<typeof nativeProviderSchema>;

const CLAUDE_SESSION_PREFIX = 'ncl_';
const CODEX_SESSION_PREFIX = 'ncx_';
const DEEPSEEK_SESSION_PREFIX = 'ndh_';
const ANTIGRAVITY_SESSION_PREFIX = 'nag_';
const CODEX_PLAN_APPROVAL_PREFIX = 'ncx_u_plan_';
const CLAUDE_CHILD_SEPARATOR = '_t_';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const NATIVE_SESSION_ID_PATTERN = /^(?:nc[lxv]|ndh|nag)_/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isNativeSessionId = (sessionId: string): boolean => NATIVE_SESSION_ID_PATTERN.test(sessionId);
export const isUnifiedNativeSessionId = (sessionId: string): boolean => /^ncv_[0-9a-f-]{36}$/.test(sessionId);

export const nativeBackendOfSessionId = (sessionId: string): NativeBackend | null => {
  if (sessionId.startsWith(CLAUDE_SESSION_PREFIX)) return NATIVE_BACKEND_CLAUDE;
  if (sessionId.startsWith(CODEX_SESSION_PREFIX)) return NATIVE_BACKEND_CODEX;
  if (sessionId.startsWith(DEEPSEEK_SESSION_PREFIX)) return NATIVE_BACKEND_DEEPSEEK;
  if (sessionId.startsWith(ANTIGRAVITY_SESSION_PREFIX)) return NATIVE_BACKEND_ANTIGRAVITY;
  return null;
};

export const nativeBackendOfProviderId = (providerId: string | null | undefined): NativeBackend | null => {
  if (providerId === NATIVE_PROVIDER_CLAUDE) return NATIVE_BACKEND_CLAUDE;
  if (providerId === NATIVE_PROVIDER_CODEX) return NATIVE_BACKEND_CODEX;
  if (providerId === NATIVE_PROVIDER_DEEPSEEK) return NATIVE_BACKEND_DEEPSEEK;
  if (providerId === NATIVE_PROVIDER_ANTIGRAVITY) return NATIVE_BACKEND_ANTIGRAVITY;
  return null;
};

const assertSessionId = (sessionId: string): string => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Native session id is outside the accepted charset or length: ${sessionId}`);
  }
  return sessionId;
};

export const encodeClaudeSessionId = (uuid: string): string => {
  if (!UUID_PATTERN.test(uuid)) throw new Error(`Not a Claude session uuid: ${uuid}`);
  return assertSessionId(`${CLAUDE_SESSION_PREFIX}${uuid}`);
};

export const encodeClaudeChildSessionId = (parentUuid: string, toolUseId: string): string => {
  if (!UUID_PATTERN.test(parentUuid)) throw new Error(`Not a Claude session uuid: ${parentUuid}`);
  if (!TOOL_USE_ID_PATTERN.test(toolUseId)) throw new Error(`Not a Claude tool_use id: ${toolUseId}`);
  return assertSessionId(`${CLAUDE_SESSION_PREFIX}${parentUuid}${CLAUDE_CHILD_SEPARATOR}${toolUseId}`);
};

export const encodeCodexSessionId = (threadId: string): string => {
  if (!UUID_PATTERN.test(threadId)) throw new Error(`Not a Codex thread id: ${threadId}`);
  return assertSessionId(`${CODEX_SESSION_PREFIX}${threadId}`);
};

export const encodeAntigravitySessionId = (conversationId: string): string => {
  if (!UUID_PATTERN.test(conversationId)) throw new Error(`Not an Antigravity conversation uuid: ${conversationId}`);
  return assertSessionId(`${ANTIGRAVITY_SESSION_PREFIX}${conversationId}`);
};

export const encodeDeepseekSessionId = (nativeId: string): string => assertSessionId(
  `${DEEPSEEK_SESSION_PREFIX}${createHash('sha256').update(nativeId).digest('hex')}`,
);

export type NativeSessionRef =
  | { backend: typeof NATIVE_BACKEND_CLAUDE; sessionUuid: string; toolUseId: string | null }
  | { backend: typeof NATIVE_BACKEND_CODEX; threadId: string }
  | { backend: typeof NATIVE_BACKEND_DEEPSEEK; key: string }
  | { backend: typeof NATIVE_BACKEND_ANTIGRAVITY; conversationId: string };

export const decodeNativeSessionId = (sessionId: string): NativeSessionRef | null => {
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

const sessionKey = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
const threadKey = (threadId: string): string => threadId.replaceAll('-', '');

export const claudeUserMessageId = (entryUuid: string): string => `${CLAUDE_SESSION_PREFIX}u_${entryUuid}`;

export const claudeEntryUuidOfUserMessageId = (messageId: string): string | null => {
  const prefix = `${CLAUDE_SESSION_PREFIX}u_`;
  if (!messageId.startsWith(prefix)) return null;
  const uuid = messageId.slice(prefix.length);
  return UUID_PATTERN.test(uuid) ? uuid : null;
};

export const claudeAssistantMessageId = (sessionId: string, apiMessageId: string): string => `${CLAUDE_SESSION_PREFIX}a_${sessionKey(sessionId)}_${apiMessageId}`;

export const codexUserMessageIdForItem = (threadId: string, itemId: string): string => `${CODEX_SESSION_PREFIX}u_${threadKey(threadId)}_${itemId}`;

export const codexAssistantMessageId = (threadId: string, segmentKey: string): string => `${CODEX_SESSION_PREFIX}a_${threadKey(threadId)}_${segmentKey}`;

export const codexPartId = (threadId: string, itemId: string): string => `${CODEX_SESSION_PREFIX}p_${threadKey(threadId)}_${itemId}`;

export const codexCompactionMessageId = (threadId: string, itemId: string): string => `${CODEX_SESSION_PREFIX}k_${threadKey(threadId)}_${itemId}`;

export const newCodexPlanApprovalMessageId = (): string => `${CODEX_PLAN_APPROVAL_PREFIX}${randomUUID()}`;

export const isCodexPlanApprovalMessageId = (messageId: string): boolean => (
  messageId.startsWith(CODEX_PLAN_APPROVAL_PREFIX) && UUID_PATTERN.test(messageId.slice(CODEX_PLAN_APPROVAL_PREFIX.length))
);

export const isNativeClientUserMessageId = (messageId: string): boolean => (
  /^(?:nc[lx]_u_|nag_u_|ndh_u_[0-9a-f]{24}_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
  || isCodexPlanApprovalMessageId(messageId)
);

const BACKEND_SESSION_PREFIX = {
  claude: CLAUDE_SESSION_PREFIX,
  codex: CODEX_SESSION_PREFIX,
  deepseek: DEEPSEEK_SESSION_PREFIX,
  antigravity: ANTIGRAVITY_SESSION_PREFIX,
} satisfies Record<NativeBackend, string>;

export const newNativeClientUserMessageId = (sessionId: string): string => {
  if (isUnifiedNativeSessionId(sessionId)) return `ncv_u_${randomUUID()}`;
  const backend = nativeBackendOfSessionId(sessionId);
  if (!backend) throw new Error(`Not a native session: ${sessionId}`);
  if (backend === NATIVE_BACKEND_DEEPSEEK) return `ndh_u_${sessionId.slice(4, 28)}_${randomUUID()}`;
  const prefix = BACKEND_SESSION_PREFIX[backend];
  return `${prefix}u_${randomUUID()}`;
};

export const userTextPartId = (messageId: string, index: number): string => `${messageId}_p${index}`;
export const userFilePartId = (messageId: string, index: number): string => `${messageId}_f${index}`;
export const blockPartId = (messageId: string, index: number): string => `${messageId}_b${index}`;
export const toolPartId = (messageId: string, toolUseId: string): string => `${messageId}_t_${toolUseId}`;
