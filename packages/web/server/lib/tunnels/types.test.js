import { describe, expect, it } from 'bun:test';

import {
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_FRPC,
  isPathWithinDirectory,
  normalizeTunnelStartRequest,
  resolveTunnelConfigPath,
  validateTunnelStartRequest,
} from './types.js';

describe('tunnel config path normalization', () => {
  it('allows Windows home paths with different drive casing', () => {
    expect(isPathWithinDirectory(
      'c:\\Users\\Bohdan\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(true);
  });

  it('does not allow Windows sibling home directories', () => {
    expect(isPathWithinDirectory(
      'C:\\Users\\Bohdan2\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(false);
  });

  it('resolves Windows tilde paths inside the provided home directory', () => {
    expect(resolveTunnelConfigPath('~\\.cloudflared\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toBe('C:\\Users\\Bohdan\\.cloudflared\\config.yml');
  });

  it('rejects Windows paths outside the provided home directory', () => {
    expect(() => resolveTunnelConfigPath('C:\\Temp\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toThrow(/Config path must be within the home directory/);
  });
});

describe('FRPC tunnel request normalization', () => {
  const capabilities = {
    provider: TUNNEL_PROVIDER_FRPC,
    modes: [{
      key: TUNNEL_MODE_MANAGED_REMOTE,
      intent: 'persistent-public',
      requires: ['serverAddress', 'serverPort', 'trustedCaFile', 'token'],
    }],
  };

  it('uses managed-remote by default and preserves the TCP mapping fields', () => {
    const request = normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      serverAddress: ' 203.0.113.10 ',
      serverPort: '7000',
      trustedCaFile: ' /home/openchamber/frp/ca.crt ',
      remotePort: 18080,
      publicUrl: ' https://app.example.com:18080/ ',
      token: ' secret ',
    });

    expect(request).toMatchObject({
      provider: TUNNEL_PROVIDER_FRPC,
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080/',
      token: 'secret',
    });
    expect(() => validateTunnelStartRequest(request, capabilities)).not.toThrow();
  });

  it('requires an explicit public HTTPS URL for TCP requests', () => {
    const missingPublicUrl = normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      token: 'secret',
    });

    expect(() => validateTunnelStartRequest(missingPublicUrl, capabilities)).toThrow(/public HTTPS URL is required/);
  });

  it('rejects explicit unknown providers and modes instead of using quick Cloudflare', () => {
    let providerError;
    let modeError;
    try {
      normalizeTunnelStartRequest({ provider: 'unknown-provider' });
    } catch (error) {
      providerError = error;
    }
    try {
      normalizeTunnelStartRequest({
        provider: TUNNEL_PROVIDER_FRPC,
        mode: 'unknown-mode',
      });
    } catch (error) {
      modeError = error;
    }

    expect(providerError).toMatchObject({ code: 'provider_unsupported' });
    expect(modeError).toMatchObject({ code: 'mode_unsupported' });
  });

  it('forwards an HTTP-vhost endpoint and validates its public hostname pair', () => {
    const request = normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: ' Route.Example.com ',
      hostname: ' Public.Example.com ',
      token: 'secret',
    });

    expect(request).toMatchObject({
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
    });
    expect(request.remotePort).toBeUndefined();
    expect(() => validateTunnelStartRequest(request, capabilities)).not.toThrow();
  });

  it('rejects a missing endpoint before provider startup', () => {
    const request = normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      token: 'secret',
    });

    expect(() => validateTunnelStartRequest(request, capabilities)).toThrow(/remote port or custom domain is required/);
  });

  it('rejects mixed TCP and HTTP endpoint fields and requires the public hostname', () => {
    const mixed = normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'secret',
    });
    const missingHostname = normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: 'route.example.com',
      token: 'secret',
    });

    expect(() => validateTunnelStartRequest(mixed, capabilities)).toThrow(/cannot be used together/);
    expect(() => validateTunnelStartRequest(missingHostname, capabilities)).toThrow(/public hostname is required/);
  });
});
