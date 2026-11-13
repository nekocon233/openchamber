import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findVncBinary } from './environment.ts';
import { reserveDisplay } from './supervisor.ts';
import { messages } from '../panel/i18n.ts';
import { readDesktopStatus } from '../panel/model.ts';

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
});
