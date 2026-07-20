import { describe, expect, test } from 'bun:test';
import { buildTestNotificationPayload } from './notificationTestPayload';

describe('notification settings test payload', () => {
  test('targets the current real session and its owning directory', () => {
    expect(buildTestNotificationPayload({
      title: 'Test Notification',
      body: 'Test body',
      sessionId: ' ses_current ',
      sessionDirectory: ' C:\\workspace ',
      currentDirectory: 'C:\\other',
    })).toEqual({
      title: 'Test Notification',
      body: 'Test body',
      tag: 'openchamber-test',
      kind: 'test',
      sessionId: 'ses_current',
      directory: 'C:\\workspace',
    });
  });

  test('stays explicitly targetless when no real session is selected', () => {
    expect(buildTestNotificationPayload({
      title: 'Test Notification',
      body: 'Test body',
      sessionId: null,
      currentDirectory: 'C:\\workspace',
    })).toEqual({
      title: 'Test Notification',
      body: 'Test body',
      tag: 'openchamber-test',
      kind: 'test',
    });
  });
});
