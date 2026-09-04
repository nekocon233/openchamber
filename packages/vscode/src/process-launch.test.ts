import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutableInPath, resolveWindowsLaunchSpec } from './process-launch';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-process-launch-'));

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('cross-platform process launch', () => {
  test('finds and launches a Windows command shim through cmd.exe', () => {
    const shim = path.join(fixtureRoot, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    const env = { PATH: fixtureRoot, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

    assert.equal(findExecutableInPath('claude', { platform: 'win32', env }), shim);
    assert.deepEqual(resolveWindowsLaunchSpec(shim, ['auth', 'status'], { platform: 'win32', env }), {
      binary: env.ComSpec,
      args: ['/d', '/s', '/c', 'call', shim, 'auth', 'status'],
    });
  });

  test('leaves native Unix executables direct', () => {
    assert.deepEqual(resolveWindowsLaunchSpec('/usr/local/bin/claude', ['auth'], { platform: 'darwin' }), {
      binary: '/usr/local/bin/claude',
      args: ['auth'],
    });
  });
});
