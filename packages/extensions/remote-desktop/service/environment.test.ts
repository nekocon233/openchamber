import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { discoverDisplays, parsePasswd } from './environment.ts';
import { reserveDisplay } from './supervisor.ts';
import { messages } from '../panel/i18n.ts';
import { readDesktopStatus } from '../panel/model.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('desktop environment boundary', () => {
  test('identifies only real X11 sockets owned by a known accessible user', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-x11-test-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const sockets = path.join(root, 'sockets'); const proc = path.join(root, 'proc');
    await fs.mkdir(sockets); await fs.mkdir(proc);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(sockets, 'X7'), resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await fs.writeFile(path.join(sockets, 'X8'), 'ordinary file');
    const uid = process.getuid!(); const gid = process.getgid!();
    const users = parsePasswd(`example:x:${uid}:${gid}:Example:${root}:/bin/sh\ninvalid`);
    expect(users).toEqual([{ name: 'example', uid, gid, home: root }]);
    const displays = await discoverDisplays(sockets, proc, users);
    expect(displays.map((item) => ({ display: item.display, uid: item.uid }))).toEqual([{ display: ':7', uid }]);
    expect(await discoverDisplays(path.join(root, 'absent'), proc, users)).toEqual([]);
  });
  test('reserves distinct display numbers and releases only its reservation', async () => {
    const first = await reserveDisplay(9910, 9920); cleanups.push(first.release);
    const second = await reserveDisplay(9910, 9920); cleanups.push(second.release);
    expect(first.display).not.toBe(second.display);
    await first.release();
    const third = await reserveDisplay(9910, 9920); cleanups.push(third.release);
    expect(third.display).toBe(first.display);
  });
  test('covers every host language with complete translated strings', () => {
    const locales = ['en', 'de', 'fr', 'nl', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja', 'tr', 'ar', 'he'] as const;
    expect(Object.keys(messages).sort()).toEqual([...locales].sort());
    const keys = Object.keys(messages.en!).sort();
    for (const locale of locales) {
      const dictionary = messages[locale];
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      expect(Object.values(dictionary).every((value) => value.trim().length > 0)).toBe(true);
      if (locale !== 'en') expect(dictionary.START_FAILED).not.toBe(messages.en!.START_FAILED);
    }
  });
  test('refuses partial or failed status data instead of presenting an empty desktop list', () => {
    expect(() => readDesktopStatus('{"error":"UNAUTHORIZED"}')).toThrow();
    expect(() => readDesktopStatus('{"platform":"linux","displays":[],"missing":{"physical":[],"virtual":["UNKNOWN"]},"sessions":[],"install":{"debian":"","fedora":"","arch":""}}')).toThrow();
    expect(readDesktopStatus('{"platform":"linux","displays":[],"missing":{"physical":["NO_X11"],"virtual":[]},"sessions":[],"install":{"debian":"","fedora":"","arch":""}}').missing.physical).toEqual(['NO_X11']);
  });
});

test.skipIf(process.getuid?.() !== 0)('uses the X11 desktop session UID when the display socket belongs to root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-root-x11-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const sockets = path.join(root, 'sockets'); const proc = path.join(root, 'proc'); const desktop = path.join(proc, '1234');
  await fs.mkdir(sockets); await fs.mkdir(desktop, { recursive: true }); await fs.chown(desktop, 1001, 1001);
  const authority = path.join(root, 'Xauthority'); await fs.writeFile(authority, 'fixture'); await fs.chown(authority, 1001, 1001);
  await fs.writeFile(path.join(desktop, 'comm'), 'gnome-shell\n');
  await fs.writeFile(path.join(desktop, 'environ'), `DISPLAY=:7\0XAUTHORITY=${authority}\0XDG_SESSION_TYPE=x11\0`);
  const server = net.createServer(); await new Promise<void>((resolve) => server.listen(path.join(sockets, 'X7'), resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const displays = await discoverDisplays(sockets, proc, [{ name: 'root', uid: 0, gid: 0, home: '/root' }, { name: 'desktop', uid: 1001, gid: 1001, home: root }]);
  expect(displays).toMatchObject([{ display: ':7', uid: 1001, authority }]);
});
