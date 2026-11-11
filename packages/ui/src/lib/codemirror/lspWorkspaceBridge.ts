import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type TransactionSpec,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
} from '@codemirror/view';
import {
  LSPClient,
  LSPPlugin,
  Workspace,
  hoverTooltips,
  renameKeymap,
  renameSymbol,
  signatureHelp,
  type Transport,
  type WorkspaceFile,
} from '@codemirror/lsp-client';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isMacOS } from '@/lib/utils';
import {
  importSpecifierAt,
  resolveImportSpecifier,
} from './importLinks';
import { findScopeRenameRanges, selectAllSymbolOccurrences } from './renameSymbol';
import {
  findSymbolReferences,
  identifierAtPosition,
  resolveSymbolDefinitions,
  toRelativeWorkspacePath,
  type SymbolLocation,
  type SymbolNavigationContext,
} from './symbolNavigation';

export type PeekWidgetState = {
  mode: 'definition' | 'references';
  symbolName: string;
  afterLine: number;
  locations: SymbolLocation[];
};

type LspBridgeCallbacks = {
  getNavigationContext: () => SymbolNavigationContext | null;
  onJumpToLocation: (target: SymbolLocation, fromLocation: { path: string; line: number; column: number }) => void;
  onOpenPeek: (peek: PeekWidgetState) => void;
  onImportNotFound?: (specifier: string, reason: 'missing' | 'failed') => void;
};

export const pathToFileUri = (filePath: string): string => {
  const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
  return `file://${encodeURI(normalized)}`;
};

export const fileUriToPath = (uri: string): string => {
  if (!uri.startsWith('file://')) return uri;
  try {
    return decodeURI(uri.slice('file://'.length));
  } catch {
    return uri.slice('file://'.length);
  }
};

const offsetToLspPosition = (doc: Text, offset: number) => {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, character: clamped - line.from };
};

const lspPositionToOffset = (doc: Text, position: { line: number; character: number }): number => {
  const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines));
  const line = doc.line(lineNumber);
  const character = Math.max(0, Math.min(position.character, line.length));
  return line.from + character;
};

class MultiViewWorkspaceFile implements WorkspaceFile {
  readonly views: EditorView[] = [];

  constructor(
    public readonly uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    initialView: EditorView,
  ) {
    this.views.push(initialView);
  }

  getView(main?: EditorView): EditorView | null {
    if (main && this.views.includes(main)) return main;
    return this.views[this.views.length - 1] ?? null;
  }
}

/**
 * Custom `@codemirror/lsp-client` Workspace that tolerates docked + fullscreen
 * views mounted on the same file URI simultaneously and delegates cross-file
 * display to OpenChamber's file tab opener.
 */
export class OpenChamberLSPWorkspace extends Workspace {
  files: MultiViewWorkspaceFile[] = [];
  private readonly fileVersions = new Map<string, number>();

  constructor(
    client: LSPClient,
    private readonly onDisplayFile?: (filePath: string) => Promise<EditorView | null>,
  ) {
    super(client);
  }

  private nextVersion(uri: string): number {
    const next = (this.fileVersions.get(uri) ?? -1) + 1;
    this.fileVersions.set(uri, next);
    return next;
  }

  override getFile(uri: string): MultiViewWorkspaceFile | null {
    return this.files.find((file) => file.uri === uri) ?? null;
  }

  syncFiles(): ReturnType<Workspace['syncFiles']> {
    const updates: Array<{ file: WorkspaceFile; prevDoc: Text; changes: LSPPlugin['unsyncedChanges'] }> = [];
    for (const file of this.files) {
      const view = file.getView();
      if (!view) continue;
      const plugin = LSPPlugin.get(view);
      if (!plugin || plugin.unsyncedChanges.empty) continue;
      updates.push({
        file,
        prevDoc: file.doc,
        changes: plugin.unsyncedChanges,
      });
      file.doc = view.state.doc;
      file.version = this.nextVersion(file.uri);
      plugin.clear();
    }
    return updates;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const existing = this.getFile(uri);
    if (existing) {
      if (!existing.views.includes(view)) {
        existing.views.push(view);
      }
      existing.languageId = languageId || existing.languageId;
      existing.doc = view.state.doc;
      return;
    }
    const created = new MultiViewWorkspaceFile(
      uri,
      languageId,
      this.nextVersion(uri),
      view.state.doc,
      view,
    );
    this.files.push(created);
    this.client.didOpen(created);
  }

  closeFile(uri: string, view: EditorView): void {
    const existing = this.getFile(uri);
    if (!existing) return;
    const idx = existing.views.indexOf(view);
    if (idx >= 0) existing.views.splice(idx, 1);
    if (existing.views.length === 0) {
      this.files = this.files.filter((item) => item !== existing);
      this.client.didClose(uri);
    }
  }

  override updateFile(uri: string, update: TransactionSpec): void {
    const existing = this.getFile(uri);
    if (!existing) return;
    const view = existing.getView();
    if (view) {
      view.dispatch(update);
    }
  }

  override async displayFile(uri: string): Promise<EditorView | null> {
    const existing = this.getFile(uri);
    if (existing) return existing.getView();
    if (this.onDisplayFile) {
      return this.onDisplayFile(fileUriToPath(uri));
    }
    return null;
  }
}

const lspRequestParamsSchema = z.object({
  textDocument: z.object({
    uri: z.string().optional(),
  }).optional(),
  position: z.object({
    line: z.number(),
    character: z.number(),
  }).optional(),
  newName: z.string().optional(),
}).passthrough();

const jsonRpcMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: lspRequestParamsSchema.optional(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
  }).optional(),
});

type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

const remoteLspBridgeResponseSchema = z.object({
  available: z.boolean().optional(),
  response: jsonRpcMessageSchema.nullable().optional(),
});

const languageFenceForPath = (filePath: string): string => {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'cs':
    case 'csx':
      return 'csharp';
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    default:
      return ext || 'text';
  }
};

/**
 * Creates a `@codemirror/lsp-client` `Transport` that serves LSP requests using
 * OpenChamber's built-in multi-language Lezer + ripgrep engine, and optionally
 * upgrades to `/api/lsp/request` when a host language server is available.
 */
export const createHybridLspTransport = (options: {
  getWorkspace: () => OpenChamberLSPWorkspace | null;
  getNavigationContext: () => SymbolNavigationContext | null;
  enableRemoteServerProbe?: boolean;
}): Transport => {
  const subscribers = new Set<(value: string) => void>();
  const remoteAvailabilityByLang = new Map<string, boolean>();

  const emit = (payload: JsonRpcMessage) => {
    const encoded = JSON.stringify(payload);
    for (const handler of subscribers) {
      handler(encoded);
    }
  };

  const stateForUri = (uri: string): EditorState | null => {
    const file = options.getWorkspace()?.getFile(uri);
    const view = file?.getView();
    if (view) return view.state;
    if (file) return EditorState.create({ doc: file.doc });
    return null;
  };

  const languageIdForUri = (uri: string): string => {
    const file = options.getWorkspace()?.getFile(uri);
    if (file?.languageId) return file.languageId;
    return languageFenceForPath(fileUriToPath(uri));
  };

  const tryRemoteLspRequest = async (languageId: string, message: JsonRpcMessage, directory: string): Promise<JsonRpcMessage | null> => {
    if (!options.enableRemoteServerProbe || !languageId || !directory) return null;
    if (remoteAvailabilityByLang.get(languageId) === false) return null;
    try {
      const res = await runtimeFetch('/api/lsp/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-opencode-directory': encodeURIComponent(directory),
        },
        body: JSON.stringify({ languageId, message }),
      });
      if (!res.ok) {
        remoteAvailabilityByLang.set(languageId, false);
        return null;
      }
      const parsed = remoteLspBridgeResponseSchema.safeParse(await res.json());
      if (!parsed.success || !parsed.data.available) {
        remoteAvailabilityByLang.set(languageId, false);
        return null;
      }
      remoteAvailabilityByLang.set(languageId, true);
      return parsed.data.response ?? null;
    } catch {
      remoteAvailabilityByLang.set(languageId, false);
      return null;
    }
  };

  const handleRequest = async (msg: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = msg;
    if (id === undefined || !method) return;

    if (method === 'initialize') {
      emit({
        jsonrpc: '2.0',
        id,
        result: {
          capabilities: {
            hoverProvider: true,
            definitionProvider: true,
            declarationProvider: true,
            typeDefinitionProvider: true,
            implementationProvider: true,
            referencesProvider: true,
            renameProvider: true,
            signatureHelpProvider: {
              triggerCharacters: ['(', ','],
              retriggerCharacters: [','],
            },
          },
        },
      });
      return;
    }

    if (method === 'shutdown') {
      emit({ jsonrpc: '2.0', id, result: null });
      return;
    }

    const uri = params?.textDocument?.uri ?? '';
    const position = params?.position;
    const state = uri ? stateForUri(uri) : null;
    const navContext = options.getNavigationContext();

    if (navContext?.workspaceRoot && uri) {
      const remoteResponse = await tryRemoteLspRequest(languageIdForUri(uri), msg, navContext.workspaceRoot);
      if (remoteResponse && remoteResponse.result !== undefined) {
        emit({ ...remoteResponse, id });
        return;
      }
    }

    if (!state || !position) {
      emit({ jsonrpc: '2.0', id, result: null });
      return;
    }

    const offset = lspPositionToOffset(state.doc, position);
    const effectiveContext: SymbolNavigationContext = navContext ?? {
      filePath: fileUriToPath(uri),
      workspaceRoot: '',
    };

    if (method === 'textDocument/hover') {
      const token = identifierAtPosition(state, offset);
      if (!token) {
        const importSpec = importSpecifierAt(state, offset);
        if (importSpec && effectiveContext.listDirectoryNames) {
          const resolved = await resolveImportSpecifier(
            effectiveContext.filePath,
            importSpec.specifier,
            effectiveContext.listDirectoryNames,
            effectiveContext.tsconfigMappings,
            effectiveContext.workspaceRoot,
          );
          if (resolved.status === 'found') {
            const rel = toRelativeWorkspacePath(resolved.path, effectiveContext.workspaceRoot);
            emit({
              jsonrpc: '2.0',
              id,
              result: {
                contents: { kind: 'markdown', value: `\`${rel}\`` },
                range: {
                  start: offsetToLspPosition(state.doc, importSpec.from),
                  end: offsetToLspPosition(state.doc, importSpec.to),
                },
              },
            });
            return;
          }
        }
        emit({ jsonrpc: '2.0', id, result: null });
        return;
      }

      const resolved = await resolveSymbolDefinitions(state, offset, effectiveContext);
      const primary = resolved.locations[0];
      if (!primary) {
        emit({ jsonrpc: '2.0', id, result: null });
        return;
      }

      const fence = languageFenceForPath(primary.path || effectiveContext.filePath);
      const sigBlock = primary.signature || primary.text;
      const parts: string[] = [];
      if (sigBlock) {
        parts.push(`\`\`\`${fence}\n${sigBlock}\n\`\`\``);
      }
      if (primary.documentation) {
        parts.push(primary.documentation);
      }
      if (primary.path && primary.path !== effectiveContext.filePath) {
        parts.push(`*${primary.relativePath}:${primary.line}*`);
      }

      emit({
        jsonrpc: '2.0',
        id,
        result: {
          contents: {
            kind: 'markdown',
            value: parts.join('\n\n'),
          },
          range: {
            start: offsetToLspPosition(state.doc, token.from),
            end: offsetToLspPosition(state.doc, token.to),
          },
        },
      });
      return;
    }

    if (
      method === 'textDocument/definition'
      || method === 'textDocument/declaration'
      || method === 'textDocument/typeDefinition'
      || method === 'textDocument/implementation'
    ) {
      const resolved = await resolveSymbolDefinitions(state, offset, effectiveContext);
      const locations = resolved.locations.map((loc) => ({
        uri: pathToFileUri(loc.path),
        range: {
          start: { line: Math.max(0, loc.line - 1), character: Math.max(0, loc.column - 1) },
          end: { line: Math.max(0, loc.line - 1), character: Math.max(0, loc.endColumn - 1) },
        },
      }));
      emit({ jsonrpc: '2.0', id, result: locations });
      return;
    }

    if (method === 'textDocument/references') {
      const refs = await findSymbolReferences(state, offset, effectiveContext);
      const locations = refs.locations.map((loc) => ({
        uri: pathToFileUri(loc.path),
        range: {
          start: { line: Math.max(0, loc.line - 1), character: Math.max(0, loc.column - 1) },
          end: { line: Math.max(0, loc.line - 1), character: Math.max(0, loc.endColumn - 1) },
        },
      }));
      emit({ jsonrpc: '2.0', id, result: locations });
      return;
    }

    if (method === 'textDocument/rename') {
      const newName = params?.newName?.trim() ?? '';
      const target = findScopeRenameRanges(state, offset);
      if (!target || !/^[A-Za-z_$@][\w$]*$/.test(newName)) {
        emit({ jsonrpc: '2.0', id, result: { changes: {} } });
        return;
      }
      emit({
        jsonrpc: '2.0',
        id,
        result: {
          changes: {
            [uri]: target.ranges.map((range) => ({
              range: {
                start: offsetToLspPosition(state.doc, range.from),
                end: offsetToLspPosition(state.doc, range.to),
              },
              newText: newName,
            })),
          },
        },
      });
      return;
    }

    if (method === 'textDocument/signatureHelp') {
      const line = state.doc.lineAt(offset);
      const textBefore = state.sliceDoc(Math.max(0, line.from - 200), offset);
      let depth = 0;
      let activeParam = 0;
      let openParenOffset = -1;
      for (let i = textBefore.length - 1; i >= 0; i -= 1) {
        const ch = textBefore[i];
        if (ch === ')' || ch === ']' || ch === '}') depth += 1;
        else if (ch === '(') {
          if (depth === 0) {
            openParenOffset = Math.max(0, line.from - 200) + i;
            break;
          }
          depth -= 1;
        } else if (ch === ',' && depth === 0) {
          activeParam += 1;
        }
      }
      if (openParenOffset <= 0) {
        emit({ jsonrpc: '2.0', id, result: null });
        return;
      }
      const resolved = await resolveSymbolDefinitions(state, openParenOffset - 1, effectiveContext);
      const primary = resolved.locations[0];
      if (!primary?.signature) {
        emit({ jsonrpc: '2.0', id, result: null });
        return;
      }
      const paramListMatch = /\(([^)]*)\)/.exec(primary.signature);
      const parameters = paramListMatch
        ? paramListMatch[1].split(',').map((p) => p.trim()).filter(Boolean).map((label) => ({ label }))
        : [];
      emit({
        jsonrpc: '2.0',
        id,
        result: {
          signatures: [{
            label: primary.signature,
            documentation: primary.documentation ? { kind: 'markdown', value: primary.documentation } : undefined,
            parameters,
          }],
          activeSignature: 0,
          activeParameter: Math.min(activeParam, Math.max(0, parameters.length - 1)),
        },
      });
      return;
    }

    emit({ jsonrpc: '2.0', id, result: null });
  };

  return {
    send(rawMessage: string) {
      try {
        const parsed = jsonRpcMessageSchema.safeParse(JSON.parse(rawMessage));
        if (parsed.success) {
          void handleRequest(parsed.data);
        }
      } catch {
        // Ignore invalid JSON-RPC payload.
      }
    },
    subscribe(handler: (value: string) => void) {
      subscribers.add(handler);
    },
    unsubscribe(handler: (value: string) => void) {
      subscribers.delete(handler);
    },
  };
};

const hasLinkModifier = (event: MouseEvent | KeyboardEvent) => (isMacOS() ? event.metaKey : event.ctrlKey);
const setHoveredNavRange = StateEffect.define<{ from: number; to: number } | null>();
const navLinkMark = Decoration.mark({ class: 'cm-nav-link' });

const hoveredNavField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredNavRange)) return effect.value;
    }
    return transaction.docChanged ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (range) => (
    range ? Decoration.set([navLinkMark.range(range.from, range.to)]) : Decoration.none
  )),
});

const updateHoveredNavRange = (view: EditorView, range: { from: number; to: number } | null) => {
  const current = view.state.field(hoveredNavField, false) ?? null;
  if (current?.from === range?.from && current?.to === range?.to) return;
  view.dispatch({ effects: setHoveredNavRange.of(range) });
};

const navRangeAtPos = (state: EditorState, pos: number): { from: number; to: number } | null => {
  const importSpec = importSpecifierAt(state, pos);
  if (importSpec) return { from: importSpec.from, to: importSpec.to };
  const ident = identifierAtPosition(state, pos);
  if (ident) return { from: ident.from, to: ident.to };
  return null;
};

type EditorCodeNavigationController = {
  extension: (filePath: string, languageId?: string) => Extension;
  goToDefinitionAtCursor: (view: EditorView, options?: { forcePeek?: boolean; pos?: number }) => Promise<boolean>;
  findReferencesAtCursor: (view: EditorView, options?: { pos?: number }) => Promise<boolean>;
  renameSymbolAtCursor: (view: EditorView) => boolean;
  selectAllOccurrencesAtCursor: (view: EditorView) => boolean;
  client: LSPClient;
};

/**
 * Creates the unified CodeMirror 6 code navigation controller backed by
 * `@codemirror/lsp-client` (`LSPClient`, `hoverTooltips`, `renameSymbol`,
 * `signatureHelp`) plus inline Peek Definition / Peek References and `Mod+Click`.
 */
export const createEditorCodeNavigationController = (
  callbacks: LspBridgeCallbacks,
  options?: { enableRemoteServerProbe?: boolean },
): EditorCodeNavigationController => {
  let workspaceInstance: OpenChamberLSPWorkspace | null = null;
  const transport = createHybridLspTransport({
    getWorkspace: () => workspaceInstance,
    getNavigationContext: callbacks.getNavigationContext,
    enableRemoteServerProbe: options?.enableRemoteServerProbe ?? true,
  });

  const client = new LSPClient({
    workspace: (lspClient) => {
      workspaceInstance = new OpenChamberLSPWorkspace(lspClient);
      return workspaceInstance;
    },
    timeout: 5000,
  }).connect(transport);

  const goToDefinitionAtCursor = async (
    view: EditorView,
    opts?: { forcePeek?: boolean; pos?: number },
  ): Promise<boolean> => {
    const context = callbacks.getNavigationContext();
    if (!context) return false;
    const pos = opts?.pos ?? view.state.selection.main.head;
    const currentLineObj = view.state.doc.lineAt(pos);
    const origin = {
      path: context.filePath,
      line: currentLineObj.number,
      column: pos - currentLineObj.from + 1,
    };

    const spec = importSpecifierAt(view.state, pos);
    if (spec && context.listDirectoryNames) {
      const resolution = await resolveImportSpecifier(
        context.filePath,
        spec.specifier,
        context.listDirectoryNames,
        context.tsconfigMappings,
        context.workspaceRoot,
      );
      if (resolution.status === 'found') {
        callbacks.onJumpToLocation({
          path: resolution.path,
          relativePath: toRelativeWorkspacePath(resolution.path, context.workspaceRoot),
          line: 1,
          column: 1,
          endColumn: 1,
          text: spec.specifier,
          isDeclaration: true,
        }, origin);
        return true;
      }
      callbacks.onImportNotFound?.(spec.specifier, resolution.status);
      return false;
    }

    const resolved = await resolveSymbolDefinitions(view.state, pos, context);
    if (resolved.locations.length === 0) return false;

    if (!opts?.forcePeek && resolved.locations.length === 1) {
      const target = resolved.locations[0];
      if (target.path === context.filePath && target.line === origin.line) {
        return findReferencesAtCursor(view, { pos });
      }
      callbacks.onJumpToLocation(target, origin);
      return true;
    }

    callbacks.onOpenPeek({
      mode: 'definition',
      symbolName: resolved.symbolName,
      afterLine: origin.line,
      locations: resolved.locations,
    });
    return true;
  };

  const findReferencesAtCursor = async (
    view: EditorView,
    opts?: { pos?: number },
  ): Promise<boolean> => {
    const context = callbacks.getNavigationContext();
    if (!context) return false;
    const pos = opts?.pos ?? view.state.selection.main.head;
    const currentLine = view.state.doc.lineAt(pos).number;
    const refs = await findSymbolReferences(view.state, pos, context);
    if (!refs.symbolName || refs.locations.length === 0) return false;

    callbacks.onOpenPeek({
      mode: 'references',
      symbolName: refs.symbolName,
      afterLine: currentLine,
      locations: refs.locations,
    });
    return true;
  };

  const extension = (filePath: string, languageId?: string): Extension => [
    client.plugin(pathToFileUri(filePath), languageId),
    hoverTooltips({ hoverTime: 300 }),
    signatureHelp(),
    hoveredNavField,
    keymap.of([
      ...renameKeymap,
      {
        key: 'Mod-F2',
        run: (view) => selectAllSymbolOccurrences(view),
        preventDefault: true,
      },
      {
        key: 'F12',
        run: (view) => {
          void goToDefinitionAtCursor(view);
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Alt-F12',
        run: (view) => {
          void goToDefinitionAtCursor(view, { forcePeek: true });
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Shift-F12',
        run: (view) => {
          void findReferencesAtCursor(view);
          return true;
        },
        preventDefault: true,
      },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (event.button !== 0 || !hasLinkModifier(event) || event.altKey) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const range = navRangeAtPos(view.state, pos);
        if (!range) return false;
        event.preventDefault();
        const ident = identifierAtPosition(view.state, pos);
        if (ident?.isDeclaration) {
          void findReferencesAtCursor(view, { pos });
        } else {
          void goToDefinitionAtCursor(view, { pos });
        }
        return true;
      },
      mousemove: (event, view) => {
        if (!hasLinkModifier(event)) {
          updateHoveredNavRange(view, null);
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        updateHoveredNavRange(view, pos === null ? null : navRangeAtPos(view.state, pos));
        return false;
      },
      mouseleave: (_event, view) => {
        updateHoveredNavRange(view, null);
        return false;
      },
      keyup: (event, view) => {
        if (!hasLinkModifier(event)) updateHoveredNavRange(view, null);
        return false;
      },
    }),
    EditorView.theme({
      '.cm-nav-link': {
        textDecoration: 'underline',
        cursor: 'pointer',
      },
      '.cm-tooltip.cm-lsp-hover-tooltip': {
        maxWidth: 'min(36rem, 85vw)',
        maxHeight: '18rem',
        overflow: 'auto',
        padding: '6px 10px',
        borderRadius: '8px',
        backgroundColor: 'var(--surface-elevated)',
        color: 'var(--surface-elevated-foreground)',
        border: '1px solid var(--interactive-border)',
        boxShadow: 'var(--oc-elevation-floating)',
        fontFamily: 'var(--font-sans)',
        fontSize: '12px',
        lineHeight: '1.45',
      },
      '.cm-lsp-hover-tooltip pre, .cm-lsp-hover-tooltip code': {
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
      },
      '.cm-panel.cm-lsp-rename-panel': {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        backgroundColor: 'var(--surface-elevated)',
        borderBottom: '1px solid var(--interactive-border)',
        fontFamily: 'var(--font-sans)',
        fontSize: '12px',
      },
      '.cm-panel.cm-lsp-rename-panel input': {
        height: '24px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--interactive-border)',
        backgroundColor: 'var(--surface-background)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
      },
    }),
  ];

  return {
    extension,
    goToDefinitionAtCursor,
    findReferencesAtCursor,
    renameSymbolAtCursor: (view) => renameSymbol(view),
    selectAllOccurrencesAtCursor: (view) => selectAllSymbolOccurrences(view),
    client,
  };
};
