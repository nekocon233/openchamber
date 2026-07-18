import type { Event, Message } from '@opencode-ai/sdk/v2/client';
import { create } from 'zustand';

import type { State as SyncState } from './types';

export type SessionMessageActivityMap = ReadonlyMap<string, number>;

type MessageStateSlice = Pick<SyncState, 'message'>;
const MAX_OBSERVED_MESSAGES_PER_SESSION = 50;

type SessionMessageActivityState = {
  activityBySessionId: Map<string, number>;
  latestMessageIdBySessionId: Map<string, string>;
  observedMessagesBySessionId: Map<string, Map<string, number>>;
};

export const useSessionMessageActivityStore = create<SessionMessageActivityState>(() => ({
  activityBySessionId: new Map(),
  latestMessageIdBySessionId: new Map(),
  observedMessagesBySessionId: new Map(),
}));

const getMessageCreatedAt = (message: Message): number => {
  const createdAt = message.time?.created;
  return typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
    ? createdAt
    : 0;
};

const clearSessionActivity = (sessionId: string): void => {
  if (!sessionId) return;
  useSessionMessageActivityStore.setState((state) => {
    if (!state.observedMessagesBySessionId.has(sessionId)) return state;
    const nextActivity = new Map(state.activityBySessionId);
    const nextMessageIds = new Map(state.latestMessageIdBySessionId);
    const nextObservedMessages = new Map(state.observedMessagesBySessionId);
    nextActivity.delete(sessionId);
    nextMessageIds.delete(sessionId);
    nextObservedMessages.delete(sessionId);
    return {
      activityBySessionId: nextActivity,
      latestMessageIdBySessionId: nextMessageIds,
      observedMessagesBySessionId: nextObservedMessages,
    };
  });
};

const getLatestObservedMessage = (
  messages: ReadonlyMap<string, number>,
): { messageId: string; timestamp: number } | null => {
  let latest: { messageId: string; timestamp: number } | null = null;
  for (const [messageId, timestamp] of messages) {
    if (
      !latest
      || timestamp > latest.timestamp
      || (timestamp === latest.timestamp && messageId > latest.messageId)
    ) {
      latest = { messageId, timestamp };
    }
  }
  return latest;
};

export const removeSessionMessageActivity = (sessionId: string, messageId: string): void => {
  if (!sessionId || !messageId) return;
  useSessionMessageActivityStore.setState((state) => {
    const currentMessages = state.observedMessagesBySessionId.get(sessionId);
    if (!currentMessages?.has(messageId)) return state;

    const nextMessages = new Map(currentMessages);
    nextMessages.delete(messageId);
    const observedMessagesBySessionId = new Map(state.observedMessagesBySessionId);
    const latest = getLatestObservedMessage(nextMessages);
    if (latest) observedMessagesBySessionId.set(sessionId, nextMessages);
    else observedMessagesBySessionId.delete(sessionId);

    if (state.latestMessageIdBySessionId.get(sessionId) !== messageId) {
      return { observedMessagesBySessionId };
    }

    const activityBySessionId = new Map(state.activityBySessionId);
    const latestMessageIdBySessionId = new Map(state.latestMessageIdBySessionId);
    if (latest) {
      activityBySessionId.set(sessionId, latest.timestamp);
      latestMessageIdBySessionId.set(sessionId, latest.messageId);
    } else {
      activityBySessionId.delete(sessionId);
      latestMessageIdBySessionId.delete(sessionId);
    }
    return {
      activityBySessionId,
      latestMessageIdBySessionId,
      observedMessagesBySessionId,
    };
  });
};

export const applySessionMessageActivityEvent = (event: Event): void => {
  switch (event.type) {
    case 'message.updated': {
      const info = (event.properties as { info?: Message }).info;
      if (!info?.sessionID) return;
      const createdAt = getMessageCreatedAt(info);
      if (createdAt <= 0) return;
      useSessionMessageActivityStore.setState((state) => {
        const currentMessages = state.observedMessagesBySessionId.get(info.sessionID) ?? new Map();
        if (currentMessages.get(info.id) === createdAt) return state;
        const nextMessages = new Map(currentMessages);
        nextMessages.set(info.id, createdAt);
        if (nextMessages.size > MAX_OBSERVED_MESSAGES_PER_SESSION) {
          const oldest = [...nextMessages.entries()]
            .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
            .slice(0, nextMessages.size - MAX_OBSERVED_MESSAGES_PER_SESSION);
          for (const [messageId] of oldest) nextMessages.delete(messageId);
        }
        const observedMessagesBySessionId = new Map(state.observedMessagesBySessionId);
        observedMessagesBySessionId.set(info.sessionID, nextMessages);
        const latest = getLatestObservedMessage(nextMessages);
        if (!latest) return { observedMessagesBySessionId };

        const currentTimestamp = state.activityBySessionId.get(info.sessionID) ?? 0;
        const currentMessageId = state.latestMessageIdBySessionId.get(info.sessionID) ?? '';
        if (currentTimestamp === latest.timestamp && currentMessageId === latest.messageId) {
          return { observedMessagesBySessionId };
        }
        const nextActivity = new Map(state.activityBySessionId);
        const nextMessageIds = new Map(state.latestMessageIdBySessionId);
        nextActivity.set(info.sessionID, latest.timestamp);
        nextMessageIds.set(info.sessionID, latest.messageId);
        return {
          activityBySessionId: nextActivity,
          latestMessageIdBySessionId: nextMessageIds,
          observedMessagesBySessionId,
        };
      });
      return;
    }
    case 'message.removed': {
      const properties = event.properties as { sessionID?: string; messageID?: string };
      removeSessionMessageActivity(properties.sessionID ?? '', properties.messageID ?? '');
      return;
    }
    case 'session.updated': {
      const info = (event.properties as { info?: { id?: string; time?: { archived?: number | null } } }).info;
      if (info?.id && info.time?.archived) clearSessionActivity(info.id);
      return;
    }
    case 'session.deleted': {
      const properties = event.properties as { sessionID?: string; info?: { id?: string } };
      clearSessionActivity(properties.sessionID ?? properties.info?.id ?? '');
      return;
    }
    default:
      return;
  }
};

export const aggregateSessionMessageActivity = (
  states: Iterable<MessageStateSlice>,
): Map<string, number> => {
  const result = new Map<string, number>();
  for (const state of states) {
    for (const [sessionId, messages] of Object.entries(state.message)) {
      let latest = result.get(sessionId) ?? 0;
      for (const message of messages) {
        latest = Math.max(latest, getMessageCreatedAt(message));
      }
      if (latest > 0) result.set(sessionId, latest);
    }
  }
  return result;
};

export const areSessionMessageActivityMapsEquivalent = (
  left: SessionMessageActivityMap,
  right: SessionMessageActivityMap,
): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [sessionId, timestamp] of left) {
    if (right.get(sessionId) !== timestamp) return false;
  }
  return true;
};

export const mergeSessionMessageActivity = (
  cached: SessionMessageActivityMap,
  observed: SessionMessageActivityMap,
): SessionMessageActivityMap => {
  if (observed.size === 0) return cached;
  if (cached.size === 0) return observed;
  const merged = new Map(cached);
  for (const [sessionId, timestamp] of observed) {
    if ((merged.get(sessionId) ?? 0) < timestamp) merged.set(sessionId, timestamp);
  }
  return merged;
};

export const resetSessionMessageActivity = (): void => {
  useSessionMessageActivityStore.setState({
    activityBySessionId: new Map(),
    latestMessageIdBySessionId: new Map(),
    observedMessagesBySessionId: new Map(),
  });
};
