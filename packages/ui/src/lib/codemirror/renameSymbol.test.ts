import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { csharp } from '@replit/codemirror-lang-csharp';
import { findScopeRenameRanges } from './renameSymbol';

describe('findScopeRenameRanges', () => {
  test('scopes parameter and local variable renames to the enclosing function without touching strings or outer bindings', () => {
    const doc = [
      'const value = 100;',
      'function calculate(value: number) {',
      '  const label = "value"; // value in comment',
      '  return value * 2;',
      '}',
      'console.log(value);',
    ].join('\n');
    const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
    const innerPos = doc.indexOf('value * 2') + 1;
    const target = findScopeRenameRanges(state, innerPos);
    expect(target?.name).toBe('value');
    expect(target?.ranges.map((r) => state.doc.lineAt(r.from).number)).toEqual([2, 4]);
  });

  test('renames top-level functions across the entire file', () => {
    const doc = [
      'export function runTask() {}',
      'const a = runTask();',
      'const b = "runTask";',
      'runTask();',
    ].join('\n');
    const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
    const target = findScopeRenameRanges(state, doc.indexOf('runTask') + 2);
    expect(target?.name).toBe('runTask');
    expect(target?.ranges.map((r) => state.doc.lineAt(r.from).number)).toEqual([1, 2, 4]);
  });

  test('scopes C# method local variables to the method body', () => {
    const doc = [
      'public class Calculator {',
      '  private int count = 0;',
      '  public int Add(int step) {',
      '    var count = step + 1;',
      '    return count;',
      '  }',
      '  public int Read() { return count; }',
      '}',
    ].join('\n');
    const state = EditorState.create({ doc, extensions: [csharp()] });
    const localPos = doc.indexOf('return count;') + 8;
    const target = findScopeRenameRanges(state, localPos);
    expect(target?.name).toBe('count');
    expect(target?.ranges.map((r) => state.doc.lineAt(r.from).number)).toEqual([4, 5]);
  });
});
