import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(currentDirectory, 'main.tsx'), 'utf8');
const mobileAppSource = readFileSync(join(currentDirectory, 'apps/MobileApp.tsx'), 'utf8');

describe('primary surface session restoration', () => {
  test('restores Electron main windows and installed PWAs before React mounts', () => {
    const restoreIndex = source.indexOf('restoreForRuntimeSwitch()');
    expect(source).toContain("window.__OPENCHAMBER_ELECTRON__?.windowRole === 'main'");
    expect(source).toContain("getPWADisplayMode() !== 'browser'");
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeLessThan(source.indexOf('createRoot(rootElement).render'));
  });
});

describe('primary surface browser push reconciliation', () => {
  test('reconciles existing subscriptions on the hosted mobile surface', () => {
    expect(mobileAppSource).toContain('useBrowserPushSubscriptionReconciliation({ enabled: isConnected });');
  });
});
