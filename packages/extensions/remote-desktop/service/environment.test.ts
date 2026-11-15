import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBrowserCommand, findBrowserBinary, findVncBinary } from './environment.ts';
import { reserveDisplay } from './supervisor.ts';
import { desktopOpenUrlSchema } from '../contract.ts';
import { messages } from '../panel/i18n.ts';
import { readDesktopStatus, readDesktopUrlItem, readFailure } from '../panel/model.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('desktop environment boundary', () => {
  test('selects only native ELF VNC server binaries so distribution wrappers cannot escape group cleanup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vnc-bin-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const wrapper = path.join(root, 'Xtigervnc');
    const native = path.join(root, 'Xvnc');
    await fs.writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), { mode: 0o755 });
    expect(await findVncBinary(['Xtigervnc', 'Xvnc'], root)).toBe(native);
    expect(await findVncBinary(['Xtigervnc'], root)).toBeNull();
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

  test('refuses partial or failed status data instead of presenting an empty status', () => {
    expect(() => readDesktopStatus('{"error":"UNAUTHORIZED"}')).toThrow();
    expect(() => readDesktopStatus('{"platform":"linux","missing":["UNKNOWN"],"session":null,"install":{"debian":"","fedora":"","arch":""}}')).toThrow();
    expect(readDesktopStatus('{"platform":"linux","missing":["NO_VIRTUAL_SERVER"],"session":null,"install":{"debian":"","fedora":"","arch":""}}').missing).toEqual(['NO_VIRTUAL_SERVER']);
  });

  test('resolves browser binaries and builds maximized persistent Chromium commands without --new-window', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-browser-bin-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const firefox = path.join(root, 'firefox');
    await fs.writeFile(firefox, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await findBrowserBinary(root)).toEqual({ path: firefox, kind: 'firefox' });

    const chrome = path.join(root, 'google-chrome');
    await fs.writeFile(chrome, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await findBrowserBinary(root)).toEqual({ path: chrome, kind: 'chromium' });

    const nonRoot = buildBrowserCommand({ path: chrome, kind: 'chromium' }, 'https://example.test/app?a=1', {
      profileDir: '/home/openchamber/.config/openchamber/remote-desktop-browser',
      uid: 1000,
    });
    expect(nonRoot.args).toContain('--user-data-dir=/home/openchamber/.config/openchamber/remote-desktop-browser');
    expect(nonRoot.args).toContain('--start-maximized');
    expect(nonRoot.args).not.toContain('--new-window');
    expect(nonRoot.args).not.toContain('--no-sandbox');
    expect(nonRoot.args.slice(-2)).toEqual(['--', 'https://example.test/app?a=1']);

    const asRoot = buildBrowserCommand({ path: chrome, kind: 'chromium' }, 'http://127.0.0.1:3000/', {
      profileDir: '/root/.config/openchamber/remote-desktop-browser',
      uid: 0,
    });
    expect(asRoot.args).toContain('--no-sandbox');
    expect(buildBrowserCommand({ path: firefox, kind: 'firefox' }, 'https://example.test/', { profileDir: '/tmp/p', uid: 1000 }).args)
      .toEqual(['--new-tab', 'https://example.test/']);
  });

  test('validates open-url requests and desktop URL items strictly to http/https', () => {
    expect(desktopOpenUrlSchema.parse({ url: 'https://example.test/page', width: 1200, height: 800 })).toEqual({
      url: 'https://example.test/page',
      width: 1200,
      height: 800,
    });
    for (const invalid of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', '']) {
      expect(() => desktopOpenUrlSchema.parse({ url: invalid })).toThrow();
    }
    expect(readDesktopUrlItem({
      providerId: 'openchamber-builtin-desktop',
      id: 'req-1',
      title: 'Example',
      url: 'https://example.test/chat',
    })).toEqual({ id: 'req-1', url: 'https://example.test/chat' });
    expect(readDesktopUrlItem({
      providerId: 'other-extension',
      id: 'req-2',
      title: 'Other',
      url: 'https://example.test/chat',
    })).toBeNull();
    expect(readDesktopUrlItem({
      providerId: 'openchamber-builtin-desktop',
      id: 'req-3',
      title: 'Bad',
      url: 'file:///etc/passwd',
    })).toBeNull();
    expect(readFailure('not-json', 'BROWSER_FAILED')).toBe('BROWSER_FAILED');
    expect(readFailure('{"error":"NO_BROWSER"}')).toBe('NO_BROWSER');
  });
});
