import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPrimarySessionNavigationSurface,
  shouldPrimePrimarySessionNavigation,
  shouldRestorePrimarySessionNavigation,
} from './sync/session-navigation';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(currentDirectory, 'main.tsx'), 'utf8');
const mobileAppSource = readFileSync(join(currentDirectory, 'apps/MobileApp.tsx'), 'utf8');
const mobileRendererSource = readFileSync(join(currentDirectory, 'apps/renderMobileApp.tsx'), 'utf8');

describe('primary surface session restoration', () => {
  test('guards browser access and restores eligible surfaces before React mounts', () => {
    const guardIndex = source.indexOf(
      "if (typeof window !== 'undefined' && shouldPrimePrimarySessionNavigation())",
    );
    const restoreIndex = source.indexOf('restoreForRuntimeSwitch()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(guardIndex);
    expect(restoreIndex).toBeLessThan(source.indexOf('createRoot(rootElement).render'));
  });

  test('uses the same pre-mount navigation guard on the mobile renderer', () => {
    const guardIndex = mobileRendererSource.indexOf(
      "if (typeof window !== 'undefined' && shouldPrimePrimarySessionNavigation())",
    );
    const restoreIndex = mobileRendererSource.indexOf('restoreForRuntimeSwitch()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(guardIndex);
    expect(restoreIndex).toBeLessThan(mobileRendererSource.indexOf('createRoot(rootElement).render'));
  });

  test('restores a normal browser root but preserves explicit URL targets', () => {
    expect(shouldRestorePrimarySessionNavigation({ search: '', pathname: '/' })).toBe(true);
    expect(shouldRestorePrimarySessionNavigation({
      search: '?session=ses_explicit',
      pathname: '/',
    })).toBe(false);
    expect(shouldRestorePrimarySessionNavigation({
      search: '?directory=%2Frepo',
      pathname: '/',
    })).toBe(false);
  });

  test('primes only an explicit session matching the durable notification target', () => {
    expect(shouldPrimePrimarySessionNavigation({
      search: '?session=ses_notification&directory=%2Frepo',
      pathname: '/',
    }, 'ses_notification')).toBe(true);
    expect(shouldPrimePrimarySessionNavigation({
      search: '?session=ses_other&directory=%2Frepo',
      pathname: '/',
    }, 'ses_notification')).toBe(false);
    expect(shouldPrimePrimarySessionNavigation({
      search: '?directory=%2Frepo',
      pathname: '/',
    }, 'ses_notification')).toBe(false);
    expect(shouldPrimePrimarySessionNavigation({
      search: '?session=ses_other&directory=%2Frepo',
      pathname: '/mobile.html',
    }, 'ses_notification')).toBe(false);
  });

  test('excludes embedded and secondary desktop surfaces', () => {
    expect(isPrimarySessionNavigationSurface({
      search: '',
      pathname: '/',
      electronWindowRole: 'main',
    })).toBe(true);
    expect(isPrimarySessionNavigationSurface({
      search: '?ocPanel=session-chat&sessionId=ses_child',
      pathname: '/',
    })).toBe(false);
    expect(isPrimarySessionNavigationSurface({
      search: '',
      pathname: '/mini-chat.html',
    })).toBe(false);
    expect(isPrimarySessionNavigationSurface({
      search: '',
      pathname: '/',
      electronWindowRole: 'additional',
    })).toBe(false);
    expect(isPrimarySessionNavigationSurface({
      search: '',
      pathname: '/',
      electronWindowRole: 'mini-chat',
    })).toBe(false);
  });
});

describe('primary surface browser push reconciliation', () => {
  test('reconciles existing subscriptions on the hosted mobile surface', () => {
    expect(mobileAppSource).toContain('useBrowserPushSubscriptionReconciliation({ enabled: isConnected });');
  });
});
