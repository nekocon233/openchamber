import React from 'react';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { FileContentSearchOutcome, FileContentSearchQuery } from '@/lib/api/types';
import type { DocumentSymbolKind } from '@/lib/codemirror/documentSymbols';
import {
  buildWorkspaceSymbolQueryRegex,
  parseWorkspaceSymbolMatches,
  type WorkspaceSymbolItem,
} from '@/lib/codemirror/symbolNavigation';
import { useI18n } from '@/lib/i18n';

const KIND_ICON = {
  function: 'braces',
  method: 'braces',
  class: 'box-3',
  type: 'code-box',
  module: 'folder-3',
  heading: 'text',
} satisfies Record<DocumentSymbolKind, IconName>;

const WORKSPACE_SYMBOLS_TOGGLE_ATTRIBUTE = 'data-workspace-symbols-toggle';

type WorkspaceSymbolsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceRoot: string;
  searchContents?: (payload: FileContentSearchQuery) => Promise<FileContentSearchOutcome>;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  onSelectSymbol: (symbol: WorkspaceSymbolItem) => void;
};

/**
 * VS Code-style "Go to Symbol in Workspace" (`Mod+T`) overlay that searches
 * declarations across C#, TypeScript/JavaScript, Python, Go, and Rust files.
 */
export const WorkspaceSymbolsDialog: React.FC<WorkspaceSymbolsDialogProps> = ({
  open,
  onOpenChange,
  workspaceRoot,
  searchContents,
  includeHidden,
  respectGitignore,
  onSelectSymbol,
}) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 180);
  const [items, setItems] = React.useState<WorkspaceSymbolItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
  }, [open]);

  React.useEffect(() => {
    if (!open || !searchContents || !workspaceRoot) {
      setItems([]);
      setLoading(false);
      return;
    }
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      setItems([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void searchContents({
      directory: workspaceRoot,
      query: buildWorkspaceSymbolQueryRegex(trimmed),
      regex: true,
      limit: 120,
      includeHidden,
      respectGitignore,
      signal: controller.signal,
    }).then((outcome) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (outcome.status === 'ok') {
        setItems(parseWorkspaceSymbolMatches(outcome.matches));
      } else {
        setItems([]);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setItems([]);
      }
    });

    return () => controller.abort();
  }, [debouncedQuery, includeHidden, open, respectGitignore, searchContents, workspaceRoot]);

  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !panelRef.current || panelRef.current.contains(target)) return;
      if (target.closest(`[${WORKSPACE_SYMBOLS_TOGGLE_ATTRIBUTE}]`)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onOpenChange, open]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      data-editor-overlay
      className="absolute inset-s-3 top-3 z-40 w-[min(32rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-lg"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
      }}
    >
      <Command
        loop
        shouldFilter={false}
        className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1 [&_[cmdk-item]]:typography-meta"
      >
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={t('filesView.workspaceSymbols.placeholder')}
          aria-label={t('filesView.workspaceSymbols.placeholder')}
        />
        <CommandList className="max-h-[min(22rem,calc(100vh-16rem))]">
          <CommandEmpty className="px-3 py-4 typography-meta text-muted-foreground">
            {!query.trim()
              ? t('filesView.workspaceSymbols.typeToSearch')
              : loading
                ? t('sidebarFilesTree.state.searching')
                : t('filesView.symbols.noMatches')}
          </CommandEmpty>
          {items.map((item) => (
            <CommandItem
              key={`${item.path}:${item.line}:${item.name}`}
              value={`${item.name}\u0000${item.path}:${item.line}`}
              onSelect={() => {
                onSelectSymbol(item);
                onOpenChange(false);
              }}
              className="gap-2"
            >
              <Icon name={KIND_ICON[item.kind]} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium text-foreground">{item.name}</span>
              <span className="flex min-w-0 flex-1 items-center justify-end gap-1 text-muted-foreground" dir="ltr">
                <FileTypeIcon filePath={item.path} className="size-3 shrink-0" />
                <span className="truncate">{item.relativePath}</span>
                <span className="shrink-0 tabular-nums">{`:${item.line}`}</span>
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
};
