import type { useFileCodeNavigation } from './useFileCodeNavigation';
import { type ToolbarAction } from '@/components/ui/action-toolbar';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { type useFileKinds } from './useFileKinds';
import { type useFileDraft } from './useFileSaving';
import { type useFileEditor } from './useFileEditorExtensions';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type buildFileModeActions } from './buildFileModeActions';
import { type useFileReadAloud } from './useFileReadAloud';
import { type useFileViewModes } from './useFilePreviewModes';
import { useI18n } from '@/lib/i18n';

export function buildFileSourceActions({ codeNavigation, files, draft, editor, fileKinds, markdownPreview, modeActions, readAloud, viewModes, isMobile, t }: {
  codeNavigation: ReturnType<typeof useFileCodeNavigation>;
  files: Pick<import('@/lib/api/types').FilesAPI, 'searchContents'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'shortcutOverrides'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'isGoToLineOpen' | 'isSearchOpen' | 'isSymbolsOpen' | 'setIsGoToLineOpen' | 'setIsSearchOpen' | 'setIsSymbolsOpen' | 'setWrapLines' | 'wrapLines'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isMarkdown' | 'isTable' | 'isTextFile' | 'sourceEditorShown'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'mdPreviewFindOpen' | 'mdPreviewOutlineOpen' | 'setMdPreviewFindFocusNonce' | 'setMdPreviewFindOpen' | 'setMdPreviewOutlineOpen'>;
  modeActions: Pick<ReturnType<typeof buildFileModeActions>, 'hasSourceEditor' | 'mdPreview' | 'openSourceEditor'>;
  readAloud: Pick<ReturnType<typeof useFileReadAloud>, 'isTTSPlaying' | 'showMessageTTSButtons' | 'toggleTTS'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'tableViewMode'>;
  isMobile: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { shortcutOverrides } = draft;
  const { isGoToLineOpen, isSearchOpen, isSymbolsOpen, setIsGoToLineOpen, setIsSearchOpen, setIsSymbolsOpen, setWrapLines, wrapLines } = editor;
  const { isMarkdown, isTable, isTextFile, sourceEditorShown } = fileKinds;
  const { mdPreviewFindOpen, mdPreviewOutlineOpen, setMdPreviewFindFocusNonce, setMdPreviewFindOpen, setMdPreviewOutlineOpen } = markdownPreview;
  const { hasSourceEditor, mdPreview, openSourceEditor } = modeActions;
  const { isTTSPlaying, showMessageTTSButtons, toggleTTS } = readAloud;
  const { tableViewMode } = viewModes;
    const searchOpen = mdPreview ? mdPreviewFindOpen : (sourceEditorShown && isSearchOpen);
    const searchAction: ToolbarAction | null = hasSourceEditor && !(isTable && tableViewMode === 'table') ? {
      id: 'search',
      label: t('filesView.editor.findInFile'),
      icon: 'search',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('find_in_file', shortcutOverrides), ''),
      pressed: searchOpen,
      onSelect: () => {
        if (mdPreview) {
          if (mdPreviewFindOpen) {
            setMdPreviewFindOpen(false);
            return;
          }
          setMdPreviewFindOpen(true);
          setMdPreviewFindFocusNonce((value) => value + 1);
          return;
        }
        openSourceEditor();
        setIsSearchOpen(!searchOpen);
      },
    } : null;

    const outlineAction: ToolbarAction | null = isMarkdown && isTextFile ? {
      id: 'outline',
      label: t('filesView.preview.outline.label'),
      icon: 'list-unordered',
      pressed: mdPreview ? mdPreviewOutlineOpen : sourceEditorShown && isSymbolsOpen,
      onSelect: () => {
        if (mdPreview) {
          setMdPreviewOutlineOpen(!mdPreviewOutlineOpen);
          return;
        }
        openSourceEditor();
        setIsSymbolsOpen((open) => !sourceEditorShown || !open);
      },
      buttonAttributes: { 'data-markdown-outline-toggle': '', 'data-document-symbols-toggle': '' },
    } : null;

    const goToLineAction: ToolbarAction | null = hasSourceEditor ? {
      id: 'go-to-line',
      label: t('filesView.editor.goToLine'),
      icon: 'hashtag',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('open_go_to_line', shortcutOverrides), ''),
      pressed: isGoToLineOpen,
      onSelect: () => {
        openSourceEditor();
        setIsGoToLineOpen((open) => !sourceEditorShown || !open);
      },
      buttonAttributes: { 'data-go-to-line-toggle': '' },
    } : null;

    const symbolsAction: ToolbarAction | null = hasSourceEditor && !isMobile ? {
      id: 'symbols',
      label: t('filesView.editor.symbols'),
      icon: 'braces',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('open_document_symbols', shortcutOverrides), ''),
      pressed: isSymbolsOpen,
      onSelect: () => {
        openSourceEditor();
        setIsSymbolsOpen((open) => !sourceEditorShown || !open);
      },
      buttonAttributes: { 'data-document-symbols-toggle': '' },
    } : null;

    const { isWorkspaceSymbolsOpen, setIsWorkspaceSymbolsOpen, canNavigateBack, canNavigateForward,
      handleEditorGoBack, handleEditorGoForward, codeNavigationController } = codeNavigation;
    const { editorViewRef } = editor;
    const workspaceSymbolsAction: ToolbarAction | null = hasSourceEditor && !isMobile && Boolean(files.searchContents) ? {
      id: 'workspace-symbols',
      label: t('filesView.editor.workspaceSymbols'),
      icon: 'code-box',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('open_workspace_symbols', shortcutOverrides), ''),
      pressed: isWorkspaceSymbolsOpen,
      onSelect: () => {
        openSourceEditor();
        setIsWorkspaceSymbolsOpen((open) => !sourceEditorShown || !open);
      },
      buttonAttributes: { 'data-workspace-symbols-toggle': '' },
    } : null;

    const goToDefinitionAction: ToolbarAction | null = hasSourceEditor && !isMobile ? {
      id: 'go-to-definition',
      label: t('filesView.editor.goToDefinition'),
      icon: 'code-sslash',
      shortcut: 'F12',
      onSelect: () => {
        openSourceEditor();
        const view = editorViewRef.current;
        if (view) void codeNavigationController.goToDefinitionAtCursor(view);
      },
    } : null;

    const findReferencesAction: ToolbarAction | null = hasSourceEditor && !isMobile ? {
      id: 'find-references',
      label: t('filesView.editor.findReferences'),
      icon: 'link',
      shortcut: 'Shift+F12',
      onSelect: () => {
        openSourceEditor();
        const view = editorViewRef.current;
        if (view) void codeNavigationController.findReferencesAtCursor(view);
      },
    } : null;

    const navigateBackAction: ToolbarAction | null = hasSourceEditor && !isMobile && canNavigateBack ? {
      id: 'editor-navigate-back',
      label: t('filesView.editor.navigateBack'),
      icon: 'arrow-left-s',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('editor_go_back', shortcutOverrides), ''),
      onSelect: () => {
        handleEditorGoBack();
      },
    } : null;

    const navigateForwardAction: ToolbarAction | null = hasSourceEditor && !isMobile && canNavigateForward ? {
      id: 'editor-navigate-forward',
      label: t('filesView.editor.navigateForward'),
      icon: 'arrow-right-s',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('editor_go_forward', shortcutOverrides), ''),
      onSelect: () => {
        handleEditorGoForward();
      },
    } : null;

    const wrapAction: ToolbarAction | null = isTextFile ? {
      id: 'wrap',
      label: t('documentToolbar.wrapLines'),
      icon: 'text-wrap',
      pressed: wrapLines,
      onSelect: () => setWrapLines(!wrapLines),
    } : null;

    const readAloudAction: ToolbarAction | null = isMarkdown && showMessageTTSButtons ? {
      id: 'read-aloud',
      label: isTTSPlaying ? t('filesView.tts.stopSpeaking') : t('filesView.tts.readAloud'),
      icon: 'volume-up',
      iconClassName: isTTSPlaying ? 'text-[var(--primary-text)]' : undefined,
      onSelect: toggleTTS,
    } : null;

  return { workspaceSymbolsAction, goToDefinitionAction, findReferencesAction, navigateBackAction, navigateForwardAction, searchAction, outlineAction, goToLineAction, symbolsAction, wrapAction, readAloudAction };
}
