import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ConciseToolResult } from './conciseToolRow';
import { MinDurationShineText } from './MinDurationShineText';

const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const NAME_CLASS = cn('typography-meta font-medium', ROW_TEXT_CLASS);
const DETAIL_CLASS = cn('typography-meta', ROW_TEXT_CLASS);
// The result line hugs the call it belongs to.
const RESULT_CLASS = 'typography-meta !text-[length:var(--text-meta)] !leading-5 tracking-normal';

export type ConciseToolStatus = 'running' | 'completed' | 'failed' | 'stopped';

// Claude Code's dot: green once a call succeeds, red when it fails, dim while it runs.
const DOT_COLOR = {
    running: 'var(--tools-icon)',
    completed: 'var(--status-success)',
    failed: 'var(--status-error)',
    stopped: 'var(--tools-icon)',
} satisfies Record<ConciseToolStatus, string>;

type Expansion = {
    isExpanded: boolean;
    /** Folds the details open or shut. */
    onToggle: () => void;
    /** A click on the row. Tools with a file may open it instead of folding. */
    onActivate: (event: React.SyntheticEvent) => void;
};

type ConciseToolHeaderProps = {
    name: string;
    /** What the call worked on, shown in parentheses after the name. */
    argument: React.ReactNode;
    argumentTitle?: string;
    status: ConciseToolStatus;
    result: ConciseToolResult | null;
    /** Elapsed time for a result of kind `running`. */
    timer?: React.ReactNode;
    /** Absent for a call with no details to fold open. */
    expansion?: Expansion;
    /** Buttons after the argument, such as opening the file. */
    actions?: React.ReactNode;
};

const ResultText: React.FC<{ result: ConciseToolResult; timer?: React.ReactNode }> = ({ result, timer }) => {
    const { t } = useI18n();
    switch (result.kind) {
        case 'error':
            return <span style={{ color: 'var(--status-error)' }}>{result.text}</span>;
        case 'running':
            return <span className="tabular-nums">{timer}</span>;
        case 'diff':
            return (
                <span className="inline-flex gap-1.5 tabular-nums">
                    {result.added > 0 ? <span style={{ color: 'var(--status-success)' }}>+{result.added}</span> : null}
                    {result.removed > 0 ? <span style={{ color: 'var(--status-error)' }}>-{result.removed}</span> : null}
                </span>
            );
        case 'added':
            return <span className="tabular-nums" style={{ color: 'var(--status-success)' }}>+{result.lines}</span>;
        case 'toolCalls':
            return <>{result.count === 1 ? t('chat.toolPart.concise.toolCallsOne') : t('chat.toolPart.concise.toolCallsMany', { count: result.count })}</>;
        case 'lines':
            return <>{result.count === 1 ? t('chat.toolPart.concise.outputLinesOne') : t('chat.toolPart.concise.outputLinesMany', { count: result.count })}</>;
        case 'noOutput':
            return <>{t('chat.toolPart.noOutputProduced')}</>;
    }
};

/**
 * One tool call the way the Claude Code terminal prints it: `● Name(argument)`,
 * and under it a single line saying what came back. The details stay folded.
 */
export const ConciseToolHeader: React.FC<ConciseToolHeaderProps> = ({
    name,
    argument,
    argumentTitle,
    status,
    result,
    timer,
    expansion,
    actions,
}) => {
    const isExpanded = expansion?.isExpanded ?? false;
    const running = status === 'running';
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        // Buttons inside the row handle their own keys.
        if (!expansion || event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        expansion.onActivate(event);
    };

    return (
        <div
            className={cn('group/tool flex min-w-0 flex-col pr-2 pl-px py-0.5 rounded-xl', expansion && 'cursor-pointer')}
            role={expansion ? 'button' : undefined}
            tabIndex={expansion ? 0 : undefined}
            aria-expanded={expansion ? isExpanded : undefined}
            onClick={expansion?.onActivate}
            onKeyDown={expansion ? handleKeyDown : undefined}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <span
                    className="relative flex h-5 w-3.5 flex-shrink-0 items-center justify-center"
                    onClick={expansion ? (event) => { event.stopPropagation(); expansion.onToggle(); } : undefined}
                >
                    <span
                        aria-hidden="true"
                        className={cn(
                            'h-2 w-2 rounded-full transition-opacity',
                            running && 'animate-pulse',
                            expansion && (isExpanded ? 'opacity-0' : 'group-hover/tool:opacity-0'),
                        )}
                        style={{ backgroundColor: DOT_COLOR[status] }}
                    />
                    {expansion ? (
                        <Icon
                            name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                            className={cn(
                                'absolute h-3.5 w-3.5 transition-opacity',
                                isExpanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                            )}
                        />
                    ) : null}
                </span>
                {/* Name and argument touch, as in `Bash(ls -la)`. */}
                <span className="flex min-w-0 items-center">
                    <MinDurationShineText
                        active={running}
                        minDurationMs={300}
                        className={cn(NAME_CLASS, 'flex-shrink-0')}
                        style={{ color: status === 'failed' ? 'var(--status-error)' : 'var(--tools-title)' }}
                        title={name}
                    >
                        {name}
                    </MinDurationShineText>
                    {argument ? (
                        <span
                            className={cn('min-w-0 truncate', DETAIL_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={argumentTitle}
                        >
                            ({argument})
                        </span>
                    ) : null}
                </span>
                {actions}
            </div>
            {result ? (
                <div className={cn('flex min-w-0 items-center gap-1.5 pl-5', RESULT_CLASS)} style={{ color: 'var(--tools-description)' }}>
                    <span
                        aria-hidden="true"
                        className="h-2 w-2 flex-shrink-0 -translate-y-[3px] border-b border-l opacity-60"
                        style={{ borderColor: 'var(--tools-description)' }}
                    />
                    <span className="min-w-0 truncate">
                        <ResultText result={result} timer={timer} />
                    </span>
                </div>
            ) : null}
        </div>
    );
};
