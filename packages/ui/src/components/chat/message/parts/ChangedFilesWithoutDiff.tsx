import React from 'react';

import { useI18n } from '@/lib/i18n';
import type { RecordedFileChanges } from '@/lib/opencode/tools';
import { cn } from '@/lib/utils';

/**
 * The files a command changed that its CLI kept no diff for, under the
 * command: named where the CLI named them, counted where it only counted.
 */
export const ChangedFilesWithoutDiff: React.FC<{
    changes: RecordedFileChanges;
    /** `changes.withoutDiff` as the row shows them, relative to the session directory. */
    paths: string[];
    /** How many names show before the rest are counted; all of them when unset. */
    limit?: number;
    className?: string;
}> = ({ changes, paths, limit, className }) => {
    const { t } = useI18n();
    const listed = paths.length > 0 || changes.unnamed > 0;
    if (!listed && !changes.shared) return null;

    const shown = limit === undefined ? paths : paths.slice(0, limit);
    const counted = paths.length - shown.length + changes.unnamed;
    const heading = changes.unavailable
        ? t('chat.toolPart.recordedChanges.unavailableHeading')
        : changes.hasDiffs
            ? t('chat.toolPart.recordedChanges.moreNoDiffHeading')
            : t('chat.toolPart.recordedChanges.noDiffHeading');

    return (
        <div className={cn('typography-meta', className)} style={{ color: 'var(--tools-description)' }}>
            {listed ? (
                <>
                    <div>{heading}</div>
                    {shown.map((path) => (
                        <div key={path} className="truncate pl-3" title={path}>{path}</div>
                    ))}
                    {counted > 0 ? (
                        <div className="pl-3">
                            {counted === 1
                                ? t('chat.toolPart.recordedChanges.moreFilesOne')
                                : t('chat.toolPart.recordedChanges.moreFilesMany', { count: counted })}
                        </div>
                    ) : null}
                </>
            ) : null}
            {changes.shared ? <div>{t('chat.toolPart.recordedChanges.sharedNote')}</div> : null}
        </div>
    );
};
