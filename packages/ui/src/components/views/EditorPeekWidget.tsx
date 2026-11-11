import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { handleDropdownNavigationKey, shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PeekWidgetState } from '@/lib/codemirror/lspWorkspaceBridge';
import type { SymbolLocation } from '@/lib/codemirror/symbolNavigation';

type EditorPeekWidgetProps = {
  peek: PeekWidgetState;
  currentFilePath: string;
  currentFileContent: string;
  readFileText?: (path: string) => Promise<string | null>;
  onSelectLocation: (location: SymbolLocation) => void;
  onClose: () => void;
};

type SnippetState = {
  status: 'loading' | 'ready' | 'unavailable';
  lines: Array<{ number: number; text: string; isTarget: boolean }>;
};

const CONTEXT_RADIUS = 4;

const buildSnippetLines = (content: string, targetLine: number): SnippetState['lines'] => {
  const rawLines = content.split(/\r?\n/);
  const start = Math.max(1, targetLine - CONTEXT_RADIUS);
  const end = Math.min(rawLines.length, targetLine + CONTEXT_RADIUS);
  const lines: SnippetState['lines'] = [];
  for (let lineNo = start; lineNo <= end; lineNo += 1) {
    lines.push({
      number: lineNo,
      text: rawLines[lineNo - 1] ?? '',
      isTarget: lineNo === targetLine,
    });
  }
  return lines;
};

export const EditorPeekWidget: React.FC<EditorPeekWidgetProps> = ({
  peek,
  currentFilePath,
  currentFileContent,
  readFileText,
  onSelectLocation,
  onClose,
}) => {
  const { t } = useI18n();
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [snippetCache, setSnippetCache] = React.useState<Record<string, string>>({});
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setSelectedIndex(0);
    window.requestAnimationFrame(() => {
      rootRef.current?.focus();
    });
  }, [peek.mode, peek.symbolName, peek.afterLine, peek.locations]);

  const activeLocation = peek.locations[Math.min(selectedIndex, Math.max(0, peek.locations.length - 1))] ?? null;

  React.useEffect(() => {
    if (!activeLocation) return;
    if (activeLocation.path === currentFilePath || snippetCache[activeLocation.path] !== undefined || !readFileText) {
      return;
    }
    let cancelled = false;
    void readFileText(activeLocation.path).then((content) => {
      if (cancelled || content === null) return;
      setSnippetCache((prev) => ({ ...prev, [activeLocation.path]: content }));
    });
    return () => {
      cancelled = true;
    };
  }, [activeLocation, currentFilePath, readFileText, snippetCache]);

  const snippet: SnippetState = React.useMemo(() => {
    if (!activeLocation) {
      return { status: 'unavailable', lines: [] };
    }
    if (activeLocation.path === currentFilePath) {
      return {
        status: 'ready',
        lines: buildSnippetLines(currentFileContent, activeLocation.line),
      };
    }
    const cached = snippetCache[activeLocation.path];
    if (cached !== undefined) {
      return {
        status: 'ready',
        lines: buildSnippetLines(cached, activeLocation.line),
      };
    }
    if (!readFileText) {
      return {
        status: 'ready',
        lines: [{ number: activeLocation.line, text: activeLocation.text, isTarget: true }],
      };
    }
    return { status: 'loading', lines: [] };
  }, [activeLocation, currentFileContent, currentFilePath, readFileText, snippetCache]);

  const stepSelection = React.useCallback((delta: 1 | -1) => {
    if (peek.locations.length === 0) return;
    setSelectedIndex((prev) => (prev + delta + peek.locations.length) % peek.locations.length);
  }, [peek.locations.length]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (shouldDismissDropdown(event)) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (handleDropdownNavigationKey(event, (key) => stepSelection(key === 'ArrowDown' ? 1 : -1))) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      stepSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      stepSelection(-1);
      return;
    }
    if (event.key === 'Enter' && activeLocation) {
      event.preventDefault();
      event.stopPropagation();
      onSelectLocation(activeLocation);
    }
  };

  const title = peek.mode === 'definition'
    ? t('filesView.editor.peek.definitionTitle', { symbol: peek.symbolName, count: peek.locations.length })
    : t('filesView.editor.peek.referencesTitle', { symbol: peek.symbolName, count: peek.locations.length });

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="region"
      aria-label={title}
      data-editor-peek-widget="true"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      className="my-1 overflow-hidden rounded-lg border border-edge bg-[var(--surface-elevated)] text-foreground shadow-md focus:outline-none"
      style={{ marginInlineStart: 'var(--oc-editor-gutter-width, 0px)' }}
    >
      <div className="flex h-7 items-center justify-between gap-2 border-b border-edge-muted px-2.5 typography-meta">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name={peek.mode === 'definition' ? 'code-sslash' : 'link'} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{title}</span>
          {activeLocation ? (
            <span className="truncate text-muted-foreground" dir="ltr">
              {`${activeLocation.relativePath}:${activeLocation.line}`}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {activeLocation ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onSelectLocation(activeLocation)}
              title={t('filesView.editor.peek.openInEditor')}
            >
              <Icon name="external-link" className="size-3.5" />
              <span>{t('filesView.editor.peek.openInEditor')}</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onClose}
            aria-label={t('filesView.editor.gitHunk.close')}
          >
            <Icon name="close" className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid max-h-56 min-h-32 grid-cols-1 divide-y divide-edge-muted sm:grid-cols-12 sm:divide-x sm:divide-y-0">
        <div
          role="listbox"
          aria-label={title}
          className="max-h-56 overflow-y-auto p-1 sm:col-span-5"
        >
          {peek.locations.map((loc, idx) => {
            const isSelected = idx === selectedIndex;
            const fileName = loc.relativePath.split('/').pop() ?? loc.relativePath;
            return (
              <button
                key={`${loc.path}:${loc.line}:${loc.column}:${idx}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => setSelectedIndex(idx)}
                onDoubleClick={() => onSelectLocation(loc)}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded-md px-2 py-1 text-start transition-colors',
                  isSelected
                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                    : 'hover:bg-interactive-hover',
                )}
              >
                <div className="flex w-full min-w-0 items-center gap-1.5 typography-meta">
                  <FileTypeIcon filePath={loc.path} className="size-3.5 shrink-0" />
                  <span className="truncate font-medium" dir="auto">{fileName}</span>
                  <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">{`:${loc.line}`}</span>
                </div>
                <div className="w-full truncate font-mono typography-micro text-muted-foreground" dir="ltr">
                  {loc.text}
                </div>
              </button>
            );
          })}
        </div>

        <div
          dir="ltr"
          onDoubleClick={() => {
            if (activeLocation) onSelectLocation(activeLocation);
          }}
          className="oc-surface-code max-h-56 overflow-auto p-2 font-mono typography-micro sm:col-span-7"
        >
          {snippet.status === 'loading' ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              {t('filesView.editor.peek.loadingPreview')}
            </div>
          ) : (
            snippet.lines.map((line) => (
              <div
                key={line.number}
                className={cn(
                  'flex items-baseline gap-2.5 rounded px-1.5 py-0.5 whitespace-pre',
                  line.isTarget && 'bg-interactive-selection/20 font-medium text-foreground',
                )}
              >
                <span className="w-8 shrink-0 select-none text-end tabular-nums text-muted-foreground">
                  {line.number}
                </span>
                <span className="min-w-0 flex-1">{line.text || ' '}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
