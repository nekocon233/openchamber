import React from 'react';

import { useI18n } from '@/lib/i18n';
import { parseConciseDiffRows, type ConciseDiffRow } from './conciseDiffRows';

// Rows shown before the rest folds away: enough for a typical edit.
const FOLDED_ROW_LIMIT = 16;

const ROW_BACKGROUND = {
    added: 'var(--tools-edit-added-bg)',
    removed: 'var(--tools-edit-removed-bg)',
    context: undefined,
} satisfies Record<'added' | 'removed' | 'context', string | undefined>;

const SIGN = { added: '+', removed: '-', context: ' ' } satisfies Record<'added' | 'removed' | 'context', string>;

const SIGN_COLOR = {
    added: 'var(--status-success)',
    removed: 'var(--status-error)',
    context: 'var(--tools-edit-line-number)',
} satisfies Record<'added' | 'removed' | 'context', string>;

export type ConciseDiffFile = { id: string; title: string; patch: string };

const DiffRow: React.FC<{ row: ConciseDiffRow }> = ({ row }) => {
    if (row.kind === 'gap') {
        return <div aria-hidden="true" className="px-2 leading-5" style={{ color: 'var(--tools-edit-line-number)' }}>⋯</div>;
    }
    return (
        <div className="flex min-w-0 leading-5" style={{ backgroundColor: ROW_BACKGROUND[row.kind] }}>
            <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums" style={{ color: 'var(--tools-edit-line-number)' }}>
                {row.line}
            </span>
            <span className="w-3 shrink-0 select-none" style={{ color: SIGN_COLOR[row.kind] }}>{SIGN[row.kind]}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2">{row.text}</span>
        </div>
    );
};

/**
 * What a file change did, under its call in the concise transcript: the
 * changed lines on green and red, folded after a screenful.
 */
export const ConciseDiff: React.FC<{ files: ConciseDiffFile[] }> = ({ files }) => {
    const { t } = useI18n();
    const [unfolded, setUnfolded] = React.useState(false);
    const parsed = React.useMemo(
        () => files.map((file) => ({ ...file, rows: parseConciseDiffRows(file.patch) })).filter((file) => file.rows.length > 0),
        [files],
    );
    const totalRows = parsed.reduce((sum, file) => sum + file.rows.length, 0);
    if (totalRows === 0) return null;

    let remaining = unfolded ? totalRows : FOLDED_ROW_LIMIT;
    const shown = parsed.map((file) => {
        const rows = file.rows.slice(0, Math.max(0, remaining));
        remaining -= rows.length;
        return { ...file, rows };
    }).filter((file) => file.rows.length > 0);
    const hiddenRows = totalRows - shown.reduce((sum, file) => sum + file.rows.length, 0);
    const namesFiles = parsed.length > 1;

    return (
        <div
            className="mt-0.5 mb-1 ml-5 overflow-hidden rounded-md typography-code !text-[length:var(--text-meta)]"
            style={{ backgroundColor: 'var(--syntax-background)', color: 'var(--syntax-foreground)' }}
        >
            {shown.map((file) => (
                <div key={file.id}>
                    {namesFiles ? (
                        <div className="truncate px-2 pt-1 typography-meta" style={{ color: 'var(--tools-description)' }}>{file.title}</div>
                    ) : null}
                    {file.rows.map((row, index) => <DiffRow key={index} row={row} />)}
                </div>
            ))}
            {hiddenRows > 0 || unfolded ? (
                <button
                    type="button"
                    className="w-full px-2 py-0.5 text-left typography-meta hover:bg-interactive-hover"
                    style={{ color: 'var(--tools-description)' }}
                    onClick={(event) => {
                        event.stopPropagation();
                        setUnfolded((value) => !value);
                    }}
                >
                    {hiddenRows > 0
                        ? (hiddenRows === 1 ? t('chat.toolPart.concise.moreLinesOne') : t('chat.toolPart.concise.moreLinesMany', { count: hiddenRows }))
                        : t('chat.toolPart.concise.fewerLines')}
                </button>
            ) : null}
        </div>
    );
};
