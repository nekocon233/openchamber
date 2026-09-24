import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { CompactionKind } from '../lib/messageDisplayNormalization';

/**
 * Where the conversation was compacted: a divider in the conversation, the way
 * the CLI marks it, rather than a `/compact` message the user never sent. The
 * CLI or OpenCode compacts on its own when the context fills (`auto`).
 */
export const CompactionMarker: React.FC<{ kind: CompactionKind }> = ({ kind }) => {
    const { t } = useI18n();
    const label = kind === 'auto' ? t('chat.compaction.auto') : t('chat.compaction.manual');
    return (
        <div className="flex items-center gap-3 py-1" role="separator" aria-label={label}>
            <span aria-hidden="true" className="h-px flex-1 bg-[var(--interactive-border)]" />
            <span className="flex shrink-0 items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="contract-up-down" className="h-3.5 w-3.5" />
                {label}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-[var(--interactive-border)]" />
        </div>
    );
};

/**
 * The summary a compaction left for the conversation to continue from. It is
 * for the model, so it stays folded until the user opens it.
 */
export const CompactionSummary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const contentId = React.useId();
    return (
        <div>
            <button
                type="button"
                className="flex items-center gap-1 rounded-md py-0.5 pr-1.5 typography-meta text-muted-foreground hover:text-foreground"
                aria-expanded={open}
                aria-controls={contentId}
                onClick={() => setOpen((value) => !value)}
            >
                <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
                {t('chat.compaction.summary')}
            </button>
            <div id={contentId} hidden={!open}>
                {open ? children : null}
            </div>
        </div>
    );
};
