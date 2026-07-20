import { describe, expect, test } from 'bun:test';
import {
  WINDOWS_NOTIFICATION_TARGET_LIMIT,
  buildWindowsNotificationProtocolUrl,
  buildWindowsProtocolToastXml,
  getWindowsNotificationTarget,
  removeWindowsNotificationTarget,
  storeWindowsNotificationTarget,
} from './windows-notification-protocol.mjs';

const NOW = 1_800_000_000_000;
const notificationId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

describe('Windows notification protocol targets', () => {
  test('round-trips an opaque target and removes it after consumption', () => {
    const id = notificationId(1);
    const root = storeWindowsNotificationTarget({ version: 2, keep: true }, {
      id,
      runtimeKey: ' host:runtime-a ',
      sessionId: ' session-a ',
      directory: ' C:\\repo\\a ',
    }, NOW);

    const persistedRoot = JSON.parse(JSON.stringify(root));
    expect(persistedRoot.keep).toBe(true);
    expect(getWindowsNotificationTarget(persistedRoot, id, NOW)).toEqual({
      id,
      runtimeKey: 'host:runtime-a',
      sessionId: 'session-a',
      directory: 'C:\\repo\\a',
      createdAt: NOW,
    });
    expect(getWindowsNotificationTarget(removeWindowsNotificationTarget(persistedRoot, id, NOW), id, NOW)).toBeNull();
  });

  test('drops malformed and expired records while bounding retained targets', () => {
    const malformedId = notificationId(4);
    let root = {
      version: 2,
      targets: [
        { id: 'bad', runtimeKey: 'local', sessionId: 'session-bad', directory: '/bad', createdAt: NOW },
        { id: malformedId, runtimeKey: 'local', sessionId: 42, directory: '/bad', createdAt: NOW },
        { id: notificationId(2), runtimeKey: 'local', sessionId: 'session-expired', directory: '/old', createdAt: NOW - 31 * 24 * 60 * 60 * 1000 },
      ],
    };

    for (let index = 0; index < WINDOWS_NOTIFICATION_TARGET_LIMIT + 3; index += 1) {
      root = storeWindowsNotificationTarget(root, {
        id: notificationId(100 + index),
        runtimeKey: `host:runtime-${index}`,
        sessionId: `session-${index}`,
        directory: `/repo/${index}`,
        createdAt: NOW + index,
      }, NOW + index);
    }

    expect(root.targets).toHaveLength(WINDOWS_NOTIFICATION_TARGET_LIMIT);
    expect(getWindowsNotificationTarget(root, malformedId, NOW + 100)).toBeNull();
    expect(getWindowsNotificationTarget(root, notificationId(100), NOW + 100)).toBeNull();
    expect(getWindowsNotificationTarget(root, notificationId(103), NOW + 100)?.sessionId).toBe('session-3');
  });

  test('rejects unscoped targets from the old storage version', () => {
    const id = notificationId(5);
    const oldRoot = {
      version: 1,
      targets: [{ id, sessionId: 'session-old', directory: 'C:\\repo\\old', createdAt: NOW }],
    };

    expect(getWindowsNotificationTarget(oldRoot, id, NOW)).toBeNull();
    expect(() => storeWindowsNotificationTarget({ version: 2 }, {
      id,
      sessionId: 'session-unscoped',
      directory: 'C:\\repo\\unsafe',
    }, NOW)).toThrow(TypeError);
  });

  test('builds an opaque protocol URL and XML-escapes visible text', () => {
    const id = notificationId(3);
    const protocolUrl = buildWindowsNotificationProtocolUrl(id);
    expect(protocolUrl).toBe(`openchamber://notification/${id}`);
    expect(new URL(protocolUrl)).toMatchObject({
      protocol: 'openchamber:',
      hostname: 'notification',
      pathname: `/${id}`,
    });

    const xml = buildWindowsProtocolToastXml({
      notificationId: id,
      title: 'Build <done>',
      body: 'A & B\u0000',
    });
    expect(xml).toContain(`launch="openchamber://notification/${id}" activationType="protocol"`);
    expect(xml).toContain('<text>Build &lt;done&gt;</text>');
    expect(xml).toContain('<text>A &amp; B</text>');
    expect(xml).not.toContain('\u0000');
    expect(xml).not.toContain('session-');
    expect(xml).not.toContain('repo');
    expect(() => buildWindowsNotificationProtocolUrl('../session-a')).toThrow(TypeError);
  });
});
