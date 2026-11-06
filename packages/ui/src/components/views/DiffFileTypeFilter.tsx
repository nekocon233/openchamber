import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { DiffFileTypeOption } from '@/lib/diff/fileTypeFilter';

interface DiffFileTypeFilterProps {
  options: DiffFileTypeOption[];
  excludedTypes: readonly string[];
  hiddenCount: number;
  onChange: (types: readonly string[]) => void;
  mobile?: boolean;
}

export const DiffFileTypeFilter = ({ options, excludedTypes, hiddenCount, onChange, mobile = false }: DiffFileTypeFilterProps) => {
  const { t } = useI18n();
  if (options.length === 0) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" className={dropdownTriggerVariants({ size: mobile ? 'mobile' : 'default' })}
        aria-label={t('diffFilter.label')} title={hiddenCount ? t('diffFilter.hiddenCount', { count: hiddenCount }) : t('diffFilter.label')}
        data-diff-file-filter="">
        <Icon name="filter-3" className="size-4" />
        {excludedTypes.length > 0 && <span className="typography-micro tabular-nums">{hiddenCount}</span>}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-44 max-w-[calc(100vw-24px)]">
      <DropdownMenuLabel>{t('diffFilter.hideTypes')}</DropdownMenuLabel>
      {hiddenCount > 0 && <DropdownMenuLabel>{t('diffFilter.hiddenCount', { count: hiddenCount })}</DropdownMenuLabel>}
      {options.map(({ type, count }) => {
        const excluded = excludedTypes.includes(type);
        return <DropdownMenuItem key={type} closeOnClick={false} role="menuitemcheckbox" aria-checked={excluded}
          onSelect={() => onChange(excluded ? excludedTypes.filter((value) => value !== type) : [...excludedTypes, type])}>
          <span className="flex size-4 shrink-0 items-center justify-center">{excluded && <Icon name="check" className="size-3" />}</span>
          <span className="min-w-0 flex-1 truncate" dir={type ? 'ltr' : undefined}>{type ? `.${type}` : t('diffFilter.noExtension')}</span>
          <span className="typography-micro tabular-nums text-muted-foreground">{count}</span>
        </DropdownMenuItem>;
      })}
      {excludedTypes.length > 0 && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange([])}>{t('diffFilter.restoreAll')}</DropdownMenuItem>
      </>}
    </DropdownMenuContent>
  </DropdownMenu>;
};

export const DiffFileFilterEmpty = ({ onRestore }: { onRestore: () => void }) => {
  const { t } = useI18n();
  return <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-4 text-center" data-diff-filter-empty="">
    <p className="typography-ui-label text-muted-foreground">{t('diffFilter.allHidden')}</p>
    <Button variant="outline" size="sm" onClick={onRestore}>{t('diffFilter.restoreAll')}</Button>
  </div>;
};
