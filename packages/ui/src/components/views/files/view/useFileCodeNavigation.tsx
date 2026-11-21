import React from "react";
import { type PeekWidgetState, createEditorCodeNavigationController } from "@/lib/codemirror/lspWorkspaceBridge";
import { type TsconfigPathMapping, parseTsconfigPaths } from "@/lib/codemirror/importLinks";
import { useKeybind } from "@/hooks/useKeybind";
import { useEditorNavigationStore } from "@/stores/useEditorNavigationStore";
import { EditorView } from "@codemirror/view";
import { useUIStore } from "@/stores/useUIStore";
import type { SymbolNavigationContext, SymbolLocation } from "@/lib/codemirror/symbolNavigation";
import { toast } from "@/components/ui";
import { acquireEditorKeyboardLock, classifyEditorBrowserShortcut } from "@/lib/codemirror/browserShortcutShield";
import { EditorPeekWidget } from "../../EditorPeekWidget";
import { WorkspaceSymbolsDialog } from "../../WorkspaceSymbolsDialog";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { runToggleEditorComment } from "@/lib/codemirror/editingAids";
import type { useFileEditor } from './useFileEditorExtensions';
import type { useFileScope } from './useFileScope';
import type { useFileTabs } from './useFileTabs';
import type { FilesAPI } from '@/lib/api/types';
import type { useI18n } from '@/lib/i18n';

export function useFileCodeNavigation({ editor, scope, tabs, canEdit, files, draftContent, isMobile, visible, t }: {
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'editorWrapperRef' | 'setIsSymbolsOpen' | 'setIsGoToLineOpen'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'panelRoot' | 'root' | 'showHidden' | 'showGitignored'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'resolveFileReadOptions'>;
  canEdit: boolean;
  files: FilesAPI;
  draftContent: string;
  isMobile: boolean;
  visible: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { editorViewRef, editorWrapperRef, setIsSymbolsOpen, setIsGoToLineOpen } = editor;
  const { root, panelRoot, showHidden, showGitignored } = scope;
  const { selectedFile, resolveFileReadOptions } = tabs;
  const [isWorkspaceSymbolsOpen, setIsWorkspaceSymbolsOpen] = React.useState(false);
  const [peekWidget, setPeekWidget] = React.useState<PeekWidgetState | null>(null);
  const [tsconfigMappings, setTsconfigMappings] = React.useState<TsconfigPathMapping[]>([]);
  useKeybind('open_workspace_symbols', (event) => {
    if (isMobile || !files.searchContents || !root) {
      return false;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"]')) return false;
    if (!target || !editorWrapperRef.current?.contains(target)) return false;
    setIsWorkspaceSymbolsOpen(true);
  });

  const navHistoryRoot = panelRoot || root || '';
  const canNavigateBack = useEditorNavigationStore((state) => (
    Boolean(navHistoryRoot && (state.byDirectory[navHistoryRoot]?.backStack.length ?? 0) > 0)
  ));
  const canNavigateForward = useEditorNavigationStore((state) => (
    Boolean(navHistoryRoot && (state.byDirectory[navHistoryRoot]?.forwardStack.length ?? 0) > 0)
  ));

  const readCurrentEditorStop = React.useCallback(() => {
    const path = selectedFile?.path;
    const view = editorViewRef.current;
    if (!path) return null;
    if (!view) return { path, line: 1, column: 1 };
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return {
      path,
      line: line.number,
      column: head - line.from + 1,
    };
  }, [selectedFile?.path]);

  const navigateToStop = React.useCallback((stop: { path: string; line: number; column?: number }) => {
    const targetRoot = panelRoot || root;
    if (!targetRoot) return;
    setPeekWidget(null);
    const view = editorViewRef.current;
    if (selectedFile?.path === stop.path && view) {
      const lineNo = Math.max(1, Math.min(stop.line, view.state.doc.lines));
      const line = view.state.doc.line(lineNo);
      const colOffset = Math.max(0, Math.min(line.length, (stop.column ?? 1) - 1));
      const pos = line.from + colOffset;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
      return;
    }
    useUIStore.getState().openContextFileAtLine(targetRoot, stop.path, stop.line, stop.column ?? 1);
  }, [panelRoot, root, selectedFile?.path]);

  const recordEditorJump = React.useCallback((
    target: { path: string; line: number; column?: number },
    origin?: { path: string; line: number; column: number },
  ) => {
    const fromStop = origin ?? readCurrentEditorStop();
    if (fromStop && navHistoryRoot) {
      useEditorNavigationStore.getState().recordJump(navHistoryRoot, fromStop, {
        path: target.path,
        line: target.line,
        column: target.column ?? 1,
      });
    }
  }, [navHistoryRoot, readCurrentEditorStop]);

  const jumpToEditorLocation = React.useCallback((
    target: { path: string; line: number; column?: number },
    origin?: { path: string; line: number; column: number },
  ) => {
    recordEditorJump(target, origin);
    navigateToStop(target);
  }, [recordEditorJump, navigateToStop]);

  const handleEditorGoBack = React.useCallback(() => {
    if (!navHistoryRoot) return false;
    const target = useEditorNavigationStore.getState().stepBack(navHistoryRoot, readCurrentEditorStop());
    if (!target) return false;
    navigateToStop(target);
    return true;
  }, [navHistoryRoot, navigateToStop, readCurrentEditorStop]);

  const handleEditorGoForward = React.useCallback(() => {
    if (!navHistoryRoot) return false;
    const target = useEditorNavigationStore.getState().stepForward(navHistoryRoot, readCurrentEditorStop());
    if (!target) return false;
    navigateToStop(target);
    return true;
  }, [navHistoryRoot, navigateToStop, readCurrentEditorStop]);

  useKeybind('editor_go_back', (event) => {
    if (isMobile) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"]')) return false;
    if (!target || !editorWrapperRef.current?.contains(target)) return false;
    handleEditorGoBack();
    return true;
  });

  useKeybind('editor_go_forward', (event) => {
    if (isMobile) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"]')) return false;
    if (!target || !editorWrapperRef.current?.contains(target)) return false;
    handleEditorGoForward();
    return true;
  });

  React.useEffect(() => {
    setPeekWidget(null);
  }, [selectedFile?.path]);

  React.useEffect(() => {
    const readFile = files.readFile;
    if (!root || !readFile) {
      setTsconfigMappings([]);
      return;
    }
    let cancelled = false;
    const loadConfig = async () => {
      for (const configName of ['tsconfig.json', 'jsconfig.json']) {
        try {
          const configPath = `${root}/${configName}`;
          const res = await readFile(configPath);
          if (cancelled) return;
          if (res?.content) {
            const parsed = parseTsconfigPaths(res.content, root);
            if (parsed.length > 0) {
              setTsconfigMappings(parsed);
              return;
            }
          }
        } catch {
          // Try next candidate config file.
        }
      }
      if (!cancelled) setTsconfigMappings([]);
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [files.readFile, root]);

  const readWorkspaceFileText = React.useCallback(async (targetPath: string): Promise<string | null> => {
    if (targetPath === selectedFile?.path) return draftContent;
    if (!files.readFile) return null;
    try {
      const result = await files.readFile(targetPath, resolveFileReadOptions(targetPath));
      return result?.content ?? null;
    } catch {
      return null;
    }
  }, [draftContent, files, resolveFileReadOptions, selectedFile?.path]);

  const navigationContextRef = React.useRef<SymbolNavigationContext | null>(null);
  navigationContextRef.current = selectedFile?.path
    ? {
      filePath: selectedFile.path,
      workspaceRoot: root || panelRoot || '',
      tsconfigMappings,
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      listDirectoryNames: async (directory) => {
        try {
          const listing = await files.listDirectory(directory);
          return new Map(listing.entries.map((entry) => [entry.name, entry.isDirectory]));
        } catch {
          return null;
        }
      },
      readFileText: readWorkspaceFileText,
      searchContents: files.searchContents,
    }
    : null;

  const jumpToEditorLocationRef = React.useRef(jumpToEditorLocation);
  jumpToEditorLocationRef.current = jumpToEditorLocation;
  const importErrorToastRef = React.useRef<(specifier: string, reason: 'missing' | 'failed') => void>(() => {});
  importErrorToastRef.current = (specifier, reason) => {
    toast.error(reason === 'missing'
      ? t('filesView.editor.importNotFound', { path: specifier })
      : t('filesView.editor.importLookupFailed', { path: specifier }));
  };

  const codeNavigationController = React.useMemo(() => createEditorCodeNavigationController({
    getNavigationContext: () => navigationContextRef.current,
    onJumpToLocation: (target, origin) => jumpToEditorLocationRef.current(target, origin),
    onOpenPeek: (peek) => setPeekWidget(peek),
    onImportNotFound: (specifier, reason) => importErrorToastRef.current(specifier, reason),
  }), []);

  React.useEffect(() => {
    if (!visible || isMobile) {
      return;
    }
    const releaseKeyboardLock = acquireEditorKeyboardLock();
    const handleEditorBrowserShortcut = (event: KeyboardEvent) => {
      const wrapper = editorWrapperRef.current;
      if (!wrapper) return;
      const target = event.target instanceof Node ? event.target : null;
      const active = document.activeElement;
      if (!wrapper.contains(target) && !wrapper.contains(active)) return;

      const action = classifyEditorBrowserShortcut(event);
      if (!action) return;

      const alreadyHandled = event.defaultPrevented;
      event.preventDefault();
      if (alreadyHandled || action === 'prevent-browser-default') return;

      const view = editorViewRef.current;
      switch (action) {
        case 'go-to-definition':
          if (view) void codeNavigationController.goToDefinitionAtCursor(view);
          break;
        case 'peek-definition':
          if (view) void codeNavigationController.goToDefinitionAtCursor(view, { forcePeek: true });
          break;
        case 'find-references':
          if (view) void codeNavigationController.findReferencesAtCursor(view);
          break;
        case 'rename-symbol':
          if (view && canEdit) codeNavigationController.renameSymbolAtCursor(view);
          break;
        case 'change-all-occurrences':
          if (view && canEdit) codeNavigationController.selectAllOccurrencesAtCursor(view);
          break;
        case 'go-back':
          handleEditorGoBack();
          break;
        case 'go-forward':
          handleEditorGoForward();
          break;
      }
    };

    window.addEventListener('keydown', handleEditorBrowserShortcut);
    return () => {
      releaseKeyboardLock();
      window.removeEventListener('keydown', handleEditorBrowserShortcut);
    };
  }, [canEdit, codeNavigationController, handleEditorGoBack, handleEditorGoForward, isMobile, visible]);

  const peek = React.useMemo(() => peekWidget && selectedFile ? {
        id: 'files-editor-peek-widget',
        afterLine: peekWidget.afterLine,
        content: (
          <EditorPeekWidget
            peek={peekWidget}
            currentFilePath={selectedFile.path}
            currentFileContent={draftContent}
            readFileText={readWorkspaceFileText}
            onSelectLocation={(loc: SymbolLocation) => jumpToEditorLocation(loc)}
            onClose={() => {
              setPeekWidget(null);
              editorViewRef.current?.focus();
            }}
          />
        ),
  } : null, [peekWidget, selectedFile, draftContent, readWorkspaceFileText, jumpToEditorLocation, editorViewRef]);
  const symbolsDialog = !isMobile && (<WorkspaceSymbolsDialog
                    open={isWorkspaceSymbolsOpen}
                    onOpenChange={setIsWorkspaceSymbolsOpen}
                    workspaceRoot={root || panelRoot || ''}
                    searchContents={files.searchContents}
                    includeHidden={showHidden}
                    respectGitignore={!showGitignored}
                    onSelectSymbol={(sym) => jumpToEditorLocation({ path: sym.path, line: sym.line, column: sym.column })}
                  />);
  const sourceMenu = (children: React.ReactNode) => isMobile ? children : (
    <ContextMenu>
      <ContextMenuTrigger className="flex min-h-0 flex-1 flex-col">{children}</ContextMenuTrigger>
                  <ContextMenuContent className="min-w-52">
                    <ContextMenuItem onClick={() => {
                      const view = editorViewRef.current;
                      if (view) void codeNavigationController.goToDefinitionAtCursor(view);
                    }}>
                      <span>{t('filesView.editor.goToDefinition')}</span>
                      <span className="ms-auto ps-4 typography-micro text-muted-foreground">F12</span>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => {
                      const view = editorViewRef.current;
                      if (view) void codeNavigationController.goToDefinitionAtCursor(view, { forcePeek: true });
                    }}>
                      <span>{t('filesView.editor.peekDefinition')}</span>
                      <span className="ms-auto ps-4 typography-micro text-muted-foreground">Alt+F12</span>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => {
                      const view = editorViewRef.current;
                      if (view) void codeNavigationController.findReferencesAtCursor(view);
                    }}>
                      <span>{t('filesView.editor.findReferences')}</span>
                      <span className="ms-auto ps-4 typography-micro text-muted-foreground">Shift+F12</span>
                    </ContextMenuItem>
                    {canEdit ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => {
                          const view = editorViewRef.current;
                          if (view) codeNavigationController.renameSymbolAtCursor(view);
                        }}>
                          <span>{t('filesView.editor.renameSymbol')}</span>
                          <span className="ms-auto ps-4 typography-micro text-muted-foreground">F2</span>
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => {
                          const view = editorViewRef.current;
                          if (view) codeNavigationController.selectAllOccurrencesAtCursor(view);
                        }}>
                          <span>{t('filesView.editor.changeAllOccurrences')}</span>
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => {
                          const view = editorViewRef.current;
                          if (view) runToggleEditorComment(view);
                        }}>
                          <span>{t('filesView.editor.toggleComment')}</span>
                        </ContextMenuItem>
                      </>
                    ) : null}
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => setIsSymbolsOpen(true)}>
                      <span>{t('filesView.editor.symbols')}</span>
                    </ContextMenuItem>
                    {files.searchContents ? (
                      <ContextMenuItem onClick={() => setIsWorkspaceSymbolsOpen(true)}>
                        <span>{t('filesView.editor.workspaceSymbols')}</span>
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem onClick={() => setIsGoToLineOpen(true)}>
                      <span>{t('filesView.editor.goToLine')}</span>
                    </ContextMenuItem>
                  </ContextMenuContent>
    </ContextMenu>
  );
  return { codeNavigationController, peek, symbolsDialog, sourceMenu, canNavigateBack, canNavigateForward,
    handleEditorGoBack, handleEditorGoForward, isWorkspaceSymbolsOpen, setIsWorkspaceSymbolsOpen, recordEditorJump };
}
