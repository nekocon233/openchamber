import { describe, expect, test } from 'bun:test';

import { buildSettingsSearchResults } from './search';

describe('settings search FRPC integration', () => {
  const buildTunnelResults = (query: string) => buildSettingsSearchResults({
    query,
    runtimeCtx: {
      isVSCode: false,
      isWeb: true,
      isDesktop: false,
      isMobile: false,
      isDesktopLocalOrigin: false,
      isMac: false,
      isWindows: false,
    },
    visiblePageSlugs: ['tunnel'],
    t: (key) => key,
    getPageTitle: () => 'Tunnel',
  });

  test('finds the stable FRPC anchor by TCP mapping terms', () => {
    const results = buildTunnelResults('frps remote port');

    expect(results.some((result) => result.id === 'tunnel.frpc')).toBe(true);
  });

  test('finds the same FRPC anchor by HTTP vhost terms', () => {
    const results = buildTunnelResults('caddy public hostname');

    expect(results.some((result) => result.id === 'tunnel.frpc')).toBe(true);
  });
});
