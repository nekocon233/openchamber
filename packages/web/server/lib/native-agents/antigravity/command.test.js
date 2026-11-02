import { describe, expect, it } from 'vitest';

import { resolveAgyCommand } from './command.js';

const options = (overrides = {}) => ({
  resolveExecutable: async () => '/usr/local/bin/agy',
  env: { HOME: '/home/test', PATH: '/usr/local/bin:/usr/bin' },
  shell: '/usr/bin/bash',
  platform: 'linux',
  ...overrides,
});

describe('Antigravity command resolution', () => {
  it('wraps a shell function so its environment applies', async () => {
    const calls = [];
    const command = await resolveAgyCommand(options({
      run: async (file, args, runOptions) => { calls.push({ file, args, runOptions }); return { stdout: 'function\n' }; },
    }));
    expect(command).toEqual({ executable: '/usr/bin/bash', argsPrefix: ['-ic', 'agy "$@"', '--'] });
    expect(calls).toEqual([{ file: '/usr/bin/bash', args: ['-ic', 'type -t agy'], runOptions: expect.objectContaining({ env: options().env }) }]);
  });

  it('keeps the executable for a file, an alias, or a shell without function detection', async () => {
    for (const [stdout, shell] of [['file\n', '/usr/bin/bash'], ['alias\n', '/usr/bin/zsh'], ['function\n', '/bin/sh']]) {
      const command = await resolveAgyCommand(options({ shell, run: async () => ({ stdout }) }));
      expect(command).toEqual({ executable: '/usr/local/bin/agy', argsPrefix: [] });
    }
  });

  it('falls back to the executable when detection fails or the platform is Windows', async () => {
    await expect(resolveAgyCommand(options({ run: async () => { throw new Error('shell unavailable'); } })))
      .resolves.toEqual({ executable: '/usr/local/bin/agy', argsPrefix: [] });
    await expect(resolveAgyCommand(options({ platform: 'win32', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' })))
      .resolves.toEqual({ executable: '/usr/local/bin/agy', argsPrefix: [] });
  });

  it('refuses a missing executable', async () => {
    await expect(resolveAgyCommand(options({ resolveExecutable: async () => null }))).rejects.toMatchObject({ code: 'NATIVE_CLI_MISSING' });
  });
});
