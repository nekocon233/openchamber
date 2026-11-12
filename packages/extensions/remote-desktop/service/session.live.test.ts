import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDesktopSessions } from './session.ts';
import { canConnect } from './supervisor.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const waitUntil = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 80; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Desktop cleanup did not complete');
};

describe.skipIf(process.env.OPENCHAMBER_DESKTOP_LIVE !== '1')('local TigerVNC lifecycle', () => {
  const setup = async (createDirectory?: () => Promise<string>) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-desktop-live-'));
    await fs.chmod(root, 0o755);
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const output = await Bun.build({ entrypoints: [path.join(import.meta.dir, 'main.ts')], target: 'node', outdir: root });
    if (!output.success) throw new Error('Service build failed');
    const sessions = createDesktopSessions(path.join(root, 'main.js'), createDirectory);
    cleanups.push(() => sessions.stopAll());
    return sessions;
  };
  test('keeps a virtual desktop through viewer changes, then removes ports and private files', async () => {
    const sessions = await setup();
    const session = await sessions.start('virtual');
    const second = await sessions.start('virtual'); expect(second.id).toBe(session.id);
    expect(await canConnect(session.port)).toBe(true);
    expect((await fs.stat(`/proc/${session.child!.pid}`)).uid).toBe(process.getuid?.());
    expect((await fs.stat(path.join(session.directory!, 'vnc-password'))).mode & 0o777).toBe(0o600);
    const release = sessions.watch(session, () => {}); release();
    expect(sessions.get(session.id)?.id).toBe(session.id);
    await sessions.stop('virtual');
    expect(await canConnect(session.port)).toBe(false);
    expect(await fs.stat(session.directory!).catch(() => null)).toBeNull();
    expect(await fs.stat(session.displayLock!).catch(() => null)).toBeNull();
  }, 20_000);
  test('an abruptly lost parent pipe terminates the VNC group and removes authentication files', async () => {
    const sessions = await setup(); const session = await sessions.start('virtual');
    session.child!.stdin!.destroy();
    await waitUntil(async () => !await canConnect(session.port));
    await waitUntil(async () => await fs.stat(session.directory!).catch(() => null) === null);
    await waitUntil(async () => await fs.stat(session.displayLock!).catch(() => null) === null);
  }, 20_000);
  test('captures two existing displays independently and preserves the virtual session on physical stop', async () => {
    const virtualOwner = await setup();
    const virtual = await virtualOwner.start('virtual');
    const secondVirtualOwner = await setup();
    const secondVirtual = await secondVirtualOwner.start('virtual');
    const physicalOwner = await setup();
    const first = await physicalOwner.start('physical', { display: secondVirtual.display });
    const second = await physicalOwner.start('physical', { display: virtual.display });
    expect(second.display).toBe(virtual.display);
    expect(second.id).not.toBe(first.id);
    expect(second.port).not.toBe(first.port);
    expect(await canConnect(first.port)).toBe(true);
    expect(await canConnect(second.port)).toBe(true);
    await physicalOwner.stop('physical');
    expect(await canConnect(first.port)).toBe(false);
    expect(await canConnect(second.port)).toBe(false);
    expect(await canConnect(virtual.port)).toBe(true);
  }, 20_000);

  test('an immediate retry waits for cancelled startup allocations before reusing the mode', async () => {
    let notify!: () => void; let release!: () => void;
    const reached = new Promise<void>((resolve) => { notify = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let directory = ''; let held = false;
    const sessions = await setup(async () => {
      const created = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-desktop-'));
      if (!held) { held = true; directory = created; notify(); await gate; }
      return created;
    });
    try {
      const starting = sessions.start('virtual');
      void starting.catch(() => undefined);
      await reached;
      const stopping = sessions.stop('virtual');
      const restarted = sessions.start('virtual');
      release();
      await expect(starting).rejects.toMatchObject({ code: 'STOPPED' }); await stopping;
      const next = await restarted;
      expect(next.directory).not.toBe(directory);
      expect(await fs.stat(directory).catch(() => null)).toBeNull();
      expect(await canConnect(next.port)).toBe(true);
    } finally { release(); }
  }, 20_000);

});
