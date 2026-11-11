import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';

import {
  importCandidates,
  importSpecifierAt,
  joinPath,
  parseTsconfigPaths,
  relativeImportAt,
  resolveImportSpecifier,
  resolveRelativeImport,
  type ListDirectoryNames,
} from './importLinks';

const linkAt = (doc: string, needle: string) => {
  const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  return relativeImportAt(state, doc.indexOf(needle) + 1)?.specifier ?? null;
};

describe('relativeImportAt', () => {
  test('finds relative paths in imports, re-exports, dynamic imports and require', () => {
    expect(linkAt(`import a from './a';`, './a')).toBe('./a');
    expect(linkAt(`export { b } from "../b";`, '../b')).toBe('../b');
    expect(linkAt(`const d = await import('./d');`, './d')).toBe('./d');
    expect(linkAt(`const e = require('./e');`, './e')).toBe('./e');
  });

  test('ignores packages, aliases and strings that are not imports', () => {
    expect(linkAt(`import React from 'react';`, 'react')).toBeNull();
    expect(linkAt(`import x from '@/lib/x';`, '@/lib')).toBeNull();
    expect(linkAt(`const s = './not-an-import';`, './not')).toBeNull();
    expect(linkAt(`const e = load('./e');`, './e')).toBeNull();
  });

  test('importSpecifierAt extracts alias specifiers too', () => {
    const doc = `import x from '@/lib/x';`;
    const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
    ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(importSpecifierAt(state, doc.indexOf('@/lib') + 1)?.specifier).toBe('@/lib/x');
  });
});

describe('resolving a relative or tsconfig-aliased import', () => {
  test('joins and folds the path', () => {
    expect(joinPath('/repo/src/lib', '../ui/./button')).toBe('/repo/src/ui/button');
    expect(importCandidates('/repo/src/a.ts', './b.js').slice(0, 3)).toEqual(['/repo/src/b.js', '/repo/src/b.ts', '/repo/src/b.tsx']);
  });

  const tree = new Map([
    ['/repo/src', new Map([['a.ts', false], ['b.ts', false], ['c.tsx', false], ['lib', true], ['styles.css', false]])],
    ['/repo/src/lib', new Map([['index.ts', false], ['utils.ts', false]])],
  ]);
  const listNames: ListDirectoryNames = async (directory) => {
    const names = tree.get(directory);
    if (!names) throw new Error(`listed a folder that does not exist: ${directory}`);
    return names;
  };

  test('finds the source file the way a bundler would', async () => {
    expect(await resolveRelativeImport('/repo/src/a.ts', './b', listNames)).toEqual({ status: 'found', path: '/repo/src/b.ts' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './b.js', listNames)).toEqual({ status: 'found', path: '/repo/src/b.ts' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './c', listNames)).toEqual({ status: 'found', path: '/repo/src/c.tsx' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './lib', listNames)).toEqual({ status: 'found', path: '/repo/src/lib/index.ts' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './styles.css', listNames)).toEqual({ status: 'found', path: '/repo/src/styles.css' });
  });

  test('resolves tsconfig path aliases with comments and trailing commas', async () => {
    const tsconfig = `{
      // tsconfig with comments
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["./src/*"],
        },
      }
    }`;
    const mappings = parseTsconfigPaths(tsconfig, '/repo');
    expect(await resolveImportSpecifier('/repo/src/a.ts', '@/lib/utils', listNames, mappings)).toEqual({
      status: 'found',
      path: '/repo/src/lib/utils.ts',
    });
    expect(await resolveImportSpecifier('/repo/src/a.ts', '@/c', listNames, mappings)).toEqual({
      status: 'found',
      path: '/repo/src/c.tsx',
    });
  });

  test('resolves monorepo workspace packages across modules and packages folders', async () => {
    const monorepoTree = new Map([
      ['/opt/perohub/packages', new Map([['host-sdk', true]])],
      ['/opt/perohub/packages/host-sdk', new Map([['src', true]])],
      ['/opt/perohub/packages/host-sdk/src', new Map([['index.ts', false], ['bff.ts', false]])],
    ]);
    const listMonorepo: ListDirectoryNames = async (dir) => monorepoTree.get(dir) ?? null;

    expect(await resolveImportSpecifier(
      '/opt/perohub/modules/hr/web/src/sdk.ts',
      '@peroperogames/host-sdk',
      listMonorepo,
      [],
      '/opt/perohub',
    )).toEqual({
      status: 'found',
      path: '/opt/perohub/packages/host-sdk/src/index.ts',
    });

    expect(await resolveImportSpecifier(
      '/opt/perohub/modules/hr/server/src/main.ts',
      '@peroperogames/host-sdk/bff',
      listMonorepo,
      [],
      '/opt/perohub',
    )).toEqual({
      status: 'found',
      path: '/opt/perohub/packages/host-sdk/src/bff.ts',
    });
  });

  test('a missing file is missing, without listing folders that are not there', async () => {
    expect(await resolveRelativeImport('/repo/src/a.ts', './nope', listNames)).toEqual({ status: 'missing' });
  });

  test('a listing that fails is not reported as a missing file', async () => {
    const failing: ListDirectoryNames = async () => null;
    expect(await resolveRelativeImport('/repo/src/a.ts', './b', failing)).toEqual({ status: 'failed' });
  });
});
