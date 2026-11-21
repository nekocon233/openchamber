import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChangeRequestRevision, ChangeRequestRevisionKind } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { REFERENCE_META_TEXT } from './referencePickerItems';
import type { RevisionChoice } from './ReferencePreview';

const REVISION_KIND_KEYS = {
    rework: 'references.picker.preview.revision.kind.rework',
    'trivial-rebase': 'references.picker.preview.revision.kind.trivialRebase',
    'merge-first-parent-update': 'references.picker.preview.revision.kind.mergeUpdate',
    'no-code-change': 'references.picker.preview.revision.kind.noCodeChange',
    'no-change': 'references.picker.preview.revision.kind.noChange',
} as const satisfies Record<ChangeRequestRevisionKind, I18nKey>;

export const RevisionPicker: React.FC<{ choice: RevisionChoice }> = ({ choice }) => {
    const { t } = useI18n();
    const latest = choice.revisions.at(-1);
    if (!latest || choice.revisions.length < 2) return null;
    const shown = choice.revisions.find((revision) => revision.sha === choice.selected) ?? latest;
    const labelOf = (revision: ChangeRequestRevision) => (revision === latest
        ? t('references.picker.preview.revision.latest', { number: revision.number })
        : t('references.picker.preview.revision.number', { number: revision.number }));
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={cn(dropdownTriggerVariants(), 'min-w-0 max-w-[14rem] font-normal')}
                            aria-label={t('references.picker.preview.revision.label')}
                        >
                            <span className="truncate">{labelOf(shown)}</span>
                            <Icon name="arrow-down-s" className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.choosePatchset')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuRadioGroup
                    value={shown.sha}
                    onValueChange={(value) => choice.onSelect(value === latest.sha ? null : String(value))}
                >
                    {[...choice.revisions].reverse().map((revision) => (
                        <DropdownMenuRadioItem key={revision.sha} value={revision.sha}>
                            <span className="min-w-0 flex-1 truncate">{labelOf(revision)}</span>
                            {revision.kind && revision.kind !== 'rework' ? (
                                <span className={cn('shrink-0 typography-meta', REFERENCE_META_TEXT)}>{t(REVISION_KIND_KEYS[revision.kind])}</span>
                            ) : null}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
