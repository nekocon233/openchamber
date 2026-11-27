import React from 'react';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { observeDocumentOutline, readDocumentSymbols, type DocumentSymbol, type DocumentSymbolKind } from '@/lib/codemirror/documentSymbols';

const KIND_ICON = {
    function: 'braces',
    method: 'braces',
    class: 'box-3',
    interface: 'box-3',
    enum: 'code-box',
    field: 'code-box',
    property: 'code-box',
    type: 'code-box',
    module: 'folder-3',
    heading: 'text',
} satisfies Record<DocumentSymbolKind, IconName>;

type KindFilter = DocumentSymbolKind | 'all';

type DocumentSymbolsPanelProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // external: https://github.com/facebook/react/issues/34840 Editor refs keep dev profiling from traversing cross-origin frames.
    viewRef: React.RefObject<EditorView | null>;
};

function outlineRows(symbols: DocumentSymbol[], kind: KindFilter, query: string, collapsed: ReadonlySet<number>) {
    const needle = query.trim().toLowerCase();
    const displayed = new Set<number>();
    const ancestors: DocumentSymbol[] = [];
    for (const symbol of symbols) {
        while (ancestors.length && ancestors[ancestors.length - 1].depth >= symbol.depth) ancestors.pop();
        if ((kind === 'all' || symbol.kind === kind) && symbol.name.toLowerCase().includes(needle)) {
            displayed.add(symbol.from);
            for (const ancestor of ancestors) displayed.add(ancestor.from);
        }
        ancestors.push(symbol);
    }
    const matches = symbols.filter((symbol) => displayed.has(symbol.from));
    const rows = [];
    let collapsedDepth: number | null = null;
    for (const [index, symbol] of matches.entries()) {
        if (collapsedDepth !== null && symbol.depth > collapsedDepth) continue;
        const expandable = (matches[index + 1]?.depth ?? -1) > symbol.depth;
        const folded = expandable && collapsed.has(symbol.from) && !needle;
        rows.push({ symbol, expandable, folded });
        collapsedDepth = folded ? symbol.depth : null;
    }
    return rows;
}

export function DocumentSymbolsPanel({ open, onOpenChange, viewRef }: DocumentSymbolsPanelProps) {
    const { t } = useI18n();
    const view = viewRef.current;
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const [symbols, setSymbols] = React.useState<DocumentSymbol[]>([]);
    const [active, setActive] = React.useState<number | null>(null);
    const [query, setQuery] = React.useState('');
    const [kind, setKind] = React.useState<KindFilter>('all');
    const [collapsed, setCollapsed] = React.useState<ReadonlySet<number>>(() => new Set());

    React.useEffect(() => {
        if (!open || !view) return;
        setQuery('');
        setKind('all');
        setCollapsed(new Set());
        let outline = readDocumentSymbols(view.state);
        const updateActive = (position: number) => {
            let declaration = null;
            for (const symbol of outline) {
                if ((symbol.scopeFrom ?? symbol.from) <= position && position < (symbol.scopeTo ?? symbol.from + 1)) {
                    declaration = symbol.from;
                }
            }
            setActive(declaration);
        };
        setSymbols(outline);
        updateActive(view.state.selection.main.head);
        return observeDocumentOutline(view, (update) => {
            if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
                outline = readDocumentSymbols(update.state, 0);
                setSymbols(outline);
                if (update.docChanged) setCollapsed(new Set());
                updateActive(update.state.selection.main.head);
            } else if (update.selectionSet) {
                updateActive(update.state.selection.main.head);
            }
        });
    }, [open, view]);

    const close = React.useCallback(() => {
        onOpenChange(false);
        view?.focus();
    }, [onOpenChange, view]);

    React.useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element) || !panelRef.current || panelRef.current.contains(target) || view?.dom.contains(target)) return;
            if (target.closest('[data-document-symbols-toggle], [data-document-symbols-filter]')) return;
            onOpenChange(false);
        };
        const handleEditorEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            close();
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        view?.dom.addEventListener('keydown', handleEditorEscape);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            view?.dom.removeEventListener('keydown', handleEditorEscape);
        };
    }, [close, onOpenChange, open, view]);

    const rows = React.useMemo(() => outlineRows(symbols, kind, query, collapsed), [symbols, kind, query, collapsed]);
    const kinds = React.useMemo(() => [...new Set(symbols.map((symbol) => symbol.kind))], [symbols]);
    const select = (symbol: DocumentSymbol) => {
        if (!view || symbol.from > view.state.doc.length) return;
        view.dispatch({
            selection: EditorSelection.cursor(symbol.from),
            effects: EditorView.scrollIntoView(symbol.from, { y: 'center' }),
        });
        view.focus();
    };

    if (!open) return null;

    return (
        <div
            ref={panelRef}
            data-editor-overlay
            role="region"
            aria-label={t('filesView.editor.symbols')}
            className="oc-surface-floating oc-glass-floating absolute inset-e-3 top-3 z-40 w-[min(24rem,calc(100%-1.5rem))] rounded-xl"
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.defaultPrevented) return;
                event.preventDefault();
                event.stopPropagation();
                close();
            }}
        >
            <Command loop shouldFilter={false} className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1 [&_[cmdk-item]]:typography-meta">
                <div className="flex items-center gap-2 pe-2 [&_[data-slot=command-input-wrapper]]:min-w-0 [&_[data-slot=command-input-wrapper]]:flex-1">
                    <CommandInput
                        autoFocus
                        value={query}
                        onValueChange={setQuery}
                        placeholder={t('filesView.symbols.placeholder')}
                        aria-label={t('filesView.symbols.placeholder')}
                    />
                    <Select<KindFilter> value={kind} onValueChange={setKind}>
                        <SelectTrigger aria-label={t('filesView.symbols.filterKind')} className="max-w-[45%]">
                            <SelectValue>{t(`filesView.symbols.kind.${kind}`)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent data-document-symbols-filter>
                            <SelectItem value="all">{t('filesView.symbols.kind.all')}</SelectItem>
                            {kinds.map((entry) => (
                                <SelectItem key={entry} value={entry}>{t(`filesView.symbols.kind.${entry}`)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <CommandList className="max-h-[min(20rem,calc(100vh-16rem))]">
                    {rows.length === 0 && <CommandEmpty className="px-3 py-4 typography-meta text-muted-foreground">
                        {symbols.length === 0 ? t('filesView.symbols.noneInFile') : t('filesView.symbols.noMatches')}
                    </CommandEmpty>}
                    {rows.map(({ symbol, expandable, folded }) => (
                        <div key={symbol.from} className="flex items-center" style={{ paddingInlineStart: `${Math.min(symbol.depth, 12) * 12}px` }}>
                            {expandable && !query.trim() ? (
                                <button
                                    type="button"
                                    aria-label={symbol.name}
                                    aria-expanded={!folded}
                                    className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover focus-visible:bg-interactive-hover"
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                                    }}
                                    onClick={() => setCollapsed((previous) => {
                                        const next = new Set(previous);
                                        if (!next.delete(symbol.from)) next.add(symbol.from);
                                        return next;
                                    })}
                                >
                                    <Icon name={folded ? 'arrow-right-s' : 'arrow-down-s'} className="size-4" />
                                </button>
                            ) : <span className="w-7 shrink-0" aria-hidden />}
                            <CommandItem
                                value={String(symbol.from)}
                                onSelect={() => select(symbol)}
                                aria-current={active === symbol.from ? 'location' : undefined}
                                className="min-w-0 flex-1 gap-2 aria-[current=location]:bg-interactive-selection aria-[current=location]:font-semibold"
                            >
                                <Icon name={KIND_ICON[symbol.kind]} className="size-3.5 shrink-0 text-muted-foreground" />
                                <span dir="auto" className="min-w-0 flex-1 truncate text-foreground" title={t(`filesView.symbols.kind.${symbol.kind}`)}>{symbol.name}</span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">{symbol.line}</span>
                            </CommandItem>
                        </div>
                    ))}
                </CommandList>
            </Command>
        </div>
    );
}
