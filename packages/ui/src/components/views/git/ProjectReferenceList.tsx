import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ReferenceBrowserList, ReferenceBrowserSearch } from '@/components/references/ReferenceBrowser';
import type { ReferencePickerItem } from '@/components/references/referencePickerItems';
import type { ReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { useProjectReferenceListPosition } from '@/hooks/useProjectReferenceListPosition';
import type { RepositoryChangeRequestReference } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';
import { cn } from '@/lib/utils';

export const ProjectReferenceBackButton: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t } = useI18n();
  return (
    <div className="shrink-0 border-b border-border/60 px-4 py-2">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <Icon name="arrow-left" className="size-4" />
        {t('gitView.pullRequest.backToList')}
      </Button>
    </div>
  );
};

export const ProjectReferenceList: React.FC<{
  browser: ReferenceBrowser;
  stateOwner: string | null;
  showingList: boolean;
  label: string;
  refreshLabel: string;
  refreshEnabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenItem: (item: ReferencePickerItem) => void;
  renderPullFileStats?: (pull: RepositoryChangeRequestReference) => React.ReactNode;
  renderPullAction?: (pull: RepositoryChangeRequestReference, rememberScroll: () => void) => React.ReactNode;
}> = ({ browser, stateOwner, showingList, label, refreshLabel, refreshEnabled, refreshing, onRefresh, onOpenItem, renderPullFileStats, renderPullAction }) => {
  const { t } = useI18n();
  const { isMobile } = browser;
  const openSettings = useOpenSourceControlSettings();
  const { people } = browser.repositoryFilter;
  const { scrollRef, selectListFilter, rememberScroll, onScroll } = useProjectReferenceListPosition(browser, stateOwner, showingList);
  const stateTriggerRef = React.useRef<HTMLButtonElement>(null);
  useWidthMorph(stateTriggerRef);
  const stateValueId = React.useId();
  const searching = Boolean(browser.debouncedQuery.trim()) || people !== 'any';
  const openRow = (item: ReferencePickerItem) => {
    rememberScroll();
    onOpenItem(item);
  };

  return (
    <div hidden={!showingList} className={showingList ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <div className="shrink-0 border-b border-border/60 px-4 py-2">
        <SortableTabsStrip
          items={[
            { id: 'mine', label: t('references.projectPulls.group.mine') },
            { id: 'any', label: t('references.projectPulls.group.all') },
          ]}
          activeId={people}
          onSelect={id => {
            if (id === 'mine' || id === 'any') selectListFilter(id, id === 'mine' ? 'open' : browser.projectAllState);
          }}
          variant="active-pill"
          layoutMode="fit"
          intrinsicWidth
        />
      </div>
      <div className="shrink-0 border-b border-border/60 px-4 py-2">
        <ReferenceBrowserSearch
          browser={browser}
          onKeyDown={(event) => {
            if (isIMECompositionEvent(event) || browser.handleNavigationKey(event)) return;
            if (event.key === 'Enter' && browser.highlightedItem) {
              event.preventDefault();
              openRow(browser.highlightedItem);
            }
          }}
          trailing={<>
            {people === 'any' ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  ref={stateTriggerRef}
                  className={cn(dropdownTriggerVariants({ size: isMobile ? 'touch' : 'default' }), 'max-w-36 shrink-0')}
                  aria-label={t('references.picker.filter.group.status')}
                  aria-describedby={stateValueId}
                >
                  <span id={stateValueId} className="truncate">
                    {t(browser.projectAllState === 'closed' ? 'references.picker.state.closed' : 'references.picker.state.open')}
                  </span>
                  <Icon name="arrow-down-s" className="size-4 opacity-50" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup value={browser.projectAllState} onValueChange={value => {
                    if (value === 'open' || value === 'closed') selectListFilter('any', value);
                  }}>
                    <DropdownMenuRadioItem value="open" closeOnClick>{t('references.picker.state.open')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="closed" closeOnClick>{t('references.picker.state.closed')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button size="sm" variant="ghost" disabled={refreshing || !refreshEnabled} onClick={onRefresh} aria-label={refreshLabel} title={refreshLabel}>
              <Icon name="refresh" className={`size-4${refreshing || browser.list.refreshing ? ' animate-spin' : ''}`} />
            </Button>
          </>}
        />
      </div>
      {searching && (browser.list.total ?? 0) > 1_000 ? (
        <p className="px-4 py-2 typography-meta text-muted-foreground">{t('gitView.pullRequest.searchLimit', { count: 1_000 })}</p>
      ) : null}
      <ScrollableOverlay
        ref={scrollRef}
        outerClassName="min-h-0 flex-1"
        disableHorizontal
        useScrollShadow
        onScroll={onScroll}
      >
        {showingList ? (
          <ReferenceBrowserList
            browser={browser}
            label={label}
            multiselectable={false}
            onOpenSettings={openSettings}
            onSelectItem={openRow}
            renderPullFileStats={renderPullFileStats}
            renderPullAction={renderPullAction ? pull => renderPullAction(pull, rememberScroll) : undefined}
          />
        ) : null}
      </ScrollableOverlay>
    </div>
  );
};
