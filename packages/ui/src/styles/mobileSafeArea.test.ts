import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(sourceDirectory, 'mobile.css'), 'utf8');
const designSystemCss = readFileSync(join(sourceDirectory, 'design-system.css'), 'utf8');
const overlayPanel = readFileSync(join(sourceDirectory, '../components/ui/MobileOverlayPanel.tsx'), 'utf8');

describe('installed PWA bottom safe area', () => {
  test('uses structural spacing instead of a fixed body overlay', () => {
    expect(mobileCss).not.toContain('body::after');
    expect(mobileCss).not.toContain('z-index: 1000');
    expect(designSystemCss).toContain('--oc-interactive-bottom-safe: 0px');
    expect(mobileCss).toContain('--oc-interactive-bottom-safe: max(16px');
  });

  test('keeps dialogs, bottom sheets, and the composer above the interactive safe area', () => {
    expect(mobileCss).toContain('padding-bottom: var(--oc-interactive-bottom-safe) !important');
    expect(mobileCss).toContain('.pwa-overlay-panel .pwa-overlay-scroll');
    expect(mobileCss).toContain('var(--oc-interactive-bottom-safe, 0px)');
    expect(mobileCss).toContain(".oc-mobile-composer");
    expect(overlayPanel).toContain("var(--oc-interactive-bottom-safe, 0px)");
    expect(overlayPanel).toContain("env(safe-area-inset-bottom, 0px)");
  });

  test('keeps the standalone root clipping boundary aligned with the mobile shell', () => {
    expect(mobileCss).toContain(`:root.device-mobile:not(.desktop-runtime):not(.oc-capacitor-app),
  :root.device-tablet:not(.desktop-runtime):not(.oc-capacitor-app),
  :root.mobile-pointer:not(.desktop-runtime):not(.oc-capacitor-app) {
    height: 100lvh;
  }`);
    expect(mobileCss).toContain(`:root:not(.oc-capacitor-app) .oc-mobile-app-shell {
    height: 100lvh;
  }`);
  });
});
