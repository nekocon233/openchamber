import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { csharp } from '@replit/codemirror-lang-csharp';
import { LSPClient } from '@codemirror/lsp-client';
import { z } from 'zod';
import {
  OpenChamberLSPWorkspace,
  createHybridLspTransport,
  fileUriToPath,
  pathToFileUri,
} from './lspWorkspaceBridge';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { EditorView } = await import('@codemirror/view');

describe('lspWorkspaceBridge', () => {
  test('converts file paths to and from file:// URIs', () => {
    const uri = pathToFileUri('/repo/src/Services/OrderService.cs');
    expect(uri).toBe('file:///repo/src/Services/OrderService.cs');
    expect(fileUriToPath(uri)).toBe('/repo/src/Services/OrderService.cs');
  });

  test('hybrid LSP transport answers initialize, hover, definition, references and rename in-process', async () => {
    const csDoc = [
      'namespace App {',
      '  public class Greeter {',
      '    /// <summary>Formats a greeting message.</summary>',
      '    public string Format(string user) {',
      '      return user;',
      '    }',
      '    public string Run() => Format("Ada");',
      '  }',
      '}',
    ].join('\n');
    const state = EditorState.create({ doc: csDoc, extensions: [csharp()] });
    const uri = pathToFileUri('/repo/Greeter.cs');

    let workspaceRef: OpenChamberLSPWorkspace | null = null;
    const transport = createHybridLspTransport({
      getWorkspace: () => workspaceRef,
      getNavigationContext: () => ({
        filePath: '/repo/Greeter.cs',
        workspaceRoot: '/repo',
      }),
      enableRemoteServerProbe: false,
    });

    const client = new LSPClient({
      workspace: (c) => {
        workspaceRef = new OpenChamberLSPWorkspace(c);
        return workspaceRef;
      },
    }).connect(transport);

    const view1 = new EditorView({ state });
    const view2 = new EditorView({ state });
    workspaceRef!.openFile(uri, 'csharp', view1);
    workspaceRef!.openFile(uri, 'csharp', view2);
    expect(workspaceRef!.getFile(uri)?.views.length).toBe(2);

    const hoverSchema = z.object({
      contents: z.object({ value: z.string() }),
    });
    const hoverRaw = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 6, character: 29 },
    });
    const hoverResult = hoverSchema.parse(hoverRaw);
    expect(hoverResult.contents.value).toContain('public string Format(string user)');
    expect(hoverResult.contents.value).toContain('Formats a greeting message.');

    const defSchema = z.array(z.object({
      uri: z.string(),
      range: z.object({ start: z.object({ line: z.number() }) }),
    }));
    const defResult = defSchema.parse(await client.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: 6, character: 29 },
    }));
    expect(defResult).toHaveLength(1);
    expect(defResult[0].range.start.line).toBe(3);

    const renameSchema = z.object({
      changes: z.record(z.string(), z.array(z.object({ newText: z.string() }))),
    });
    const renameResult = renameSchema.parse(await client.request('textDocument/rename', {
      textDocument: { uri },
      position: { line: 4, character: 14 },
      newName: 'userName',
    }));
    expect(renameResult.changes[uri]).toHaveLength(2);
    expect(renameResult.changes[uri][0].newText).toBe('userName');

    view1.destroy();
    view2.destroy();
  });
});
