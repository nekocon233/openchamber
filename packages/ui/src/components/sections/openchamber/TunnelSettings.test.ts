import { describe, expect, test } from 'bun:test';

import { buildFrpcStartEndpointPayload, normalizeFrpcHostname, normalizeFrpcPublicUrl } from './frpcTunnelSettings';

describe('managed FRPC start endpoint payload', () => {
  test('sends only the TCP remote port endpoint', () => {
    const input = {
      proxyType: 'tcp' as const,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://public.example.com:18080',
      customDomain: 'stale-vhost.example.com',
      publicHostname: 'stale-public.example.com',
    };

    expect(buildFrpcStartEndpointPayload(input)).toEqual({
      proxyType: 'tcp',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://public.example.com:18080',
    });
  });

  test('sends only the HTTP vhost endpoint with canonical hostname', () => {
    const input = {
      proxyType: 'http' as const,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: 'vhost.example.com',
      publicHostname: normalizeFrpcHostname(' HTTPS://Public.Example.com/path '),
      remotePort: 18080,
    };

    expect(buildFrpcStartEndpointPayload(input)).toEqual({
      proxyType: 'http',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: 'vhost.example.com',
      hostname: 'public.example.com',
    });
  });

  test('rejects malformed HTTP vhost hostnames', () => {
    expect(normalizeFrpcHostname('not a hostname')).toBe('');
  });

  test('accepts only origin-only HTTPS URLs for TCP browser access', () => {
    expect(normalizeFrpcPublicUrl(' HTTPS://Public.Example.com:18080/ ')).toBe('https://public.example.com:18080');
    for (const invalid of [
      'http://public.example.com:18080',
      'not a URL',
      'https://user:secret@public.example.com:18080',
      'https://public.example.com:18080/path',
      'https://public.example.com:18080?token=secret',
    ]) {
      expect(normalizeFrpcPublicUrl(invalid)).toBe('');
    }
  });
});
