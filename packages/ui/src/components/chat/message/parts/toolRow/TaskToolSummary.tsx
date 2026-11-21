import { type TaskToolSummaryEntry, prepareTaskToolOutput } from "../taskToolModel";
import { toolDescription, isNavigationTool, isFileChangeTool, normalizeToolName } from "@/lib/opencode/tools";
import React from "react";
import { useI18n } from "@/lib/i18n";
import { getToolDisplayName, getToolIcon } from "../toolPresentation";
import { ToolRevealOnMount } from "../ToolRevealOnMount";
import { cn } from "@/lib/utils";
import { renderAnimatedPathWithIcon } from "./toolPathRendering";
import { Text } from "@/components/ui/text";
import { ToolScrollableSection } from "./ToolScrollableSection";
import type { ToolPopupContent } from "../../types";
import { useEffectiveDirectory } from "@/hooks/useEffectiveDirectory";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useUIStore } from "@/stores/useUIStore";
import { RuntimeAPIContext } from "@/contexts/runtimeAPIContext";
import { Icon } from "@/components/icon/Icon";
import { SimpleMarkdownRenderer } from "../../../MarkdownRenderer";
const getTaskSummaryLabel = (entry: TaskToolSummaryEntry): string => {
    // `title` only reaches here from a legacy `<task_metadata>` block; a live
    // v2 call is described from its own input.
    const title = entry.state?.title;
    if (typeof title === 'string' && title.trim().length > 0) {
        return title;
    }

    const described = toolDescription(entry.tool, entry.state?.input, undefined);
    if (described?.kind === 'files') {
        const names = described.files.slice(0, 3).map((path) => path.split(/[\\/]/).pop() || path);
        const remaining = described.files.length - names.length;
        return `${names.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`;
    }
    return described && (described.kind === 'path' || described.kind === 'text') ? described.value.trim() : '';
};

const shouldRenderGitPathLabel = (toolName: string, label: string): boolean => {
    if (!isNavigationTool(toolName) && !isFileChangeTool(toolName)) {
        return false;
    }

    const trimmed = label.trim();
    if (!trimmed || trimmed === 'Patch' || /^\d+\s+files$/.test(trimmed)) {
        return false;
    }

    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return true;
    }

    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    if (baseName.startsWith('.') || baseName.includes('.')) {
        return true;
    }

    return /^[A-Za-z0-9_-]+$/.test(baseName);
};

const getTaskSummaryEntryRenderSignature = (entry: TaskToolSummaryEntry): string => {
    const toolName = normalizeToolName(entry.tool);
    const status = entry.state?.status ?? '';
    const label = getTaskSummaryLabel(entry);
    return `${entry.id ?? ''}\u0001${toolName}\u0001${status}\u0001${label}`;
};

const areTaskSummaryEntriesRenderEqual = (
    prevEntries: TaskToolSummaryEntry[],
    nextEntries: TaskToolSummaryEntry[],
): boolean => {
    if (prevEntries === nextEntries) return true;
    if (prevEntries.length !== nextEntries.length) return false;
    for (let index = 0; index < prevEntries.length; index += 1) {
        if (getTaskSummaryEntryRenderSignature(prevEntries[index]) !== getTaskSummaryEntryRenderSignature(nextEntries[index])) {
            return false;
        }
    }
    return true;
};

const TaskSummaryEntryRow = React.memo(({
    entry,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entry: TaskToolSummaryEntry;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const { t } = useI18n();
    const normalizedToolName = normalizeToolName(entry.tool);
    const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
    const label = getTaskSummaryLabel(entry);
    const hasLabel = label.trim().length > 0;
    const status = entry.state?.status;
    const displayName = getToolDisplayName(toolName, t);

    return (
        <ToolRevealOnMount animate={animateTailText} wipe>
            {/* Single-line rows everywhere: the old mobile break-words mode
                wrapped long shell commands into a hanging column and floated
                the icon to the top of the block. Errors still wrap — they must
                stay readable. */}
            <div className={cn('flex gap-2 min-w-0 w-full', status === 'error' && isMobile ? 'items-start' : 'items-center')}>
                <span className="flex-shrink-0 text-foreground/80">{getToolIcon(toolName)}</span>
                <span
                    className="typography-meta text-foreground/80 flex-shrink-0"
                    style={{ color: 'var(--tools-title)' }}
                    title={displayName}
                >
                    {displayName}
                </span>
                {hasLabel ? (
                    status !== 'error' && shouldRenderGitPathLabel(toolName, label) ? (
                        renderAnimatedPathWithIcon(label, animateTailText, true, showToolFileIcons, 'typography-meta')
                    ) : (
                        status === 'error' ? (
                            <span className={cn(
                                'typography-meta flex-1 min-w-0 text-[var(--status-error)]',
                                isMobile ? 'whitespace-normal break-words' : 'truncate',
                            )}>
                                {label}
                            </span>
                        ) : (
                            <Text
                                variant={animateTailText ? 'generate-effect' : 'static'}
                                className="typography-meta flex-1 min-w-0 truncate text-muted-foreground/70"
                                style={{ color: 'var(--tools-description)' }}
                                title={label}
                            >
                                {label}
                            </Text>
                        )
                    )
                ) : null}
            </div>
        </ToolRevealOnMount>
    );
}, (prev, next) => {
    return prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && getTaskSummaryEntryRenderSignature(prev.entry) === getTaskSummaryEntryRenderSignature(next.entry);
});

const TaskSummaryEntriesList = React.memo(({
    entries,
    isExpanded,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const visibleEntries = isExpanded ? entries : entries.slice(-6);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);
    const visibleStartIndex = entries.length - visibleEntries.length;

    return (
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} className="pt-0" disableHorizontal>
            <div className="w-full min-w-0 space-y-1">
                {hiddenCount > 0 ? (
                    <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
                ) : null}

                {visibleEntries.map((entry, idx) => {
                    const absoluteIndex = isExpanded ? idx : visibleStartIndex + idx;
                    const rowKey = entry.id ?? `${getTaskSummaryEntryRenderSignature(entry)}:${absoluteIndex}`;
                    return (
                        <TaskSummaryEntryRow
                            key={rowKey}
                            entry={entry}
                            isMobile={isMobile}
                            animateTailText={animateTailText}
                            showToolFileIcons={showToolFileIcons}
                        />
                    );
                })}
            </div>
        </ToolScrollableSection>
    );
}, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && areTaskSummaryEntriesRenderEqual(prev.entries, next.entries);
});

export const TaskToolSummary: React.FC<{
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    output?: string;
    sessionId?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
    animateTailText?: boolean;
    isActive?: boolean;
}> = ({ entries, isExpanded, isMobile, output, sessionId, onShowPopup, input, animateTailText = true, isActive = false }) => {
    const { t } = useI18n();
    const currentDirectory = useEffectiveDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const runtime = React.useContext(RuntimeAPIContext);

    const trimmedOutput = prepareTaskToolOutput(output);
    const hasOutput = trimmedOutput.length > 0;
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);

    // v2 names the subagent to run in `input.agent`.
    const agentType = typeof input?.agent === 'string'
        ? input.agent
        : 'subagent';

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId && currentDirectory) {
            // In single-surface layouts (mobile, VS Code) navigate in place;
            // otherwise open a new side-panel tab.
            if (isMobile || runtime?.runtime.isVSCode) {
                setCurrentSession(sessionId, currentDirectory);
                return;
            }

            openContextPanelTab(currentDirectory, {
                mode: 'chat',
                dedupeKey: `session:${sessionId}`,
                label: agentType.charAt(0).toUpperCase() + agentType.slice(1),
                readOnly: true,
            });
        }
    };

    if (entries.length === 0 && !hasOutput && !sessionId) {
        return (
            <div className="relative pe-2 pb-2 pt-2 space-y-2 ps-[1.4375rem]">
                <div className="typography-meta text-muted-foreground/70">
                    {isActive ? 'Waiting for subagent activity...' : 'No subagent session id on task metadata.'}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative pe-2 pb-2 pt-2 space-y-2 ps-[1.4375rem]',
                'before:absolute before:start-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                'before:top-[-0.25rem] before:bottom-0'
            )}
        >
            {entries.length > 0 ? (
                <TaskSummaryEntriesList
                    entries={entries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    animateTailText={animateTailText}
                    showToolFileIcons={showToolFileIcons}
                />
            ) : null}

            {sessionId && (
                <button
                    type="button"
                    className="flex items-center gap-2 typography-meta text-primary hover:text-primary/80 w-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleOpenSession}
                >
                    <Icon name="external-link" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="typography-meta text-primary font-medium">{t('chat.toolPart.openSubtask', { type: agentType.charAt(0).toUpperCase() + agentType.slice(1) })}</span>
                </button>
            )}

            {hasOutput ? (
                <div className={cn('space-y-1', (entries.length > 0 || sessionId) && 'pt-1')}
                >
                    <button
                        type="button"
                        className="flex items-center gap-2 typography-meta text-foreground/80 hover:text-foreground w-full"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsOutputExpanded((prev) => !prev);
                        }}
                    >
                        {isOutputExpanded ? (
                            <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        )}
                        <span className="typography-meta text-foreground/80 font-medium">{t('chat.toolPart.output')}</span>
                    </button>
                    {isOutputExpanded ? (
                        <ToolScrollableSection maxHeightClass="max-h-[50vh]">
                            <div className="w-full min-w-0">
                                <SimpleMarkdownRenderer content={trimmedOutput} variant="tool" onShowPopup={onShowPopup} />
                            </div>
                        </ToolScrollableSection>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
