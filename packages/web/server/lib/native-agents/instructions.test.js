import { describe, expect, it, vi } from 'vitest';

import { createGlobalInstructionsReader } from './instructions.js';

const PATH = '/home/ada/.config/opencode/AGENTS.md';

const readerOver = (readFile) => createGlobalInstructionsReader({ filePath: PATH, readFile });

describe('global instructions', () => {
  it('names the file the rules come from, as OpenCode does', async () => {
    const read = readerOver(async () => '\n# Rules\nAnswer in English.\n\n');
    expect(await read()).toBe(`Instructions from: ${PATH}\n# Rules\nAnswer in English.`);
  });

  it('adds nothing for a missing or blank file', async () => {
    expect(await readerOver(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); })()).toBeNull();
    expect(await readerOver(async () => '  \n')()).toBeNull();
  });

  it('adds nothing, and says why, when the file cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readerOver(async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); })()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the file again for every start, so an edit applies to the next session', async () => {
    let content = 'First.';
    const read = readerOver(async () => content);
    expect(await read()).toBe(`Instructions from: ${PATH}\nFirst.`);
    content = 'Second.';
    expect(await read()).toBe(`Instructions from: ${PATH}\nSecond.`);
  });
});
