import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { countSyncPersistenceSerialization } from '@/sync/performance-diagnostics';

export type ChatDraftIdentity = {
  runtimeKey: string;
  directory: string;
  sessionId: string | null;
};

export type ChatDraftSnapshot = {
  text: string;
  confirmedMentions: Set<string>;
};

type PersistedChatDraft = {
  text: string;
  confirmedMentions: string[];
  touchedAt: number;
};

type PersistedChatDraftEnvelope = {
  version: 2;
  drafts: Record<string, PersistedChatDraft>;
};

const STORAGE_KEY = 'openchamber.chatDrafts.v2';
const LEGACY_LOCAL_PREFIX = 'oc.chatDraft.local.v2';
const LEGACY_COORDINATOR_PREFIX = 'oc.chatDraft.v1';
const MAX_DRAFTS = 50;
const storage = getDeferredSafeStorage();
const deletionListeners = new Set<(identity: ChatDraftIdentity) => void>();
let cachedRawEnvelope: string | null | undefined;
let cachedEnvelope: PersistedChatDraftEnvelope | undefined;

export const createChatDraftIdentity = (
  runtimeKey: string,
  directory: string | null | undefined,
  sessionId: string | null,
): ChatDraftIdentity | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory) return null;
  return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string =>
  JSON.stringify([identity.runtimeKey, identity.directory, identity.sessionId]);

const getLegacyScope = (sessionId: string | null): string => sessionId ? `session:${sessionId}` : 'new';

const getLegacyScopedKey = (prefix: string, identity: ChatDraftIdentity): string => (
  `${prefix}:${encodeURIComponent(identity.runtimeKey)}:${encodeURIComponent(getLegacyScope(identity.sessionId))}`
);

const getLegacyTextKey = (sessionId: string | null): string => (
  `openchamber_chat_input_draft_${sessionId ?? 'new'}`
);

const getLegacyMentionsKey = (sessionId: string | null): string => (
  `openchamber_chat_confirmed_mentions_${sessionId ?? 'new'}`
);

const parseLegacyDraft = (raw: string | null): (ChatDraftSnapshot & { touchedAt: number }) | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      !value
      || typeof value !== 'object'
      || typeof value.text !== 'string'
      || !Array.isArray(value.confirmedMentions)
    ) return null;
    return {
      text: value.text,
      confirmedMentions: new Set(value.confirmedMentions.filter((mention): mention is string => typeof mention === 'string')),
      touchedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    };
  } catch {
    return null;
  }
};

const readLegacyDraft = (identity: ChatDraftIdentity): ChatDraftSnapshot | null => {
  const scoped = [
    parseLegacyDraft(storage.getItem(getLegacyScopedKey(LEGACY_LOCAL_PREFIX, identity))),
    parseLegacyDraft(storage.getItem(getLegacyScopedKey(LEGACY_COORDINATOR_PREFIX, identity))),
  ].filter((draft): draft is ChatDraftSnapshot & { touchedAt: number } => draft !== null)
    .sort((left, right) => right.touchedAt - left.touchedAt)[0];
  if (scoped) return { text: scoped.text, confirmedMentions: scoped.confirmedMentions };

  const text = storage.getItem(getLegacyTextKey(identity.sessionId));
  const mentionsRaw = storage.getItem(getLegacyMentionsKey(identity.sessionId));
  if (text === null && mentionsRaw === null) return null;
  let mentions: string[] = [];
  try {
    const parsed = JSON.parse(mentionsRaw ?? '[]') as unknown;
    if (Array.isArray(parsed)) mentions = parsed.filter((mention): mention is string => typeof mention === 'string');
  } catch {
    mentions = [];
  }
  return { text: text ?? '', confirmedMentions: new Set(mentions) };
};

const removeLegacyDraft = (identity: ChatDraftIdentity): void => {
  storage.removeItem(getLegacyScopedKey(LEGACY_LOCAL_PREFIX, identity));
  storage.removeItem(getLegacyScopedKey(LEGACY_COORDINATOR_PREFIX, identity));
  storage.removeItem(getLegacyTextKey(identity.sessionId));
  storage.removeItem(getLegacyMentionsKey(identity.sessionId));
};

const readEnvelope = (): PersistedChatDraftEnvelope => {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === cachedRawEnvelope && cachedEnvelope) return cachedEnvelope;
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<PersistedChatDraftEnvelope>;
    if (parsed.version !== 2 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) {
      cachedRawEnvelope = raw;
      cachedEnvelope = { version: 2, drafts: {} };
      return cachedEnvelope;
    }
    const drafts: Record<string, PersistedChatDraft> = {};
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!value || typeof value !== 'object') continue;
      const draft = value as Partial<PersistedChatDraft>;
      if (typeof draft.text !== 'string' || !Array.isArray(draft.confirmedMentions) || typeof draft.touchedAt !== 'number') continue;
      drafts[key] = {
        text: draft.text,
        confirmedMentions: draft.confirmedMentions.filter((mention): mention is string => typeof mention === 'string'),
        touchedAt: draft.touchedAt,
      };
    }
    cachedRawEnvelope = raw;
    cachedEnvelope = { version: 2, drafts };
    return cachedEnvelope;
  } catch {
    storage.removeItem(STORAGE_KEY);
    cachedRawEnvelope = null;
    cachedEnvelope = { version: 2, drafts: {} };
    return cachedEnvelope;
  }
};

const writeEnvelope = (envelope: PersistedChatDraftEnvelope): void => {
  const serialized = JSON.stringify(envelope);
  cachedRawEnvelope = serialized;
  cachedEnvelope = envelope;
  countSyncPersistenceSerialization(serialized);
  storage.setItem(STORAGE_KEY, serialized);
};

export const readChatDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  if (!identity) return { text: '', confirmedMentions: new Set() };
  const persisted = readEnvelope().drafts[getChatDraftIdentityKey(identity)];
  if (persisted) return { text: persisted.text, confirmedMentions: new Set(persisted.confirmedMentions) };

  const legacy = readLegacyDraft(identity);
  if (!legacy) return { text: '', confirmedMentions: new Set() };
  persistChatDraft(identity, legacy.text, legacy.confirmedMentions, false);
  return legacy;
};

const persistChatDraft = (
  identity: ChatDraftIdentity | null,
  text: string,
  confirmedMentions: Iterable<string>,
  clearLegacy: boolean,
): void => {
  if (!identity) return;
  const envelope = readEnvelope();
  const key = getChatDraftIdentityKey(identity);
  const mentions = Array.from(new Set(confirmedMentions));
  if (!text && mentions.length === 0) {
    if (!(key in envelope.drafts)) return;
    delete envelope.drafts[key];
  } else {
    envelope.drafts[key] = { text, confirmedMentions: mentions, touchedAt: Date.now() };
  }

  const retained = Object.entries(envelope.drafts)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_DRAFTS);
  writeEnvelope({ version: 2, drafts: Object.fromEntries(retained) });
  if (clearLegacy) removeLegacyDraft(identity);
};

export const writeChatDraft = (
  identity: ChatDraftIdentity | null,
  text: string,
  confirmedMentions: Iterable<string>,
): void => persistChatDraft(identity, text, confirmedMentions, true);

export const clearChatDraft = (identity: ChatDraftIdentity, notify = false): void => {
  writeChatDraft(identity, '', []);
  if (notify) deletionListeners.forEach((listener) => listener(identity));
};

export const subscribeChatDraftDeletion = (listener: (identity: ChatDraftIdentity) => void): (() => void) => {
  deletionListeners.add(listener);
  return () => deletionListeners.delete(listener);
};
