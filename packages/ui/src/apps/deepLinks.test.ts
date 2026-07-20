import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { parseServiceWorkerNotificationClick } from './deepLinks';
import { parseRoute } from '@/lib/router';

const navigationSource = readFileSync(new URL('./deepLinkNavigation.ts', import.meta.url), 'utf8');

describe('service worker notification deep links', () => {
  test('reports installed display mode in the click acknowledgement', () => {
    expect(navigationSource).toContain("installed: getPWADisplayMode() !== 'browser'");
    expect(navigationSource.indexOf('if (intent) applyDeepLinkIntent(intent);')).toBeLessThan(
      navigationSource.indexOf("type: 'openchamber:notification-click-ack'"),
    );
  });

  test('prefers the explicit session ID', () => {
    expect(parseServiceWorkerNotificationClick({
      type: 'openchamber:notification-click',
      sessionId: 'ses_direct',
      directory: '/workspace',
      url: 'https://openchamber.example/?session=ses_url',
    }, 'https://openchamber.example/')).toEqual({
      type: 'session',
      sessionId: 'ses_direct',
      directory: '/workspace',
    });
  });

  test('accepts a same-origin session URL fallback', () => {
    expect(parseServiceWorkerNotificationClick({
      type: 'openchamber:notification-click',
      url: '/?session=ses_url&directory=%2Frepo',
    }, 'https://openchamber.example/settings')).toEqual({
      type: 'session',
      sessionId: 'ses_url',
      directory: '/repo',
    });
  });

  test('does not combine an explicit session with another URL session directory', () => {
    expect(parseServiceWorkerNotificationClick({
      type: 'openchamber:notification-click',
      sessionId: 'ses_direct',
      url: '/?session=ses_url&directory=%2Furl-workspace',
    }, 'https://openchamber.example/')).toEqual({
      type: 'session',
      sessionId: 'ses_direct',
      directory: undefined,
    });
  });

  test('rejects foreign and malformed notification messages', () => {
    expect(parseServiceWorkerNotificationClick({
      type: 'openchamber:notification-click',
      url: 'https://attacker.example/?session=ses_bad',
    }, 'https://openchamber.example/')).toBeNull();
    expect(parseServiceWorkerNotificationClick({ type: 'other', sessionId: 'ses_bad' }, 'https://openchamber.example/')).toBeNull();
  });
});

test('web route preserves a cold-start session directory hint', () => {
  expect(parseRoute(new URLSearchParams('session=ses_cold&directory=%2Fworkspace'))).toEqual({
    sessionId: 'ses_cold',
    sessionDirectory: '/workspace',
    tab: null,
    settingsPath: null,
    diffFile: null,
  });
});
