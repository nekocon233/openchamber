import { describe, expect, it } from 'bun:test';

import {
  buildTunnelProfileAddCommand,
  buildTunnelStartReplayCommand,
} from './cli-tunnel-utils.js';

describe('FRPC tunnel replay commands', () => {
  it('includes the endpoint mapping without adding an inline token placeholder', () => {
    const command = buildTunnelStartReplayCommand({
      port: 3000,
      provider: 'frpc',
      mode: 'managed-remote',
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      includeTokenPlaceholder: true,
    });

    expect(command).toContain('--frps-address 203.0.113.10');
    expect(command).toContain('--frps-port 7000');
    expect(command).toContain('--frps-ca-file /home/openchamber/frp/ca.crt');
    expect(command).toContain('--remote-port 18080');
    expect(command).toContain('--public-url https://app.example.com:18080');
    expect(command).not.toContain('--token ');
    expect(command).not.toContain('<redacted>');
  });

  it('suggests a token file instead of putting a token in profile commands', () => {
    const command = buildTunnelProfileAddCommand({
      provider: 'frpc',
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
    });

    expect(command).toContain('--token-file <path>');
    expect(command).toContain('--frps-ca-file /home/openchamber/frp/ca.crt');
    expect(command).toContain('--public-url https://app.example.com:18080');
    expect(command).not.toContain('--token <token>');
  });

  it('replays an HTTP-vhost endpoint without a stale remote port', () => {
    const command = buildTunnelStartReplayCommand({
      port: 3000,
      provider: 'frpc',
      mode: 'managed-remote',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: 'openchamber.internal',
      hostname: 'app.example.com',
      includeTokenPlaceholder: true,
    });

    expect(command).toContain('--custom-domain openchamber.internal');
    expect(command).toContain('--hostname app.example.com');
    expect(command).not.toContain('--remote-port');
    expect(command).not.toContain('--token ');
  });

  it('suggests the matching HTTP-vhost profile command', () => {
    const command = buildTunnelProfileAddCommand({
      provider: 'frpc',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: 'openchamber.internal',
      hostname: 'app.example.com',
    });

    expect(command).toContain('--custom-domain openchamber.internal');
    expect(command).toContain('--hostname app.example.com');
    expect(command).toContain('--token-file <path>');
    expect(command).not.toContain('--remote-port');
  });

  it('preserves strict output mode in replay commands', () => {
    const jsonCommand = buildTunnelStartReplayCommand({
      port: 3000,
      provider: 'cloudflare',
      mode: 'quick',
      json: true,
      quiet: true,
    });
    const quietCommand = buildTunnelStartReplayCommand({
      port: 3000,
      provider: 'cloudflare',
      mode: 'quick',
      quiet: true,
    });

    expect(jsonCommand).toContain('--provider cloudflare --mode quick');
    expect(jsonCommand).toContain('--json');
    expect(jsonCommand).not.toContain('--quiet');
    expect(quietCommand).toContain('--quiet');
  });
});
