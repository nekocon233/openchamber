import { describe, expect, test } from 'bun:test';
import { toNotificationPayload } from './useWebNotificationStream';

describe('web notification stream payloads', () => {
  test('preserves session routing fields from server events', () => {
    expect(toNotificationPayload({
      type: 'openchamber:notification',
      properties: {
        title: 'Ready',
        body: 'Done',
        tag: 'ready-ses_123',
        kind: 'ready',
        sessionId: 'ses_123',
        directory: '/workspace',
        requireHidden: true,
      },
    })).toEqual({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-ses_123',
      kind: 'ready',
      sessionId: 'ses_123',
      directory: '/workspace',
      requireHidden: true,
    });
  });

  test('rejects unrelated events', () => {
    expect(toNotificationPayload({ type: 'session.updated', properties: {} })).toBeNull();
  });
});
