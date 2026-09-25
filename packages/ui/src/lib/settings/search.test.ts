import { describe, expect, test } from 'bun:test';
import type { I18nKey } from '@/lib/i18n/store';
import { buildSettingsSearchResults } from './search';

const t = (key: I18nKey): string => key;

const runtimeCtx = {
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isHostLocalOrigin: true,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
  routingAvailable: false,
};

describe('settings search', () => {
  test('finds the scrollbar preference on every surface', () => {
    for (const context of [runtimeCtx, { ...runtimeCtx, isDesktop: true }, { ...runtimeCtx, isVSCode: true }, { ...runtimeCtx, isMobile: true }]) {
      const results = buildSettingsSearchResults({
        query: 'scrollbar',
        runtimeCtx: context,
        t,
        getPageTitle: (page) => page,
      });
      expect(results.find((result) => result.id === 'appearance.scrollbars')?.page).toBe('appearance');
    }
  });

  test('finds third-party integrations by OpenChamber npm package names', () => {
    const results = buildSettingsSearchResults({
      query: '@openchamber/opencode-cursor',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.third-party.opencode-cursor-oauth')).toBe(true);
  });

  test('finds Linear connect on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(true);
  });

  test('finds the chat input history scope setting', () => {
    const results = buildSettingsSearchResults({
      query: 'input history scope',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'chat.input-history-scope')).toBe(true);
  });

  test('finds the chat input history limit setting by recall keywords', () => {
    const results = buildSettingsSearchResults({
      query: 'remember prompts',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'chat.input-history-limit')).toBe(true);
  });

  test('hides Linear connect in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(false);
  });

  const buildTunnelResults = (query: string, isHostLocalOrigin = true) => buildSettingsSearchResults({
    query,
    runtimeCtx: { ...runtimeCtx, isHostLocalOrigin },
    visiblePageSlugs: ['tunnel'],
    t,
    getPageTitle: () => 'Tunnel',
  });

  test('finds the stable FRPC anchor by TCP mapping terms', () => {
    expect(buildTunnelResults('frps remote port').some((result) => result.id === 'tunnel.frpc')).toBe(true);
  });

  test('finds the same FRPC anchor by HTTP vhost terms', () => {
    expect(buildTunnelResults('caddy public hostname').some((result) => result.id === 'tunnel.frpc')).toBe(true);
  });

  test('hides tunnel management results away from the host origin', () => {
    expect(buildTunnelResults('frpc', false)).toEqual([]);
  });

  test('finds guest extension panels on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'gitlab',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.guests')).toBe(true);
  });

  test('hides guest extension panels in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'clickup',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.guests')).toBe(false);
  });
});
