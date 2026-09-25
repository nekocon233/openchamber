import { describe, expect, it } from 'vitest';

import { createCodexCommands, parseCodexCommand } from './commands.js';

const directory = '/work/project';
const skill = { name: 'audit', path: '/work/project/.agents/skills/audit/SKILL.md', description: 'Audit code', enabled: true };
const response = (skills = [skill], errors = []) => ({ data: [{ cwd: directory, skills, errors }] });

describe('Codex slash commands', () => {
  it('keeps paths, prose and inline commands out of the command parser', () => {
    for (const text of ['/work/file.ts', 'Explain /model', '/', 'https://example.test/skills']) {
      expect(parseCodexCommand(text)).toBeNull();
    }
    expect(parseCodexCommand(' /audit line one\nline two ')).toEqual({ name: 'audit', argument: 'line one\nline two' });
  });

  it('discovers enabled skills in the requested directory, including changes since the last listing', async () => {
    let enabled = true;
    const requests = [];
    const commands = createCodexCommands({ request: async (method, params) => {
      requests.push({ method, params });
      return response([{ ...skill, enabled }]);
    } });
    expect((await commands.list(directory)).commands.map((entry) => entry.name)).toEqual(['audit']);
    enabled = false;
    expect((await commands.list(directory)).commands).toEqual([]);
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({ method: 'skills/list', params: { cwds: [directory], forceReload: true } })));
  });

  it('sends an explicit native skill input and preserves arguments and attached context', async () => {
    const commands = createCodexCommands({ request: async () => response() });
    expect(await commands.promptInput([
      { type: 'text', text: '/audit inspect auth\nand permissions' },
      { type: 'file', mime: 'image/png', url: 'file:///work/screenshot.png' },
      { type: 'text', text: '<openchamber-instructions>Keep the review focused.</openchamber-instructions>' },
    ], directory)).toEqual([
      { type: 'text', text: '$audit inspect auth\nand permissions' },
      { type: 'localImage', path: '/work/screenshot.png' },
      { type: 'text', text: '<openchamber-instructions>Keep the review focused.</openchamber-instructions>' },
      { type: 'skill', name: skill.name, path: skill.path },
    ]);
  });

  it('never sends an unknown or disabled command to the model as ordinary text', async () => {
    const commands = createCodexCommands({ request: async () => response([{ ...skill, enabled: false }]) });
    for (const text of ['/audit', '/permissions', '/does-not-exist']) {
      await expect(commands.promptInput([{ type: 'text', text }], directory)).rejects.toMatchObject({ code: 'NATIVE_CODEX_COMMAND_UNSUPPORTED' });
    }
  });

  it('propagates transport and malformed-list failures instead of claiming an empty list', async () => {
    const offline = createCodexCommands({ request: async () => { throw new Error('offline'); } });
    await expect(offline.list(directory)).rejects.toThrow('offline');
    await expect(offline.promptInput([{ type: 'text', text: '/audit' }], directory)).rejects.toThrow('offline');
    const malformed = createCodexCommands({ request: async () => ({ data: null }) });
    await expect(malformed.list(directory)).rejects.toThrow();
  });

  it('keeps valid skills when another skill is broken and reports the discovery error', async () => {
    const commands = createCodexCommands({ request: async () => response([skill], [{ path: '/broken/SKILL.md', message: 'Invalid frontmatter' }]) });
    const list = await commands.list(directory);
    expect(list.commands.map((entry) => entry.name)).toEqual(['audit']);
    expect(list.warnings).toEqual(['/broken/SKILL.md: Invalid frontmatter']);
    const inspection = await commands.inspect({ name: 'skills', directory });
    expect(inspection.entries[0].command).toBe('/audit ');
    expect(inspection.notices).toEqual(list.warnings);
  });

  it('passes ordinary prompts without any discovery request and expands init deliberately', async () => {
    const commands = createCodexCommands({ request: async () => { throw new Error('must not request'); } });
    expect(await commands.promptInput([{ type: 'text', text: 'Fix the test' }], directory)).toEqual([{ type: 'text', text: 'Fix the test' }]);
    expect((await commands.promptInput([{ type: 'text', text: '/init Focus on tests' }], directory))[0].text).toContain('Focus on tests');
  });

  it('paginates MCP tools without exposing connection configuration or unrelated response fields', async () => {
    const requests = [];
    const commands = createCodexCommands({ request: async (method, params) => {
      requests.push({ method, params });
      return { data: [{ name: params.cursor ? 'second' : 'first', authStatus: 'notLoggedIn', tools: { read: { name: 'read', inputSchema: { secret: 'not-for-display' } } }, configuration: 'not-for-display' }], nextCursor: params.cursor ? null : 'next' };
    } });
    const result = await commands.inspect({ name: 'mcp', directory, threadId: 'thread-1' });
    expect(result.entries.map((entry) => entry.label)).toEqual(['first', 'second']);
    expect(JSON.stringify(result)).not.toContain('not-for-display');
    expect(requests[1]).toMatchObject({ method: 'mcpServerStatus/list', params: { cursor: 'next', threadId: 'thread-1' } });
  });

  it('stops only background terminals of the selected thread', async () => {
    const requests = [];
    const commands = createCodexCommands({ request: async (method, params) => { requests.push({ method, params }); return {}; } });
    await commands.inspect({ name: 'stop', directory, threadId: 'thread-1' });
    expect(requests).toEqual([{ method: 'thread/backgroundTerminals/clean', params: { threadId: 'thread-1' } }]);
    await expect(commands.inspect({ name: 'stop', directory })).rejects.toThrow('requires a Codex session');
  });

  it('requires a thread for MCP inspection and includes tool details only for verbose output', async () => {
    const commands = createCodexCommands({ request: async () => ({ data: [{ name: 'docs', authStatus: 'notLoggedIn', tools: { search: { name: 'search', description: 'Search the documentation' } }, serverInfo: { name: 'Docs', version: '1.2' } }] }) });
    await expect(commands.inspect({ name: 'mcp', directory })).rejects.toThrow('requires a Codex session');
    expect((await commands.inspect({ name: 'mcp', directory, threadId: 'thread-1' })).entries[0].detail).toBe('notLoggedIn\nsearch');
    expect((await commands.inspect({ name: 'mcp', directory, threadId: 'thread-1', verbose: true })).entries[0].detail).toBe('notLoggedIn\nDocs 1.2\nsearch: Search the documentation');
  });
});
