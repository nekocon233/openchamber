import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent } from '@/components/ui/tooltip';
import { getCurrentIntlLocale } from '@/lib/i18n';
import type { ModelMetadata } from '@/types';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';
import { LEADING_ACTION_SLOT, entryOf } from './modelPickerNavigation';

type ModelPickerFavoriteEntry = ModelPickerEntry;

type HiddenModel = { providerID: string; modelID: string };

export type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

const formatUsdCurrency = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
}).format(value);

const formatCost = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatUsdCurrency(value);
};

const hasTooltipMetadata = (metadata?: ModelMetadata) => {
  if (!metadata) return false;
  return Boolean(
    metadata.tool_call ||
    metadata.reasoning ||
    metadata.cost?.input !== undefined ||
    metadata.cost?.output !== undefined ||
    (metadata.modalities?.input?.length ?? 0) > 0 ||
    (metadata.modalities?.output?.length ?? 0) > 0,
  );
};

const ROW_TOOLTIP_OFFSET = 20;

const ROW_TOOLTIP_ROOM = 320 + ROW_TOOLTIP_OFFSET;

const pickRowTooltipSide = (row: Element | null): 'right' | 'left' | null => {
  if (!row || typeof window === 'undefined') return null;
  const rect = row.getBoundingClientRect();
  if (window.innerWidth - rect.right >= ROW_TOOLTIP_ROOM) return 'right';
  if (rect.left >= ROW_TOOLTIP_ROOM) return 'left';
  return null;
};

export const ModelPickerCardBody: React.FC<{
  metadata?: ModelMetadata;
  providerName: string | null;
  labels: ModelPickerListProps['labels'];
}> = ({ metadata, providerName, labels }) => {
  const inputModalities = metadata?.modalities?.input ?? [];
  const outputModalities = metadata?.modalities?.output ?? [];
  const capabilities = [
    metadata?.tool_call ? labels.capabilityToolCalling : null,
    metadata?.reasoning ? labels.capabilityReasoning : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2 text-start text-xs">
      {providerName ? (
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="typography-meta font-medium">{labels.provider}</span>
          <span className="typography-meta text-foreground">{providerName}</span>
        </div>
      ) : null}
      {capabilities.length > 0 ? (
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="typography-meta font-medium">{labels.capabilities}</span>
          <span className="typography-meta text-foreground">{capabilities.join(', ')}</span>
        </div>
      ) : null}
      {inputModalities.length > 0 ? (
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="typography-meta font-medium">{labels.input}</span>
          <span className="typography-meta text-foreground">{inputModalities.join(', ')}</span>
        </div>
      ) : null}
      {outputModalities.length > 0 ? (
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="typography-meta font-medium">{labels.output}</span>
          <span className="typography-meta text-foreground">{outputModalities.join(', ')}</span>
        </div>
      ) : null}
      {(metadata?.cost?.input !== undefined || metadata?.cost?.output !== undefined) ? (
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="typography-meta font-medium">{labels.costPerMillion}</span>
          <span className="typography-meta text-foreground">In {formatCost(metadata?.cost?.input)} · Out {formatCost(metadata?.cost?.output)}</span>
        </div>
      ) : null}
    </div>
  );
};

export const ModelPickerRowCard: React.FC<{
  store: IndexSelectionStore;
  navigation: readonly NavigationItem[];
  itemRefs: React.RefObject<(HTMLDivElement | null)[]>;
  active: boolean;
  layoutVersion: string;
  describe: (entry: ModelPickerEntry) => { metadata?: ModelMetadata; providerName: string | null };
  labels: ModelPickerListProps['labels'];
}> = ({ store, navigation, itemRefs, active, layoutVersion, describe, labels }) => {
  const index = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const entry = entryOf(navigation[index]);
  const [placement, setPlacement] = React.useState<{ anchor: HTMLElement; side: 'right' | 'left' } | null>(null);

  React.useEffect(() => {
    setPlacement(null);
    if (!active || !entry) return;
    const timeout = window.setTimeout(() => {
      const anchor = itemRefs.current[index];
      const side = pickRowTooltipSide(anchor ?? null);
      if (anchor && side) setPlacement({ anchor, side });
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [active, entry, index, itemRefs]);

  React.useLayoutEffect(() => {
    setPlacement((current) => {
      if (!current || current.anchor.isConnected) return current;
      const anchor = itemRefs.current[index];
      return anchor ? { ...current, anchor } : null;
    });
  }, [index, itemRefs, layoutVersion]);

  if (!entry || !placement || !placement.anchor.isConnected) return null;
  const { metadata, providerName } = describe(entry);
  if (!providerName && !hasTooltipMetadata(metadata)) return null;

  return (
    <Tooltip open onOpenChange={() => {}}>
      <TooltipContent surface="card" anchor={placement.anchor} side={placement.side} align="start" sideOffset={ROW_TOOLTIP_OFFSET} className="max-w-xs text-start transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100">
        <ModelPickerCardBody metadata={metadata} providerName={providerName} labels={labels} />
      </TooltipContent>
    </Tooltip>
  );
};

export const ModelPickerRowHighlight: React.FC<{
  store: IndexSelectionStore;
  index: number;
  renderVersion?: number;
  children: (isHighlighted: boolean) => React.ReactNode;
}> = React.memo(({ store, index, children }) => {
  const [isHighlighted, setIsHighlighted] = React.useState(() => index >= 0 && store.getSnapshot() === index);

  React.useEffect(() => {
    if (index < 0) {
      setIsHighlighted(false);
      return;
    }
    const sync = () => setIsHighlighted(store.getSnapshot() === index);
    sync();
    return store.subscribeIndex(index, sync);
  }, [index, store]);

  return <>{children(isHighlighted)}</>;
});

export type ModelPickerAction = {
  id: string;
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  selected?: boolean;
  favorite?: boolean;
  onToggleFavorite?: () => void;
};

export type NavigationItem = ModelPickerEntry | typeof LEADING_ACTION_SLOT | { kind: 'action'; action: ModelPickerAction };

export const ModelPickerFooter: React.FC<{
  store: IndexSelectionStore;
  navigationList: NavigationItem[];
  footerContent: ModelPickerListProps['footerContent'];
  fallback: React.ReactNode;
}> = ({ store, navigationList, footerContent, fallback }) => {
  const selectedIndex = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

  const activeEntry = entryOf(navigationList[selectedIndex]);
  return <>{typeof footerContent === 'function' ? footerContent(activeEntry) : (footerContent ?? fallback)}</>;
};

export type SortableShell = {
  setNodeRef: (element: HTMLElement | null) => void;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  listeners: ReturnType<typeof useSortable>['listeners'];
  style: React.CSSProperties;
  isDragging: boolean;
};

export const SortableRow: React.FC<{
  id: string;
  disabled: boolean;
  children: (shell: SortableShell) => React.ReactNode;
}> = ({ id, disabled, children }) => {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return <>{children({
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    style: { transform: DndCSS.Translate.toString(transform), transition },
    isDragging,
  })}</>;
};

export interface ModelPickerListProps {
  providers: ModelPickerProvider[];
  favoriteModels: ModelPickerFavoriteEntry[];
  favoriteActions?: ModelPickerAction[];
  favoriteOrder?: string[];
  onReorderFavoriteItem?: (active: string, over: string) => void;
  onReorderAction?: (active: string, over: string) => void;
  recentModels: ModelPickerFavoriteEntry[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelect: (entry: ModelPickerEntry) => void;
  labels: {
    searchPlaceholder: string;
    list?: string;
    noResults: string;
    favorites: string;
    recent: string;
    keyboardHint: string;
    notSelected?: string;
    favorite?: string;
    unfavorite?: string;
    provider?: string;
    capabilities?: string;
    capabilityToolCalling?: string;
    capabilityReasoning?: string;
    input?: string;
    output?: string;
    costPerMillion?: string;
  };
  selectedModel?: { providerID: string; modelID: string } | null;
  leadingEntry?: ModelPickerEntry | null;
  leadingAction?: { label: string; icon: React.ReactNode; onSelect: () => void } | null;
  /** Named non-model selections share the model list's search and keyboard navigation. */
  actionGroup?: { id: string; label: string; icon?: React.ReactNode; actions: ModelPickerAction[] };
  onEntryDetails?: (entry: ModelPickerEntry) => void;
  providersStartCollapsed?: boolean;
  showKeyboardHints?: boolean;
  searchAction?: { label: string; icon: IconName; onSelect: () => void } | null;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
  includeNotSelected?: boolean;
  onSelectNone?: () => void;
  selectionCount?: (entry: ModelPickerEntry) => number;
  disabled?: boolean;
  maxHeightClassName?: string;
  maxHeightStyle?: React.CSSProperties;
  sectionHeaderClassName?: string;
  sheetCaptions?: boolean;
  rowClassName?: string;
  stickyHeaders?: boolean;
  autoFocus?: boolean;
  onEscape?: () => void;
  isFavorite?: (entry: ModelPickerEntry) => boolean;
  onToggleFavorite?: (entry: ModelPickerEntry) => void;
  renderRowEnd?: (entry: ModelPickerEntry, state: { isHighlighted: boolean; isSelected: boolean }) => React.ReactNode;
  onActiveKeyDown?: (event: React.KeyboardEvent, entry: ModelPickerEntry | undefined) => void;
  onActiveEntryChange?: (entry: ModelPickerEntry | undefined) => void;
  onVariantKey?: (event: React.KeyboardEvent, entry: ModelPickerEntry) => boolean;
  onReorderFavorite?: (active: ModelPickerEntry, over: ModelPickerEntry) => void;
  providerOrder?: string[];
  onReorderProvider?: (orderedProviderIDs: string[]) => void;
  reorderProviderTitle?: string;
  footerContent?: React.ReactNode | ((activeEntry: ModelPickerEntry | undefined) => React.ReactNode);
  renderVersion?: number;
  tooltipsEnabled?: boolean;
}
