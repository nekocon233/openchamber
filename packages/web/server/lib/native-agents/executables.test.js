import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCliResolver, isWindowsShim } from './executables.js';
import { cliCommand } from './process.js';

const HOME = path.join('/', 'home', 'ada');

const resolverOver = ({ onPath = {}, files = [], platform = 'darwin' }) => {
  const present = new Set(files);
  return createCliResolver({
    searchPathFor: (name) => onPath[name] ?? null,
    isExecutable: (candidate) => present.has(candidate) || Object.values(onPath).includes(candidate),
    buildSearchPath: () => '/usr/bin',
    home: HOME,
    platform,
  });
};

describe('CLI resolution', () => {
  it('takes the CLI on PATH first, then the installer folders', async () => {
    const fromPath = resolverOver({ onPath: { claude: '/opt/bin/claude' }, files: [path.join(HOME, '.local', 'bin', 'claude')] });
    expect(await fromPath('claude')).toBe('/opt/bin/claude');

    const installed = resolverOver({ files: [path.join(HOME, '.local', 'bin', 'codex')] });
    expect(await installed('codex')).toBe(path.join(HOME, '.local', 'bin', 'codex'));
    expect(await installed('claude')).toBeNull();
  });

  it('prefers a native Windows build over an npm shim found first on PATH', async () => {
    const shim = 'C:\\npm\\claude.cmd';
    const exe = path.join(HOME, '.local', 'bin', 'claude.exe');
    expect(await resolverOver({ onPath: { claude: shim }, files: [exe], platform: 'win32' })('claude')).toBe(exe);
    // With no native build the shim is still reported; starting it is the caller's decision.
    expect(await resolverOver({ onPath: { claude: shim }, platform: 'win32' })('claude')).toBe(shim);
  });

  it('knows a shim only on Windows', () => {
    expect(isWindowsShim('C:\\npm\\codex.CMD', 'win32')).toBe(true);
    expect(isWindowsShim('C:\\npm\\codex.bat', 'win32')).toBe(true);
    expect(isWindowsShim('C:\\bin\\codex.exe', 'win32')).toBe(false);
    expect(isWindowsShim('/tmp/tool.cmd', 'linux')).toBe(false);
  });

  it('starts a Windows shim through cmd.exe and anything else directly', () => {
    expect(cliCommand('C:\\npm\\codex.cmd', ['app-server', '--listen', 'stdio://'], { platform: 'win32', comSpec: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'C:\\npm\\codex.cmd', 'app-server', '--listen', 'stdio://'],
    });
    expect(cliCommand('C:\\bin\\codex.exe', ['app-server'], { platform: 'win32' })).toEqual({ command: 'C:\\bin\\codex.exe', args: ['app-server'] });
    expect(cliCommand('/usr/local/bin/codex', ['app-server'], { platform: 'darwin' })).toEqual({ command: '/usr/local/bin/codex', args: ['app-server'] });
  });
});
