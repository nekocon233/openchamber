import { describe, expect, it, vi } from 'vitest';
import { createAntigravityCommands } from './commands.js';

describe('Antigravity skill commands', () => {
  it('parses tab-separated skills, coalesces reads and expires directory-scoped cache entries', async () => {
    let time = 0;
    const readSkills = vi.fn(async () => 'sample-skill\tDescription with spaces\r\nignored diagnostic\r\nsample-skill\tDuplicate\r\n2nd-skill\tSecond\r\n');
    const commands = createAntigravityCommands({ readSkills, now: () => time });
    const [a, b] = await Promise.all([commands.list('/a'), commands.list('/a')]);
    expect(a).toEqual({ commands: [{ name: 'sample-skill', description: 'Description with spaces', argumentHint: '' }, { name: '2nd-skill', description: 'Second', argumentHint: '' }] });
    expect(b).toBe(a);
    expect(readSkills).toHaveBeenCalledTimes(1);
    await commands.list('/b');
    expect(readSkills).toHaveBeenCalledTimes(2);
    time = 600_000;
    await commands.list('/a');
    expect(readSkills).toHaveBeenCalledTimes(3);
  });

  it('does no discovery for ordinary prose, absolute files or non-leading slashes', async () => {
    const readSkills = vi.fn();
    const commands = createAntigravityCommands({ readSkills });
    for (const text of ['Ordinary prompt', '/tmp/file.txt', 'Use /sample-skill here']) {
      const parts = [{ type: 'text', text }];
      expect(await commands.promptParts(parts, '/a')).toBe(parts);
    }
    expect(readSkills).not.toHaveBeenCalled();
  });

  it('rechecks a selected skill on submission and preserves arguments and attachment order', async () => {
    const readSkills = vi.fn(async () => 'sample-skill\tDescription\n');
    const commands = createAntigravityCommands({ readSkills });
    await commands.list('/a');
    const attachment = { type: 'file', mime: 'text/plain', url: 'file:///a/input.txt' };
    const instructions = { type: 'text', text: '<openchamber-instructions>Feature rules</openchamber-instructions>' };
    const result = await commands.promptParts([{ type: 'text', text: '/sample-skill first\nsecond' }, attachment, instructions], '/a');
    expect(result[0].text).toBe('Use the "sample-skill" skill. Read and follow its instructions before handling this request.\n\nfirst\nsecond');
    expect(result.slice(1)).toEqual([attachment, instructions]);
    expect(readSkills).toHaveBeenCalledTimes(2);
    readSkills.mockResolvedValue('');
    await expect(commands.promptParts([{ type: 'text', text: '/sample-skill' }], '/a')).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_COMMAND_UNSUPPORTED' });
  });

  it('rejects unsupported terminal controls before a prompt can be sent', async () => {
    const commands = createAntigravityCommands({ readSkills: async () => 'sample\tDescription\n' });
    for (const name of ['compact', 'help', 'permissions', 'missing']) {
      await expect(commands.promptParts([{ type: 'text', text: `/${name}` }], '/a')).rejects.toMatchObject({ status: 400, code: 'NATIVE_ANTIGRAVITY_COMMAND_UNSUPPORTED' });
    }
  });

  it('does not cache failed or unreadable listings', async () => {
    const readSkills = vi.fn().mockRejectedValueOnce(new Error('CLI failed')).mockResolvedValueOnce('unreadable output').mockResolvedValue('sample\tReady\n');
    const commands = createAntigravityCommands({ readSkills });
    await expect(commands.list('/a')).rejects.toThrow('CLI failed');
    await expect(commands.list('/a')).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_COMMANDS_UNAVAILABLE' });
    expect((await commands.list('/a')).commands[0].name).toBe('sample');
    expect(readSkills).toHaveBeenCalledTimes(3);
  });

  it('retains a fresh submission listing when an earlier directory read fails later', async () => {
    let rejectOld;
    const readSkills = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; })).mockResolvedValue('sample\tCurrent\n');
    const commands = createAntigravityCommands({ readSkills });
    const old = commands.list('/a');
    const failure = expect(old).rejects.toThrow('old read failed');
    await Promise.resolve();
    await commands.promptParts([{ type: 'text', text: '/sample' }], '/a');
    rejectOld(new Error('old read failed'));
    await failure;
    expect((await commands.list('/a')).commands[0].name).toBe('sample');
    expect(readSkills).toHaveBeenCalledTimes(2);
  });

  it('bounds retained directory listings', async () => {
    const readSkills = vi.fn(async () => 'sample\tDescription\n');
    const commands = createAntigravityCommands({ readSkills });
    for (let index = 0; index < 65; index += 1) await commands.list(`/project-${index}`);
    await commands.list('/project-0');
    expect(readSkills).toHaveBeenCalledTimes(66);
  });
});
