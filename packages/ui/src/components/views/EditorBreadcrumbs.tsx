import React from 'react';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
  enclosingSymbolsAtPosition,
  readDocumentSymbols,
  type DocumentSymbol,
  type DocumentSymbolKind,
} from '@/lib/codemirror/documentSymbols';
import { useI18n } from '@/lib/i18n';

const SYMBOL_KIND_ICON = {
  function: 'braces',
  method: 'braces',
  class: 'box-3',
  type: 'code-box',
  module: 'folder-3',
  heading: 'text',
} satisfies Record<DocumentSymbolKind, IconName>;

type EditorBreadcrumbsProps = {
  filePath: string;
  relativePath: string;
  viewRef: React.RefObject<EditorView | null>;
  viewReadyNonce: number;
  onSelectSymbol?: (symbol: DocumentSymbol) => void;
};

/**
 * Compact VS Code-style breadcrumb strip above the code editor showing the
 * file's workspace path segments followed by the active enclosing symbol
 * hierarchy (`namespace > class > method`). Clicking a symbol opens the
 * document symbol menu to jump to any declaration in the file.
 */
export const EditorBreadcrumbs: React.FC<EditorBreadcrumbsProps> = ({
  filePath,
  relativePath,
  viewRef,
  viewReadyNonce,
  onSelectSymbol,
}) => {
  const { t } = useI18n();
  const [activeChain, setActiveChain] = React.useState<DocumentSymbol[]>([]);
  const [allSymbols, setAllSymbols] = React.useState<DocumentSymbol[]>([]);

  const syncFromView = React.useCallback(() => {
    const view = viewRef.current;
    if (!view) {
      setActiveChain([]);
      return;
    }
    const pos = view.state.selection.main.head;
    setActiveChain(enclosingSymbolsAtPosition(view.state, pos, 60));
  }, [viewRef]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      setActiveChain([]);
      setAllSymbols([]);
      return;
    }
    syncFromView();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSync = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        syncFromView();
      }, 80);
    };

    const dom = view.contentDOM;
    dom.addEventListener('keyup', scheduleSync);
    dom.addEventListener('mouseup', scheduleSync);
    return () => {
      if (timer) clearTimeout(timer);
      dom.removeEventListener('keyup', scheduleSync);
      dom.removeEventListener('mouseup', scheduleSync);
    };
  }, [filePath, syncFromView, viewReadyNonce, viewRef]);

  const jumpToSymbol = React.useCallback((symbol: DocumentSymbol) => {
    const view = viewRef.current;
    if (!view) return;
    onSelectSymbol?.(symbol);
    view.dispatch({
      selection: EditorSelection.cursor(symbol.from),
      effects: EditorView.scrollIntoView(symbol.from, { y: 'center' }),
    });
    view.focus();
    syncFromView();
  }, [onSelectSymbol, syncFromView, viewRef]);

  const pathSegments = React.useMemo(() => {
    const normalized = (relativePath || filePath).replace(/^\/+/, '');
    return normalized ? normalized.split('/').filter(Boolean) : [];
  }, [filePath, relativePath]);

  if (pathSegments.length === 0 && activeChain.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={t('filesView.editor.breadcrumbsAria')}
      dir="ltr"
      className="flex h-6 shrink-0 items-center gap-1 overflow-x-auto border-b border-edge-muted px-3 typography-micro text-muted-foreground"
    >
      {pathSegments.map((segment, index) => {
        const isLastSegment = index === pathSegments.length - 1;
        return (
          <React.Fragment key={`path:${index}:${segment}`}>
            {index > 0 ? (
              <Icon name="arrow-right-s" className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="flex shrink-0 items-center gap-1">
              {isLastSegment ? <FileTypeIcon filePath={filePath} className="size-3 shrink-0" /> : null}
              <span className={isLastSegment && activeChain.length === 0 ? 'text-foreground' : undefined}>
                {segment}
              </span>
            </span>
          </React.Fragment>
        );
      })}

      {activeChain.map((symbol) => (
        <React.Fragment key={`sym:${symbol.from}:${symbol.name}`}>
          <Icon name="arrow-right-s" className="size-3 shrink-0 text-muted-foreground" />
          <DropdownMenu
            onOpenChange={(open) => {
              if (open && viewRef.current) {
                setAllSymbols(readDocumentSymbols(viewRef.current.state, 200));
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-foreground transition-colors hover:bg-interactive-hover"
              >
                <Icon name={SYMBOL_KIND_ICON[symbol.kind]} className="size-3 shrink-0 text-muted-foreground" />
                <span>{symbol.name}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 min-w-48 overflow-y-auto">
              {allSymbols.map((item) => (
                <DropdownMenuItem
                  key={`${item.from}:${item.name}`}
                  onClick={() => jumpToSymbol(item)}
                  className="flex items-center justify-between gap-2 typography-meta"
                >
                  <span
                    className="flex min-w-0 items-center gap-1.5"
                    style={{ paddingInlineStart: `${item.depth * 10}px` }}
                  >
                    <Icon name={SYMBOL_KIND_ICON[item.kind]} className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{item.line}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </React.Fragment>
      ))}
    </nav>
  );
};
