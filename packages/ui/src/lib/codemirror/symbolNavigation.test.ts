import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { csharp } from '@replit/codemirror-lang-csharp';
import {
  findSymbolReferences,
  identifierAtPosition,
  parseWorkspaceSymbolMatches,
  resolveSymbolDefinitions,
} from './symbolNavigation';
import { parseTsconfigPaths } from './importLinks';

describe('symbolNavigation', () => {
  test('resolves local TypeScript definitions with lexical scope shadowing and JSDoc', async () => {
    const doc = [
      'const count = 1;',
      '/** Increments a counter */',
      'export function compute(count: number) {',
      '  const stringCount = "count"; // count in comment',
      '  return count + 1;',
      '}',
    ].join('\n');
    const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
    const returnCountPos = doc.lastIndexOf('count') + 1;
    const resolved = await resolveSymbolDefinitions(state, returnCountPos, {
      filePath: '/repo/src/math.ts',
      workspaceRoot: '/repo',
    });
    expect(resolved.symbolName).toBe('count');
    expect(resolved.locations).toHaveLength(1);
    expect(resolved.locations[0].line).toBe(3);

    const fnCallDoc = `${doc}\ncompute(10);`;
    const fnState = EditorState.create({ doc: fnCallDoc, extensions: [javascript({ typescript: true })] });
    const callPos = fnCallDoc.lastIndexOf('compute') + 1;
    const fnDef = await resolveSymbolDefinitions(fnState, callPos, {
      filePath: '/repo/src/math.ts',
      workspaceRoot: '/repo',
    });
    expect(fnDef.locations[0].line).toBe(3);
    expect(fnDef.locations[0].signature).toBe('export function compute(count: number)');
    expect(fnDef.locations[0].documentation).toBe('Increments a counter');
  });

  test('ignores identifiers inside strings and comments', () => {
    const doc = `const msg = "hello"; // commentWord`;
    const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
    expect(identifierAtPosition(state, doc.indexOf('hello') + 1)).toBeNull();
    expect(identifierAtPosition(state, doc.indexOf('commentWord') + 1)).toBeNull();
    expect(identifierAtPosition(state, doc.indexOf('msg') + 1)?.name).toBe('msg');
  });

  test('follows tsconfig-aliased imports to the target declaration in another file', async () => {
    const doc = [
      `import { formatUser as fmt } from '@/lib/user';`,
      `export const out = fmt('Ada');`,
    ].join('\n');
    const targetDoc = [
      `/** Formats a display name */`,
      `export function formatUser(name: string) {`,
      `  return name.trim();`,
      `}`,
    ].join('\n');
    const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
    const mappings = parseTsconfigPaths(`{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]}}}`, '/repo');
    const result = await resolveSymbolDefinitions(state, doc.lastIndexOf('fmt') + 1, {
      filePath: '/repo/src/app.ts',
      workspaceRoot: '/repo',
      tsconfigMappings: mappings,
      listDirectoryNames: async (dir) => {
        if (dir === '/repo/src') return new Map([['lib', true]]);
        if (dir === '/repo/src/lib') return new Map([['user.ts', false]]);
        return null;
      },
      readFileText: async (path) => (path === '/repo/src/lib/user.ts' ? targetDoc : null),
    });
    expect(result.symbolName).toBe('fmt');
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].path).toBe('/repo/src/lib/user.ts');
    expect(result.locations[0].line).toBe(2);
    expect(result.locations[0].documentation).toBe('Formats a display name');
  });

  test('chases cross-module monorepo packages and multi-hop barrel re-exports (e.g. hr -> contracts -> @peroperogames/host-sdk -> viewbar.ts)', async () => {
    const hrWorkspaceDoc = [
      `import type { HrDisplayViewMode } from "./contracts";`,
      `import { parseHrModuleContext } from "./sdk";`,
      `export const mode: HrDisplayViewMode = "adaptive";`,
    ].join('\n');
    const hrContractsDoc = [
      `export type {`,
      `  ViewBarDisplayMode as HrDisplayViewMode,`,
      `  ViewBarContribution,`,
      `} from "@peroperogames/host-sdk";`,
    ].join('\n');
    const hrSdkDoc = [
      `import { createModuleContextParser, HostContextError } from "@peroperogames/host-sdk";`,
      `export { HostContextError };`,
      `export const parseHrModuleContext = createModuleContextParser({ moduleId: "hr", permissions: [] });`,
    ].join('\n');
    const hostSdkIndexDoc = [
      `export type { ViewBarDisplayMode, ViewBarContribution } from "./viewbar.js";`,
      `export { createModuleContextParser, HostContextError } from "./context.js";`,
    ].join('\n');
    const hostSdkViewbarDoc = [
      `export type ViewBarDisplayMode = "list" | "grid" | "adaptive";`,
      `export type ViewBarContribution = { id: string };`,
    ].join('\n');
    const hostSdkContextDoc = [
      `export class HostContextError extends Error {}`,
      `export function createModuleContextParser(options: unknown) { return options; }`,
    ].join('\n');

    const filesMap = new Map<string, string>([
      ['/opt/perohub/modules/hr/web/src/HrWorkspace.tsx', hrWorkspaceDoc],
      ['/opt/perohub/modules/hr/web/src/contracts.ts', hrContractsDoc],
      ['/opt/perohub/modules/hr/web/src/sdk.ts', hrSdkDoc],
      ['/opt/perohub/packages/host-sdk/src/index.ts', hostSdkIndexDoc],
      ['/opt/perohub/packages/host-sdk/src/viewbar.ts', hostSdkViewbarDoc],
      ['/opt/perohub/packages/host-sdk/src/context.ts', hostSdkContextDoc],
    ]);
    const dirMap = new Map<string, Map<string, boolean>>([
      ['/opt/perohub/modules/hr/web/src', new Map([['HrWorkspace.tsx', false], ['contracts.ts', false], ['sdk.ts', false]])],
      ['/opt/perohub/packages', new Map([['host-sdk', true]])],
      ['/opt/perohub/packages/host-sdk', new Map([['src', true]])],
      ['/opt/perohub/packages/host-sdk/src', new Map([['index.ts', false], ['viewbar.ts', false], ['context.ts', false]])],
    ]);

    const navContext = (filePath: string) => ({
      filePath,
      workspaceRoot: '/opt/perohub',
      listDirectoryNames: async (dir: string) => dirMap.get(dir) ?? null,
      readFileText: async (path: string) => filesMap.get(path) ?? null,
    });

    // 1. In sdk.ts: jumping on `createModuleContextParser` (either at call site or import line) lands in packages/host-sdk/src/context.ts:2
    const sdkState = EditorState.create({ doc: hrSdkDoc, extensions: [javascript({ typescript: true })] });
    const callSiteDef = await resolveSymbolDefinitions(
      sdkState,
      hrSdkDoc.lastIndexOf('createModuleContextParser') + 3,
      navContext('/opt/perohub/modules/hr/web/src/sdk.ts'),
    );
    expect(callSiteDef.locations[0].path).toBe('/opt/perohub/packages/host-sdk/src/context.ts');
    expect(callSiteDef.locations[0].line).toBe(2);

    // 2. In sdk.ts: jumping on re-exported `HostContextError` lands in packages/host-sdk/src/context.ts:1 (never on `export { HostContextError }`)
    const reExportDef = await resolveSymbolDefinitions(
      sdkState,
      hrSdkDoc.lastIndexOf('HostContextError') + 3,
      navContext('/opt/perohub/modules/hr/web/src/sdk.ts'),
    );
    expect(reExportDef.locations[0].path).toBe('/opt/perohub/packages/host-sdk/src/context.ts');
    expect(reExportDef.locations[0].line).toBe(1);

    // 3. In HrWorkspace.tsx: jumping on `HrDisplayViewMode` chases `./contracts` -> `@peroperogames/host-sdk` -> `./viewbar.js`
    const wsState = EditorState.create({ doc: hrWorkspaceDoc, extensions: [javascript({ typescript: true })] });
    const typeAliasDef = await resolveSymbolDefinitions(
      wsState,
      hrWorkspaceDoc.lastIndexOf('HrDisplayViewMode') + 3,
      navContext('/opt/perohub/modules/hr/web/src/HrWorkspace.tsx'),
    );
    expect(typeAliasDef.locations[0].path).toBe('/opt/perohub/packages/host-sdk/src/viewbar.ts');
    expect(typeAliasDef.locations[0].line).toBe(1);
  });

  test('resolves C# local and cross-file definitions and references via ripgrep fallback', async () => {
    const csDoc = [
      'namespace App.Services {',
      '  public class OrderService {',
      '    public void Process(OrderItem item) {',
      '      Validate(item);',
      '    }',
      '    /// <summary>Validates an order item.</summary>',
      '    private bool Validate(OrderItem item) => true;',
      '  }',
      '}',
    ].join('\n');
    const state = EditorState.create({ doc: csDoc, extensions: [csharp()] });

    // Local C# method jump (`Validate(item)` -> `private bool Validate`)
    const callValidatePos = csDoc.indexOf('Validate(item)') + 2;
    const localMethod = await resolveSymbolDefinitions(state, callValidatePos, {
      filePath: '/repo/Services/OrderService.cs',
      workspaceRoot: '/repo',
    });
    expect(localMethod.symbolName).toBe('Validate');
    expect(localMethod.locations[0].line).toBe(7);
    expect(localMethod.locations[0].documentation).toBe('Validates an order item.');

    // Cross-file C# type jump (`OrderItem` -> `Models/OrderItem.cs`)
    const typePos = csDoc.indexOf('OrderItem') + 2;
    const crossFileType = await resolveSymbolDefinitions(state, typePos, {
      filePath: '/repo/Services/OrderService.cs',
      workspaceRoot: '/repo',
      searchContents: async () => ({
        status: 'ok',
        matches: [{
          path: '/repo/Models/OrderItem.cs',
          relativePath: 'Models/OrderItem.cs',
          line: 4,
          column: 3,
          text: 'public record OrderItem(string Id, decimal Price);',
          ranges: [[0, 23]],
          cutStart: false,
        }],
        stopped: null,
      }),
    });
    expect(crossFileType.symbolName).toBe('OrderItem');
    expect(crossFileType.locations[0].path).toBe('/repo/Models/OrderItem.cs');
    expect(crossFileType.locations[0].line).toBe(4);

    // References combine in-file AST hits and workspace ripgrep matches
    const refs = await findSymbolReferences(state, callValidatePos, {
      filePath: '/repo/Services/OrderService.cs',
      workspaceRoot: '/repo',
      searchContents: async () => ({
        status: 'ok',
        matches: [{
          path: '/repo/Tests/OrderServiceTests.cs',
          relativePath: 'Tests/OrderServiceTests.cs',
          line: 12,
          column: 10,
          text: 'service.Validate(sample);',
          ranges: [[8, 16]],
          cutStart: false,
        }],
        stopped: null,
      }),
    });
    expect(refs.locations.map((loc) => `${loc.relativePath}:${loc.line}`)).toEqual([
      'Services/OrderService.cs:7',
      'Services/OrderService.cs:4',
      'Tests/OrderServiceTests.cs:12',
    ]);
  });

  test('parses workspace symbol matches across C#, TypeScript and Go', () => {
    const parsed = parseWorkspaceSymbolMatches([
      {
        path: '/repo/Services/OrderService.cs',
        relativePath: 'Services/OrderService.cs',
        line: 2,
        column: 3,
        text: 'public class OrderService : IOrderService {',
        ranges: [[0, 25]],
        cutStart: false,
      },
      {
        path: '/repo/src/utils.ts',
        relativePath: 'src/utils.ts',
        line: 8,
        column: 1,
        text: 'export async function fetchOrders() {',
        ranges: [[0, 33]],
        cutStart: false,
      },
    ]);
    expect(parsed.map((item) => [item.name, item.kind, item.relativePath])).toEqual([
      ['OrderService', 'class', 'Services/OrderService.cs'],
      ['fetchOrders', 'function', 'src/utils.ts'],
    ]);
  });
});
