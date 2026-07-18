import { beforeEach, describe, expect, test } from 'bun:test';
import type { Event, Message } from '@opencode-ai/sdk/v2/client';

import {
  aggregateSessionMessageActivity,
  applySessionMessageActivityEvent,
  mergeSessionMessageActivity,
  removeSessionMessageActivity,
  resetSessionMessageActivity,
  useSessionMessageActivityStore,
} from './session-message-activity';

const message = (
  id: string,
  sessionID: string,
  role: 'user' | 'assistant',
  created: number,
): Message => ({ id, sessionID, role, time: { created } } as Message);

const messageUpdated = (info: Message): Event => ({
  id: `evt-${info.id}`,
  type: 'message.updated',
  properties: { sessionID: info.sessionID, info },
} as Event);

describe('session message activity', () => {
  beforeEach(() => resetSessionMessageActivity());

  test('aggregates both user sends and assistant replies by their latest creation time', () => {
    const activity = aggregateSessionMessageActivity([
      {
        message: {
          'ses-user': [message('msg-user', 'ses-user', 'user', 20)],
          'ses-assistant': [
            message('msg-prompt', 'ses-assistant', 'user', 10),
            message('msg-reply', 'ses-assistant', 'assistant', 30),
          ],
        },
      },
    ]);

    expect(activity.get('ses-user')).toBe(20);
    expect(activity.get('ses-assistant')).toBe(30);
  });

  test('keeps a monotonic event watermark and ignores repeated message updates', () => {
    const reply = message('msg-reply', 'ses-1', 'assistant', 30);
    applySessionMessageActivityEvent(messageUpdated(reply));
    const first = useSessionMessageActivityStore.getState().activityBySessionId;

    applySessionMessageActivityEvent(messageUpdated({ ...reply, time: { created: 30, completed: 40 } } as Message));
    applySessionMessageActivityEvent(messageUpdated(message('msg-old', 'ses-1', 'user', 20)));

    expect(useSessionMessageActivityStore.getState().activityBySessionId).toBe(first);
    expect(first.get('ses-1')).toBe(30);
  });

  test('clears the event watermark when message history may have moved backwards', () => {
    applySessionMessageActivityEvent(messageUpdated(message('msg-1', 'ses-1', 'user', 30)));
    applySessionMessageActivityEvent({
      id: 'evt-remove',
      type: 'message.removed',
      properties: { sessionID: 'ses-1', messageID: 'msg-1' },
    } as Event);

    expect(useSessionMessageActivityStore.getState().activityBySessionId.has('ses-1')).toBe(false);
  });

  test('keeps the latest watermark when an older message is removed', () => {
    applySessionMessageActivityEvent(messageUpdated(message('msg-1', 'ses-1', 'user', 20)));
    applySessionMessageActivityEvent(messageUpdated(message('msg-2', 'ses-1', 'assistant', 30)));
    const before = useSessionMessageActivityStore.getState().activityBySessionId;

    applySessionMessageActivityEvent({
      id: 'evt-remove-old',
      type: 'message.removed',
      properties: { sessionID: 'ses-1', messageID: 'msg-1' },
    } as Event);

    expect(useSessionMessageActivityStore.getState().activityBySessionId).toBe(before);
    expect(before.get('ses-1')).toBe(30);
  });

  test('restores the previous observed watermark when the latest message is removed', () => {
    applySessionMessageActivityEvent(messageUpdated(message('msg-1', 'ses-1', 'user', 20)));
    applySessionMessageActivityEvent(messageUpdated(message('msg-2', 'ses-1', 'assistant', 30)));

    removeSessionMessageActivity('ses-1', 'msg-2');

    expect(useSessionMessageActivityStore.getState().activityBySessionId.get('ses-1')).toBe(20);
  });

  test('removes an echoed optimistic watermark when that send rolls back', () => {
    applySessionMessageActivityEvent(messageUpdated(message('msg-optimistic', 'ses-1', 'user', 30)));

    removeSessionMessageActivity('ses-1', 'msg-optimistic');

    expect(useSessionMessageActivityStore.getState().activityBySessionId.has('ses-1')).toBe(false);
  });

  test('merges cached optimistic activity with global event activity using the newest timestamp', () => {
    const merged = mergeSessionMessageActivity(
      new Map([['ses-1', 40], ['ses-2', 10]]),
      new Map([['ses-1', 30], ['ses-2', 50]]),
    );

    expect([...merged]).toEqual([['ses-1', 40], ['ses-2', 50]]);
  });
});
