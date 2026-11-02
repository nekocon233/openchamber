import React from 'react';
import { ModelPickerList } from '@/components/model-picker/ModelPickerList';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useI18n } from '@/lib/i18n';
import type { PlanExecutionModelState } from './usePlanExecutionModel';

type Props = { selection: PlanExecutionModelState; disabled: boolean; rootRef?: React.Ref<HTMLDivElement> };

const ActivePlanExecutionModelPicker = ({ selection, disabled, rootRef }: Props) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const labelId = React.useId();
  const valueId = React.useId();
  const { favoriteModelsList, recentModelsList } = useModelLists();
  const hidden = useUIStore((state) => state.hiddenModels);
  return <div ref={rootRef} className="space-y-1 px-3 pb-2" data-plan-execution-model>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span id={labelId} className="typography-meta text-muted-foreground">{t('chat.planExecution.model')}</span>
      <DropdownMenu disableGlobalShortcuts open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className={dropdownTriggerVariants()} disabled={disabled || selection.pending || selection.blocked}
            aria-labelledby={`${labelId} ${valueId}`}>
            {selection.value ? <ProviderLogo providerId={selection.value.model.providerID} className="size-3.5" /> : null}
            <span id={valueId} className="max-w-[14rem] truncate" dir="auto">{selection.model?.name ?? selection.value?.model.modelID ?? t('chat.planExecution.model')}</span>
            <Icon name="arrow-down-s" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0" onKeyDown={(event) => event.stopPropagation()}>
          <ModelPickerList providers={selection.providers} favoriteModels={favoriteModelsList} recentModels={recentModelsList}
            allowedProviderIds={selection.providers.map((provider) => provider.id)} hiddenModels={hidden}
            selectedModel={selection.value ? { providerID: selection.value.model.providerID, modelID: selection.model?.id ?? selection.value.model.modelID } : null}
            searchQuery={query} onSearchQueryChange={setQuery}
            onSelect={(entry) => { selection.choose(entry.providerID, entry.modelID); setOpen(false); setQuery(''); }}
            labels={{ searchPlaceholder: t('multirun.modelMultiSelect.search.placeholder'), noResults: t('multirun.modelMultiSelect.search.noResults'), favorites: t('multirun.modelMultiSelect.sections.favorites'), recent: t('multirun.modelMultiSelect.sections.recent'), keyboardHint: t('multirun.modelMultiSelect.keyboard.hint') }}
            maxHeightClassName="max-h-72" autoFocus onEscape={() => setOpen(false)} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {selection.blocked ? <p className="typography-micro text-muted-foreground">{t('chat.unified.enterprise')}</p>
      : selection.pending ? <p className="typography-micro text-muted-foreground">{t('chat.unified.unconfirmed')}</p>
      : !selection.available ? <p className="typography-micro text-[var(--status-error)]">{t('chat.unified.modelUnavailable')}</p> : null}
  </div>;
};

export const PlanExecutionModelPicker = (props: Props) => props.selection.enabled ? <ActivePlanExecutionModelPicker {...props} /> : null;
