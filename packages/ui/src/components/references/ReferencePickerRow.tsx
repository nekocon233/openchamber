import * as React from 'react';
import type { CachedValue } from './referenceCache';

import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import type { CISummary, Label, ChangeRequestListStatus, RepositoryDiscussionReference, TrackerLabel, TrackerProgress } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { trackerStateGlyph } from '@/lib/trackers/stateLook';
import { cn } from '@/lib/utils';

import {
    hasRepositoryPullConflict,
    repositoryStateLook,
    labelColor,
    REFERENCE_META_TEXT,
    relativeTimeOf,
    type ReferencePickerItem,
    referenceNumberLabel,
    TRACKER_PRIORITY_KEYS,
} from './referencePickerItems';
import { joinProjectPath } from '@/lib/source-control/projectPath';

type ChipLabel = { name: string; color: string | null };

const toLabels = (labels: ReadonlyArray<Label | TrackerLabel> | undefined): ChipLabel[] => (
    (labels ?? []).map((label) => ({ name: label.name, color: labelColor(label.color) }))
);

const rowAvatarUrl = (url: string): string => {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'avatars.githubusercontent.com') return url;
        parsed.searchParams.set('s', '32');
        return parsed.toString();
    } catch {
        return url;
    }
};

const RowPerson: React.FC<{ name: string; avatarUrl: string | null | undefined }> = ({ name, avatarUrl }) => {
    const { broken, onError } = useAvatarImage(avatarUrl);
    return (
        <span className="inline-flex min-w-0 items-center gap-1">
            {avatarUrl && !broken ? (
                <img src={rowAvatarUrl(avatarUrl)} alt="" loading="lazy" className="size-4 shrink-0 rounded-full bg-surface-muted" onError={onError} />
            ) : (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[0.625rem] leading-none">
                    {name.slice(0, 1).toUpperCase()}
                </span>
            )}
            <span className="truncate">{name}</span>
        </span>
    );
};

export const ReferenceLabelChips: React.FC<{ labels: ChipLabel[]; max?: number }> = ({ labels, max }) => {
    if (labels.length === 0) return null;
    const shown = max === undefined ? labels : labels.slice(0, max);
    const hidden = labels.length - shown.length;
    return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
            {shown.map((label) => (
                <span
                    key={label.name}
                    className={cn('max-w-[9rem] truncate typography-micro', REFERENCE_META_TEXT)}
                >
                    {}
                    <span
                        className="me-1 inline-block size-1.5 rounded-full align-middle"
                        style={{ backgroundColor: label.color ?? 'var(--surface-muted-foreground)' }}
                    />
                    {label.name}
                </span>
            ))}
            {hidden > 0 ? <span className={cn('typography-micro', REFERENCE_META_TEXT)}>+{hidden}</span> : null}
        </span>
    );
};

const SubIssueCount: React.FC<{ progress: TrackerProgress }> = ({ progress }) => {
    const { t } = useI18n();
    const label = progress.more
        ? t('references.picker.tracker.childrenMany', { count: progress.total })
        : t('references.picker.tracker.childrenDone', { done: progress.done, total: progress.total });
    return (
        <span className="inline-flex items-center gap-0.5 tabular-nums" title={label} aria-label={label}>
            <Icon name="node-tree" className="size-3.5" />
            {progress.more ? `${progress.total}+` : `${progress.done}/${progress.total}`}
        </span>
    );
};

export const DiscussionCategory: React.FC<{ category: RepositoryDiscussionReference['category'] }> = ({ category }) => (
    <span className="inline-flex min-w-0 max-w-[12rem] items-center gap-1">
        {category.emoji ? <span aria-hidden className="shrink-0">{category.emoji}</span> : null}
        <span className="truncate">{category.name}</span>
    </span>
);

export const ChecksGlyph: React.FC<{ checks: CISummary | null }> = ({ checks }) => {
    if (!checks || checks.total === 0) return null;
    if (checks.state === 'failure') return <Icon name="close-circle" className="size-3.5 text-[var(--status-error)]" />;
    if (checks.state === 'pending') return <Icon name="time" className="size-3.5 text-[var(--status-warning)]" />;
    if (checks.state === 'success') return <Icon name="checkbox-circle" className="size-3.5 text-[var(--status-success)]" />;
    return null;
};

const PullChecks: React.FC<{ status: CachedValue<ChangeRequestListStatus | null> }> = ({ status }) => {
    const { t } = useI18n();
    let icon: React.ComponentProps<typeof Icon>['name'] = 'question';
    let tone = REFERENCE_META_TEXT;
    let label: string;
    if (status.status === 'idle' || status.status === 'loading') {
        icon = 'time';
        label = t('references.picker.row.checks.loading');
    } else if (status.status === 'error') {
        icon = 'error-warning';
        label = t('references.picker.row.checks.loadFailed');
    } else {
        const checks = status.value?.checks;
        if (!checks) {
            label = t('references.picker.row.checks.unavailable');
        } else if (checks.total === 0) {
            icon = 'subtract';
            label = t('references.picker.row.checks.empty');
        } else if (checks.state === 'success') {
            icon = 'checkbox-circle';
            tone = 'text-[var(--status-success)]';
            label = t('references.picker.row.checks.passed', { count: checks.success, total: checks.total });
        } else if (checks.state === 'failure') {
            icon = 'close-circle';
            tone = 'text-[var(--status-error)]';
            label = t('references.picker.row.checks.failed', { count: checks.failure, total: checks.total });
        } else if (checks.state === 'pending') {
            icon = 'time';
            tone = 'text-[var(--status-warning)]';
            label = t(checks.queued === checks.pending ? 'references.picker.row.checks.queued' : 'references.picker.row.checks.pending', { count: checks.pending, total: checks.total });
        } else {
            label = t('references.picker.row.checks.unknown');
        }
    }
    return (
        <div className={cn('mt-1 flex min-w-0 items-center gap-1 typography-micro tabular-nums', tone)}>
            <Icon name={icon} className="size-3.5 shrink-0" />
            <span className="break-words">{label}</span>
        </div>
    );
};

type RowProps = {
    item: ReferencePickerItem;
    pullStatus: ChangeRequestListStatus | null;
    pullStatusRead?: CachedValue<ChangeRequestListStatus | null> | null;
    showChecks?: boolean;
    pullFileStats?: React.ReactNode;
    highlighted: boolean;
    checked: boolean | null;
    diffIncluded: boolean;
    showRepository?: boolean;
    now: number;
    onHighlight: () => void;
    onToggle: () => void;
    onActivate: () => void;
};

export const ReferencePickerRow = React.memo(function ReferencePickerRow({
    item,
    pullStatus,
    pullStatusRead,
    showChecks = false,
    pullFileStats,
    highlighted,
    checked,
    diffIncluded,
    showRepository = false,
    now,
    onHighlight,
    onToggle,
    onActivate,
}: RowProps) {
    const { t } = useI18n();
    const descriptor = useSourceControlProvider(item.source === 'repository' ? item.reference.provider : null);
    const tracker = item.source === 'tracker' ? item.item : null;
    const { capabilities } = useTrackerDescriptor(item.source === 'tracker' ? item.provider : null);
    const look = item.source === 'repository' ? repositoryStateLook(item.reference, pullStatus) : trackerStateGlyph(item.item.state?.category);
    const conflict = showChecks && item.source === 'repository' && hasRepositoryPullConflict(item.reference, pullStatus);
    const title = item.source === 'repository' ? item.reference.title : item.item.title;
    const id = item.source === 'repository' ? referenceNumberLabel(item.reference, descriptor) : item.item.identifier;
    const updated = relativeTimeOf(item.source === 'repository' ? item.reference.updatedAt : item.item.updatedAt, now);
    const labels = toLabels(item.source === 'repository' ? item.reference.labels : (capabilities.labels ? item.item.labels : undefined));
    const rowRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (highlighted) rowRef.current?.scrollIntoView({ block: 'nearest' });
    }, [highlighted]);

    return (
        <div
            ref={rowRef}
            role="option"
            aria-selected={highlighted}
            className={cn(
                'group flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors',
                highlighted ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
            )}
            onClick={onHighlight}
            onDoubleClick={onActivate}
        >
            {checked !== null ? (
                <span className="flex h-5 items-center" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                    <Checkbox checked={checked} onChange={onToggle} ariaLabel={t('references.picker.row.selectAria', { id })} />
                </span>
            ) : null}
            <Icon name={look.icon} className="mt-0.5 size-4 shrink-0" style={{ color: look.color }} />
            <div className="min-w-0 flex-1">
                {tracker?.parent && capabilities.children ? (
                    <div className={cn('mb-0.5 flex min-w-0 items-center gap-1 typography-micro', REFERENCE_META_TEXT)}>
                        <Icon name="corner-down-right" className="size-3.5 shrink-0" />
                        <span className="shrink-0 font-mono">{tracker.parent.identifier}</span>
                        <span dir="auto" className="truncate">{tracker.parent.title}</span>
                    </div>
                ) : null}
                <div dir="auto" className={cn('typography-ui-header font-semibold line-clamp-2 break-words', !highlighted && 'text-foreground')}>{title}</div>
                <div className={cn('mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 typography-micro', REFERENCE_META_TEXT)}>
                    <span className="font-mono">{id}</span>
                    {item.source === 'repository' && item.reference.author ? (
                        <RowPerson name={item.reference.author.login} avatarUrl={item.reference.author.avatarUrl} />
                    ) : null}
                    {tracker?.assignee ? (
                        <RowPerson name={tracker.assignee.name || '—'} avatarUrl={tracker.assignee.avatarUrl} />
                    ) : null}
                    {updated ? (
                        <span>{updated.key === 'common.relative.justNow' ? t(updated.key) : t(updated.key, { count: updated.count })}</span>
                    ) : null}
                    {item.source === 'repository' && item.reference.commentCount > 0 ? (
                        <span className="inline-flex items-center gap-0.5">
                            <Icon name="chat-1" className="size-3.5" />
                            {item.reference.commentCount}
                        </span>
                    ) : null}
                    {item.source === 'repository' && item.reference.kind === 'discussion' ? (
                        <>
                            {item.reference.upvotes > 0 ? (
                                <span className="inline-flex items-center gap-0.5" title={t('references.picker.discussion.upvotesTitle', { count: item.reference.upvotes })}>
                                    <Icon name="arrow-up" className="size-3.5" />
                                    {item.reference.upvotes}
                                </span>
                            ) : null}
                            <DiscussionCategory category={item.reference.category} />
                        </>
                    ) : null}
                    {item.source === 'repository' && item.reference.kind === 'pull' && diffIncluded ? (
                        <span className="inline-flex items-center gap-0.5" title={t('references.picker.preview.includeDiff')}>
                            <Icon name="file-code" className="size-3.5" />
                        </span>
                    ) : null}
                    {tracker?.progress && capabilities.children ? (
                        <SubIssueCount progress={tracker.progress} />
                    ) : null}
                    {tracker?.priority && tracker.priority !== 'none' && capabilities.priority ? (
                        <span>{t(TRACKER_PRIORITY_KEYS[tracker.priority])}</span>
                    ) : null}
                    {item.source === 'repository' && (showRepository || item.reference.sourceRepo.source === 'upstream') ? (
                        <span className="rounded bg-[var(--status-info-background)] px-1 typography-micro text-[var(--status-info-text)]">
                            {joinProjectPath(item.reference.sourceRepo.owner, item.reference.sourceRepo.repo)}
                        </span>
                    ) : null}
                    {labels.length > 0 ? (
                        <ReferenceLabelChips labels={labels} max={2} />
                    ) : null}
                </div>
                {pullFileStats}
                {conflict ? <div className="mt-1 flex items-center gap-1 typography-micro text-[var(--status-warning-text)]">
                    <Icon name="error-warning" className="size-3.5 shrink-0" />
                    {t('sessions.sidebar.group.pr.status.mergeConflicts')}
                </div> : null}
                {showChecks && pullStatusRead ? <PullChecks status={pullStatusRead} /> : null}
            </div>
        </div>
    );
});
