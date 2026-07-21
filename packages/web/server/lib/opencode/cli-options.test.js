import { describe, expect, it } from 'bun:test';

import { parseServeCliOptions } from './cli-options.js';
import { startWebUiServer } from '../../index.js';

const parse = (options = {}) => parseServeCliOptions({
  argv: [],
  env: {},
  defaultPort: 3000,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
  ...options,
});

describe('FRPC direct startup options', () => {
  it('reads the HTTP-vhost routing domain and public hostname from the tunnel environment', () => {
    expect(parse({
      env: {
        OPENCHAMBER_TUNNEL_CUSTOM_DOMAIN: 'route.example.com',
        OPENCHAMBER_TUNNEL_HOSTNAME: 'public.example.com',
      },
    })).toMatchObject({
      tunnelCustomDomain: 'route.example.com',
      tunnelHostname: 'public.example.com',
    });
  });

  it('accepts the direct tunnel custom-domain option', () => {
    expect(parse({
      argv: [
        '--tunnel-custom-domain', 'route.example.com',
        '--tunnel-hostname=public.example.com',
      ],
    })).toMatchObject({
      tunnelCustomDomain: 'route.example.com',
      tunnelHostname: 'public.example.com',
    });
  });

  it('rejects removed direct-start CA options instead of ignoring them', () => {
    expect(() => parse({
      env: { OPENCHAMBER_TUNNEL_TRUSTED_CA_FILE: '/home/openchamber/frp/ca.crt' },
    })).toThrow(/OPENCHAMBER_TUNNEL_TRUSTED_CA_FILE is no longer supported/);
    expect(() => parse({
      argv: ['--tunnel-trusted-ca-file', '/home/openchamber/frp/ca.crt'],
    })).toThrow(/--tunnel-trusted-ca-file is no longer supported/);
  });

  it('reads the explicit public HTTPS URL for direct TCP startup', () => {
    expect(parse({
      argv: ['--tunnel-public-url=https://app.example.com:18080'],
      env: { OPENCHAMBER_TUNNEL_PUBLIC_URL: 'https://env.example.com:18080' },
    })).toMatchObject({
      tunnelPublicUrl: 'https://app.example.com:18080',
    });
    expect(parse({
      env: { OPENCHAMBER_TUNNEL_PUBLIC_URL: 'https://env.example.com:18080' },
    })).toMatchObject({
      tunnelPublicUrl: 'https://env.example.com:18080',
    });
  });

  it('fails server startup for explicit unknown providers and unsupported modes', async () => {
    await expect(startWebUiServer({
      port: 0,
      tunnelProvider: 'invalid-provider',
      tunnelMode: 'quick',
      attachSignals: false,
    })).rejects.toMatchObject({ code: 'provider_unsupported' });

    await expect(startWebUiServer({
      port: 0,
      tunnelProvider: 'frpc',
      tunnelMode: 'quick',
      attachSignals: false,
    })).rejects.toMatchObject({ code: 'mode_unsupported' });

    await expect(startWebUiServer({
      port: 0,
      tunnelTrustedCaFile: '/home/openchamber/frp/ca.crt',
      attachSignals: false,
    })).rejects.toThrow(/tunnelTrustedCaFile is no longer supported/);
  });
});
