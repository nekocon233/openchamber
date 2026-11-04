import { describe, expect, it } from 'vitest';
import { mapAgyTool } from './tools.js';

describe('Antigravity tool presentation', () => {
  it('retains read coordinates and describes native searches', () => {
    expect(mapAgyTool({ name: 'read_file', argumentsEncoded: false, args: { Path: '/repo/a.txt', StartLine: 100, EndLine: 110 } }))
      .toMatchObject({ tool: 'read', input: { filePath: '/repo/a.txt', offset: 100, limit: 11 } });
    expect(mapAgyTool({ name: 'search_web', argumentsEncoded: false, args: { query: 'native tools', domain: 'example.org' } }))
      .toMatchObject({ tool: 'websearch', input: { query: 'native tools', domain: 'example.org' }, title: 'native tools' });
  });

  it('normalizes every replacement chunk without discarding its text', () => {
    expect(mapAgyTool({ name: 'multi_replace_file_content', argumentsEncoded: false, args: {
      TargetFile: '/repo/a.txt', ReplacementChunks: [
        { TargetContent: 'first', ReplacementContent: '', StartLine: 10, EndLine: 10 },
        { TargetContent: 'second', ReplacementContent: 'changed', StartLine: 30, EndLine: 30 },
      ],
    } })).toMatchObject({ tool: 'edit', input: { filePath: '/repo/a.txt', edits: [
      { oldString: 'first', newString: '' }, { oldString: 'second', newString: 'changed' },
    ] } });
  });
  it('keeps prototype-like tool names and keys as data', () => {
    expect(mapAgyTool({ name: 'constructor', argumentsEncoded: false, args: {} }).tool).toBe('constructor');
    const args = JSON.parse('{"__proto__":{"Path":"/outside"}}');
    const mapped = mapAgyTool({ name: 'read_file', argumentsEncoded: false, args });
    expect(mapped.input.filePath).toBeUndefined();
    expect(Object.hasOwn(mapped.input, '__proto__')).toBe(true);
  });

  it.each(['true', 'null', '123', '"quoted"', '{"value":1}'])('keeps literal text %s in full logs and stream parameters', (value) => {
    expect(mapAgyTool({ name: 'edit_file', argumentsEncoded: false, args: { Path: '/repo/a.json', Target: value, Replacement: value } }).input).toEqual({ filePath: '/repo/a.json', oldString: value, newString: value });
    expect(mapAgyTool({ name: 'run_command', argumentsEncoded: false, args: { CommandLine: value } }).input.command).toBe(value);
    expect(mapAgyTool({ name: 'write_file', argumentsEncoded: true, args: { Path: '"/repo/a.json"', Content: JSON.stringify(value) } }).input.content).toBe(value);
  });

  it('normalizes recorded file and command arguments for the shared renderers', () => {
    expect(mapAgyTool({ name: 'read_file', args: { Path: '"/repo/a.txt"', StartLine: '1', EndLine: '4' } })).toMatchObject({ tool: 'read', input: { filePath: '/repo/a.txt', StartLine: 1, EndLine: 4 } });
    expect(mapAgyTool({ name: 'edit_file', args: { Path: '/repo/a.txt', Target: 'before', Replacement: 'after' } })).toEqual({ tool: 'edit', input: { filePath: '/repo/a.txt', oldString: 'before', newString: 'after' }, title: '/repo/a.txt' });
    expect(mapAgyTool({ name: 'write_file', args: { Path: '/repo/new.txt', Content: 'hello' } })).toMatchObject({ tool: 'write', input: { filePath: '/repo/new.txt', content: 'hello' } });
    expect(mapAgyTool({ name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run tests"' } })).toEqual({ tool: 'bash', input: { command: 'npm test' }, title: 'Run tests' });
  });

  it('retains unfamiliar and malformed tool input rather than inventing a file target', () => {
    expect(mapAgyTool({ name: 'edit_file', args: { Path: 7, Target: 'before' } })).toEqual({ tool: 'edit', input: { Path: 7, Target: 'before' }, title: 'edit_file' });
    expect(mapAgyTool({ name: 'edit_file', args: { Path: '/repo/file.txt' } })).toMatchObject({ tool: 'edit', input: { filePath: '/repo/file.txt' } });
    expect(mapAgyTool({ name: 'multi_replace_file_content', args: { TargetFile: '/repo/file.txt', ReplacementChunks: [] } })).toMatchObject({ tool: 'edit', input: { filePath: '/repo/file.txt', ReplacementChunks: [] } });
    expect(mapAgyTool({ name: 'manage_task', args: { Action: 'status', TaskId: 'native/task-2' } })).toMatchObject({ tool: 'manage_task', input: { Action: 'status', TaskId: 'native/task-2' } });
  });
});
