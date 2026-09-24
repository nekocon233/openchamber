// Native CLI sessions (Claude Code, Codex) live in their own id namespace, so
// every layer can tell them from OpenCode sessions by id alone. The server
// defines the same rules in packages/web/server/lib/native-agents/ids.js.

export type NativeBackend = 'claude' | 'codex';

export const NATIVE_PROVIDER_CLAUDE = 'claude-native';
export const NATIVE_PROVIDER_CODEX = 'codex-native';

const SESSION_PREFIX = {
  claude: 'ncl_',
  codex: 'ncx_',
} satisfies Record<NativeBackend, string>;

export const isNativeSessionId = (sessionId: string): boolean => /^nc[lx]_/.test(sessionId);

export const nativeBackendOfSessionId = (sessionId: string): NativeBackend | null => {
  if (sessionId.startsWith(SESSION_PREFIX.claude)) return 'claude';
  if (sessionId.startsWith(SESSION_PREFIX.codex)) return 'codex';
  return null;
};

export const nativeBackendOfProviderId = (providerId: string): NativeBackend | null => {
  if (providerId === NATIVE_PROVIDER_CLAUDE) return 'claude';
  if (providerId === NATIVE_PROVIDER_CODEX) return 'codex';
  return null;
};

export const isNativeProviderId = (providerId: string): boolean => nativeBackendOfProviderId(providerId) !== null;

export const nativeProviderIdOf = (backend: NativeBackend): string => (
  backend === 'claude' ? NATIVE_PROVIDER_CLAUDE : NATIVE_PROVIDER_CODEX
);

/**
 * Whether the model picker offers a provider for a session. A session keeps
 * its CLI: a native session offers only its own CLI and an OpenCode session no
 * native one. A new session (null) offers every provider, because the model
 * picked decides which kind it becomes.
 */
export const isProviderPickableForSession = (sessionId: string | null, providerId: string): boolean => {
  if (!sessionId) return true;
  const backend = nativeBackendOfSessionId(sessionId);
  return backend ? nativeBackendOfProviderId(providerId) === backend : !isNativeProviderId(providerId);
};

/** The agents a native CLI runs as: a build agent, or plan mode. */
export const NATIVE_AGENT_NAMES: ReadonlySet<string> = new Set(['build', 'plan']);

// crypto.randomUUID exists only in secure contexts; a server reached over
// plain http on a LAN address is not one, while getRandomValues always is.
const randomUuid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Id for a user message OpenChamber sends to a native session. The CLI keeps
 * it (Claude as the transcript entry uuid, Codex as the client message id), so
 * the optimistic message and the one read back from history match.
 */
export const createNativeUserMessageId = (backend: NativeBackend): string => `${SESSION_PREFIX[backend]}u_${randomUuid()}`;

const USER_MESSAGE_ID = /^nc[lx]_u_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `messageId` is a user message id the backend's CLI can record. */
export const isNativeUserMessageIdFor = (backend: NativeBackend, messageId: string): boolean => (
  messageId.startsWith(`${SESSION_PREFIX[backend]}u_`) && USER_MESSAGE_ID.test(messageId)
);
