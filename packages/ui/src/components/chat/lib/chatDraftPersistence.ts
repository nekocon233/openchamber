import { getSafeStorage } from '@/stores/utils/safeStorage';

const CACHE_VERSION = 2;
const CACHE_PREFIX = 'oc.chatDraft.local.v2';
const OLD_CACHE_PREFIX = 'oc.chatDraft.v1';
const OLD_CLEAR_PREFIX = 'oc.chatDraftClear.v1';
const OLD_SUBMISSION_PREFIX = 'oc.chatDraftSubmissionClear.v1';

export type ChatDraftValue = {
  text: string;
  confirmedMentions: string[];
};

type StoredChatDraft = ChatDraftValue & {
  version: typeof CACHE_VERSION;
  generation: number;
  updatedAt: number;
};

type DraftLane = {
  value: ChatDraftValue;
  generation: number;
  dirty: boolean;
  listeners: Set<(value: ChatDraftValue) => void>;
};

export type ChatDraftSubmission = {
  generation: number;
};

export type ChatDraftPersistenceDependencies = {
  storage: Storage;
  now: () => number;
  verifyStorageWrite: (key: string, value: string) => boolean;
};

const defaultDependencies: ChatDraftPersistenceDependencies = {
  storage: getSafeStorage(),
  now: Date.now,
  verifyStorageWrite: (key, value) => {
    if (typeof window === 'undefined') return true;
    try {
      return window.localStorage.getItem(key) === value;
    } catch {
      return false;
    }
  },
};

const emptyValue = (): ChatDraftValue => ({ text: '', confirmedMentions: [] });
const cloneValue = (value: ChatDraftValue): ChatDraftValue => ({
  text: value.text,
  confirmedMentions: [...value.confirmedMentions],
});
const valuesEqual = (left: ChatDraftValue, right: ChatDraftValue): boolean => (
  left.text === right.text
  && left.confirmedMentions.length === right.confirmedMentions.length
  && left.confirmedMentions.every((mention, index) => mention === right.confirmedMentions[index])
);
const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);
const normalizeRuntimeKey = (runtimeKey: string): string => runtimeKey.trim() || 'default';
const scopeKey = (sessionId: string | null): string => sessionId ? `session:${sessionId}` : 'new';
const mapKey = (runtimeKey: string, sessionId: string | null): string => (
  `${normalizeRuntimeKey(runtimeKey)}\n${scopeKey(sessionId)}`
);
const storageKey = (runtimeKey: string, sessionId: string | null): string => (
  `${CACHE_PREFIX}:${encodeURIComponent(normalizeRuntimeKey(runtimeKey))}:${encodeURIComponent(scopeKey(sessionId))}`
);
const oldStorageKey = (prefix: string, runtimeKey: string, sessionId: string | null): string => (
  `${prefix}:${encodeURIComponent(normalizeRuntimeKey(runtimeKey))}:${encodeURIComponent(scopeKey(sessionId))}`
);
const legacyTextKey = (sessionId: string | null): string => (
  `openchamber_chat_input_draft_${sessionId ?? 'new'}`
);
const legacyMentionsKey = (sessionId: string | null): string => (
  `openchamber_chat_confirmed_mentions_${sessionId ?? 'new'}`
);

const parseValue = (value: unknown): ChatDraftValue | null => {
  if (
    !isRecord(value)
    || typeof value.text !== 'string'
    || !Array.isArray(value.confirmedMentions)
    || !value.confirmedMentions.every((entry) => typeof entry === 'string')
  ) return null;
  return { text: value.text, confirmedMentions: [...value.confirmedMentions] as string[] };
};

const parseStored = (raw: string | null): StoredChatDraft | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    const draft = parseValue(value);
    if (
      !draft
      || !isRecord(value)
      || value.version !== CACHE_VERSION
      || !Number.isSafeInteger(value.generation)
      || Number(value.generation) < 0
      || !Number.isSafeInteger(value.updatedAt)
      || Number(value.updatedAt) < 0
    ) return null;
    return {
      version: CACHE_VERSION,
      ...draft,
      generation: Number(value.generation),
      updatedAt: Number(value.updatedAt),
    };
  } catch {
    return null;
  }
};

export class ChatDraftPersistence {
  private readonly dependencies: ChatDraftPersistenceDependencies;
  private readonly lanes = new Map<string, DraftLane>();

  constructor(overrides: Partial<ChatDraftPersistenceDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...overrides };
  }

  private cleanupOldCoordinatorState(runtimeKey: string, sessionId: string | null): void {
    for (const prefix of [OLD_CLEAR_PREFIX, OLD_SUBMISSION_PREFIX]) {
      this.dependencies.storage.removeItem(oldStorageKey(prefix, runtimeKey, sessionId));
    }
  }

  private write(runtimeKey: string, sessionId: string | null, lane: DraftLane): boolean {
    const key = storageKey(runtimeKey, sessionId);
    if (!lane.value.text && lane.value.confirmedMentions.length === 0) {
      this.dependencies.storage.removeItem(key);
      return true;
    }
    const stored: StoredChatDraft = {
      version: CACHE_VERSION,
      ...cloneValue(lane.value),
      generation: lane.generation,
      updatedAt: this.dependencies.now(),
    };
    const serialized = JSON.stringify(stored);
    this.dependencies.storage.setItem(key, serialized);
    return this.dependencies.verifyStorageWrite(key, serialized);
  }

  private notify(lane: DraftLane): void {
    for (const listener of lane.listeners) listener(cloneValue(lane.value));
  }

  private readInitial(runtimeKey: string, sessionId: string | null): DraftLane {
    const stored = parseStored(this.dependencies.storage.getItem(storageKey(runtimeKey, sessionId)));
    let oldStored: (ChatDraftValue & { updatedAt: number }) | null = null;
    try {
      const raw = JSON.parse(this.dependencies.storage.getItem(oldStorageKey(OLD_CACHE_PREFIX, runtimeKey, sessionId)) ?? 'null') as unknown;
      const draft = parseValue(raw);
      if (draft && isRecord(raw) && Number.isSafeInteger(raw.updatedAt) && Number(raw.updatedAt) >= 0) {
        oldStored = { ...draft, updatedAt: Number(raw.updatedAt) };
      }
    } catch {
      oldStored = null;
    }
    if (stored && (!oldStored || stored.updatedAt >= oldStored.updatedAt)) {
      this.dependencies.storage.removeItem(oldStorageKey(OLD_CACHE_PREFIX, runtimeKey, sessionId));
      this.cleanupOldCoordinatorState(runtimeKey, sessionId);
      return {
        value: { text: stored.text, confirmedMentions: stored.confirmedMentions },
        generation: stored.generation,
        dirty: false,
        listeners: new Set(),
      };
    }

    let migrated = oldStored ? cloneValue(oldStored) : null;
    if (!migrated) {
      const text = this.dependencies.storage.getItem(legacyTextKey(sessionId));
      let mentions: unknown = [];
      try {
        mentions = JSON.parse(this.dependencies.storage.getItem(legacyMentionsKey(sessionId)) ?? '[]') as unknown;
      } catch {
        mentions = [];
      }
      if (text !== null || (Array.isArray(mentions) && mentions.length > 0)) {
        migrated = {
          text: text ?? '',
          confirmedMentions: Array.isArray(mentions)
            ? mentions.filter((entry): entry is string => typeof entry === 'string')
            : [],
        };
      }
    }

    const lane: DraftLane = {
      value: migrated ? cloneValue(migrated) : emptyValue(),
      generation: migrated ? 1 : 0,
      dirty: false,
      listeners: new Set(),
    };
    const migratedDurably = !migrated || this.write(runtimeKey, sessionId, lane);
    if (migratedDurably) {
      this.dependencies.storage.removeItem(oldStorageKey(OLD_CACHE_PREFIX, runtimeKey, sessionId));
      this.dependencies.storage.removeItem(legacyTextKey(sessionId));
      this.dependencies.storage.removeItem(legacyMentionsKey(sessionId));
      this.cleanupOldCoordinatorState(runtimeKey, sessionId);
    }
    return lane;
  }

  private getLane(runtimeKey: string, sessionId: string | null): DraftLane {
    const key = mapKey(runtimeKey, sessionId);
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = this.readInitial(runtimeKey, sessionId);
      this.lanes.set(key, lane);
    }
    return lane;
  }

  readLocal(runtimeKey: string, sessionId: string | null): ChatDraftValue {
    return cloneValue(this.getLane(runtimeKey, sessionId).value);
  }

  stage(runtimeKey: string, sessionId: string | null, value: ChatDraftValue): void {
    const lane = this.getLane(runtimeKey, sessionId);
    if (valuesEqual(lane.value, value)) return;
    lane.value = cloneValue(value);
    lane.generation += 1;
    lane.dirty = true;
  }

  persist(runtimeKey: string, sessionId: string | null, value: ChatDraftValue): void {
    const lane = this.getLane(runtimeKey, sessionId);
    if (!valuesEqual(lane.value, value)) {
      lane.value = cloneValue(value);
      lane.generation += 1;
      lane.dirty = true;
    }
    if (!lane.dirty) return;
    const stored = parseStored(this.dependencies.storage.getItem(storageKey(runtimeKey, sessionId)));
    if (stored && stored.generation >= lane.generation) lane.generation = stored.generation + 1;
    lane.dirty = false;
    if (!this.write(runtimeKey, sessionId, lane)) lane.dirty = true;
    this.cleanupOldCoordinatorState(runtimeKey, sessionId);
    this.notify(lane);
  }

  persistForSubmission(
    runtimeKey: string,
    sessionId: string | null,
    value: ChatDraftValue,
  ): ChatDraftSubmission {
    this.persist(runtimeKey, sessionId, value);
    return { generation: this.getLane(runtimeKey, sessionId).generation };
  }

  clearAfterSubmission(
    runtimeKey: string,
    sessionId: string | null,
    value: ChatDraftValue,
    generation: number,
  ): void {
    const lane = this.getLane(runtimeKey, sessionId);
    const stored = parseStored(this.dependencies.storage.getItem(storageKey(runtimeKey, sessionId)));
    if (
      lane.generation !== generation
      || !valuesEqual(lane.value, value)
      || (stored && (stored.generation !== generation || !valuesEqual(stored, value)))
    ) return;
    this.dependencies.storage.removeItem(storageKey(runtimeKey, sessionId));
    lane.value = emptyValue();
    lane.generation += 1;
    lane.dirty = false;
    this.notify(lane);
  }

  moveSubmission(
    runtimeKey: string,
    fromSessionId: string | null,
    toSessionId: string,
    value: ChatDraftValue,
    generation: number,
  ): number | null {
    const source = this.getLane(runtimeKey, fromSessionId);
    if (source.generation !== generation || !valuesEqual(source.value, value)) return null;
    const target = this.getLane(runtimeKey, toSessionId);
    if (target.dirty || target.value.text || target.value.confirmedMentions.length > 0) return null;
    const next: DraftLane = {
      value: cloneValue(value),
      generation: Math.max(target.generation, generation) + 1,
      dirty: false,
      listeners: target.listeners,
    };
    if (!this.write(runtimeKey, toSessionId, next)) return null;
    this.dependencies.storage.removeItem(storageKey(runtimeKey, fromSessionId));
    source.value = emptyValue();
    source.generation += 1;
    source.dirty = false;
    target.value = next.value;
    target.generation = next.generation;
    target.dirty = false;
    this.notify(source);
    this.notify(target);
    return target.generation;
  }

  watch(
    runtimeKey: string,
    sessionId: string | null,
    listener: (value: ChatDraftValue) => void,
  ): () => void {
    const lane = this.getLane(runtimeKey, sessionId);
    lane.listeners.add(listener);
    const key = storageKey(runtimeKey, sessionId);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== key || lane.dirty) return;
      const stored = parseStored(event.newValue);
      const value = stored ? cloneValue(stored) : emptyValue();
      if (stored && stored.generation < lane.generation) return;
      if (valuesEqual(lane.value, value) && (!stored || stored.generation === lane.generation)) return;
      lane.value = value;
      lane.generation = stored?.generation ?? lane.generation + 1;
      this.notify(lane);
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', handleStorage);
    return () => {
      lane.listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', handleStorage);
    };
  }

  disable(runtimeKey: string, sessionId: string | null): void {
    this.dependencies.storage.removeItem(storageKey(runtimeKey, sessionId));
    this.dependencies.storage.removeItem(oldStorageKey(OLD_CACHE_PREFIX, runtimeKey, sessionId));
    this.dependencies.storage.removeItem(legacyTextKey(sessionId));
    this.dependencies.storage.removeItem(legacyMentionsKey(sessionId));
    this.cleanupOldCoordinatorState(runtimeKey, sessionId);
    this.lanes.delete(mapKey(runtimeKey, sessionId));
  }
}

export const chatDraftPersistence = new ChatDraftPersistence();
