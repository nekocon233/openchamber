import { isNativeSessionId } from '@/lib/native-agents/ids';
import { parseTaskMetadataBlock, type TaskToolSummaryEntry, normalizeTaskSummaryEntries, readTaskSessionIdFromRecord, readTaskSessionIdFromOutput } from "../taskToolModel";
import { useRunningTaskChildSessionId, isAntigravityToolPart } from "./subagentChildSession";
import { z } from "zod";
import { recordedFileChanges, isFileChangeTool, isChecklistTool, checklistToolItems } from "@/lib/opencode/tools";
import { getRelativePath } from "./toolPaths";
import { isReplacementPreview, getDiffPatchEntries, getToolFallbackDiff } from "../toolDiffUtils";
import { writeInputOf, addedFilePatch } from "../conciseDiffRows";
import { type ConciseDiffFile, ConciseDiff } from "../ConciseDiff";
import { TaskToolSummary } from "./TaskToolSummary";
import { type ConciseToolStatus, ConciseToolHeader } from "../ConciseToolHeader";
import { getConciseToolName, getConciseToolResult } from "../conciseToolRow";
import { ChangedFilesWithoutDiff } from "../ChangedFilesWithoutDiff";
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { cn } from '@/lib/utils';
import { BlockBody } from '../BlockLine';
import type { ToolPart as ToolPartType } from '@/lib/opencode/model';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/icon/Icon';
import { MinDurationShineText } from '../MinDurationShineText';
import { getToolIcon } from '../toolPresentation';
import { guestToolHeaderReadsOutput, renderGuestToolHeader, useGuestToolPresentation } from '@/lib/guests/tool-presentation';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { useChatTranscriptDirectory } from '@/components/chat/chatColumnSession';
import { dispatchRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { isEditTool, isExecuteTool, isPatchTool, isShellTool, isSubagentTool, subagentAgent, isWriteTool, normalizeToolName, executeNamespace } from '@/lib/opencode/tools';
import { ApplyPatchFileButtons } from '../ApplyPatchFileButtons';
import { QuietAction } from '../ToolResultParts';
import { useToolContentCompletion } from '../useToolContentCompletion';
import { DiffCount } from '@/components/ui/diff-count';
import type { ToolStateWithMetadata, ToolPartProps, ToolRowHeader } from './types';
import { TOOL_ROW_TITLE_CLASS, TOOL_ROW_DESCRIPTION_CLASS, TOOL_ERROR_ICON_STYLE, TOOL_NORMAL_ICON_STYLE, TOOL_ERROR_TITLE_STYLE, TOOL_NORMAL_TITLE_STYLE } from './toolRowStyles';
import { LiveDuration } from './LiveDuration';
import { useDeferredExpandedContent } from './deferredExpandedContent';
import { parseDiffStats, parseWriteLineCount } from './toolChangeSummary';
import { getToolDescriptionPath, toolDisplayName, getToolDescription, describeOpenChamberRow, describeOpencodeRow } from './toolDescriptions';
import { OpenSubtaskButton } from './OpenSubtaskButton';
import { renderAnimatedPathWithIcon } from './toolPathRendering';
import { ToolExpandedContent } from './ToolExpandedContent';
import { useToolRowTiming } from './useToolRowTiming';
import { useToolRowOpenActions } from './useToolRowOpenActions';

const COLLAPSED_CHANGED_FILE_NAMES = 5;

export const ToolPartContent: React.FC<ToolPartProps & { header?: ToolRowHeader; subagentSessionId?: string }> = ({
    part,
    isExpanded,
    onToggle: toggleRow,
    isMobile,
    onShowPopup,
    animateTailText = true,
    failureReason,
    header,
    subagentSessionId,
}) => {
    const { t } = useI18n();
    const rowRef = React.useRef<HTMLDivElement>(null);
    const onToggle = (toolId: string) => {
        if (!isExpanded) dispatchRowExpand(rowRef.current);
        toggleRow(toolId);
    };
    const state = part.state;
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const showToolFileIcons = useUIStore((s) => s.showToolFileIcons);
    const conciseTranscript = useUIStore((s) => s.conciseTranscript);
    const currentDirectory = useEffectiveDirectory() ?? '';

    const normalizedPartTool = normalizeToolName(part.tool);
    const isTaskTool = isSubagentTool(normalizedPartTool);
    const presentation = useGuestToolPresentation(part.tool);

    const status = state?.status as string | undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    const isError = status === 'error' || status === 'failed';

    const { isActive, effectiveTimeStart, effectiveTimeEnd } = useToolRowTiming(part.id, stateWithData.time, isFinalized);

    const expandedContentRef = React.useRef<HTMLDivElement>(null);
    const [headerActionsSlot, setHeaderActionsSlot] = React.useState<HTMLSpanElement | null>(null);

    React.useLayoutEffect(() => {
        const element = expandedContentRef.current;
        if (!element) {
            return;
        }

        element.style.height = isExpanded ? 'auto' : '0px';
        element.style.overflow = isExpanded ? 'visible' : 'hidden';
    }, [isExpanded]);

    const shouldTreatAsFinalized = isFinalized;

    const partMetadata = (part as unknown as { metadata?: unknown }).metadata;

    const taskOutputString = React.useMemo(() => {
        return typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    }, [stateWithData.output]);

    const parsedTaskMetadata = React.useMemo(() => {
        return parseTaskMetadataBlock(taskOutputString);
    }, [taskOutputString]);

    const metadataTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool) {
            return [];
        }
        const candidateSummary = (metadata as { summary?: unknown; entries?: unknown; tools?: unknown; calls?: unknown } | undefined);
        const normalized = normalizeTaskSummaryEntries(
            candidateSummary?.summary ?? candidateSummary?.entries ?? candidateSummary?.tools ?? candidateSummary?.calls
        );

        if (normalized.length > 0) {
            return normalized;
        }

        return parsedTaskMetadata.summaryEntries;
    }, [isTaskTool, metadata, parsedTaskMetadata.summaryEntries]);

    const authoritativeTaskSessionId = React.useMemo<string | undefined>(() => {
        if (!isTaskTool) {
            return undefined;
        }

        // Current OpenCode publishes this authoritative join while the Task is
        // running. The remaining sources only support older persisted parts.
        const metadataSessionId = readTaskSessionIdFromRecord(metadata);
        if (metadataSessionId) {
            return metadataSessionId;
        }

        const partLevelSessionId = readTaskSessionIdFromRecord(partMetadata);
        if (partLevelSessionId) {
            return partLevelSessionId;
        }

        if (parsedTaskMetadata.sessionId) {
            return parsedTaskMetadata.sessionId;
        }
        return readTaskSessionIdFromOutput(taskOutputString);
    }, [isTaskTool, metadata, parsedTaskMetadata.sessionId, partMetadata, taskOutputString]);

    // A parent message loaded over REST mid-run lacks the progress-only join
    // (see resolveRunningTaskChildSessionId); recover it from the child
    // session records until the authoritative id arrives.
    const inferredTaskSessionId = useRunningTaskChildSessionId(
        isTaskTool && !authoritativeTaskSessionId && state.status === 'running' && !isAntigravityToolPart(part) ? part : undefined,
        currentDirectory,
    );
    const taskSessionId = authoritativeTaskSessionId ?? inferredTaskSessionId ?? subagentSessionId;
    const antigravityPart = isAntigravityToolPart(part);
    const nativeDetails = React.useMemo(() => antigravityPart
        ? z.object({
            nativeOutputTruncated: z.boolean().optional(),
            nativeSubagents: z.array(z.object({ sessionID: z.string(), title: z.string(), agent: z.string() })).optional(),
        }).safeParse(metadata).data
        : undefined, [metadata, antigravityPart]);

    // The file changes a command's CLI recorded; null for every other call.
    const recordedChanges = React.useMemo(() => recordedFileChanges(part.tool, metadata), [metadata, part.tool]);
    const recordedPaths = React.useMemo(
        () => recordedChanges?.withoutDiff.map((path) => getRelativePath(path, currentDirectory)) ?? [],
        [currentDirectory, recordedChanges],
    );
    const diffStats = React.useMemo(() => {
        if (isReplacementPreview(metadata)) return null;
        // A total that leaves out files without a diff would read as complete.
        if (recordedChanges) return recordedChanges.complete ? parseDiffStats(metadata) : null;
        return (isEditTool(normalizedPartTool) || isPatchTool(normalizedPartTool))
            ? parseDiffStats(metadata)
            : null;
    }, [metadata, normalizedPartTool, recordedChanges]);
    const writtenInput = React.useMemo(
        () => (isWriteTool(normalizedPartTool) && metadata?.nativeInputTruncated !== true ? writeInputOf(input) : null),
        [input, metadata?.nativeInputTruncated, normalizedPartTool],
    );
    const writeLineCount = React.useMemo(() => {
        return writtenInput && !isError ? parseWriteLineCount(input) : null;
    }, [input, isError, writtenInput]);
    // The concise transcript shows under a file change what it did. A write
    // whose metadata carries no diff shows its content as added.
    const conciseDiffFiles = React.useMemo((): ConciseDiffFile[] => {
        if (!conciseTranscript || status !== 'completed') return [];
        if (!recordedChanges && !isFileChangeTool(normalizedPartTool)) return [];
        const entries = getDiffPatchEntries(metadata, getToolFallbackDiff(metadata), (path) => getRelativePath(path, currentDirectory))
            .filter((entry) => entry.renderMode === 'diff');
        if (entries.length > 0) return entries;
        return writtenInput && writtenInput.content.length > 0
            ? [{ id: 'write', title: writtenInput.filePath ?? '', patch: addedFilePatch(writtenInput.content) }]
            : [];
    }, [conciseTranscript, currentDirectory, metadata, normalizedPartTool, recordedChanges, status, writtenInput]);
    const isMultiFileApplyPatch = isPatchTool(normalizedPartTool) && Array.isArray(metadata?.files) && metadata.files.length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as ToolPartType) : part;
    const descriptionPath = getToolDescriptionPath(normalizedPart, state, currentDirectory);
    const stateOutput = typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    const scriptNamespace = isExecuteTool(part.tool) ? executeNamespace(metadata) : undefined;
    const plainDescription = getToolDescription(normalizedPart, state, currentDirectory, t, scriptNamespace);
    const builtInDescription = describeOpenChamberRow(normalizedPart, input, stateOutput, t)
        ?? describeOpencodeRow(part, plainDescription, t)
        ?? plainDescription;
    const guestHeader = React.useMemo(
        () => (presentation ? renderGuestToolHeader(presentation, { input, output: stateOutput, metadata }) : null),
        [input, metadata, presentation, stateOutput],
    );
    const checklistItems = !presentation && status === 'completed' && metadata?.nativeInputTruncated !== true && isChecklistTool(part.tool)
        ? checklistToolItems(input)
        : null;
    const description = guestHeader?.subtitle ?? (checklistItems !== null
        ? t('chat.nativeTasks.summary.checklist', { completed: checklistItems.filter((item) => item.status === 'completed').length, total: checklistItems.length })
        : builtInDescription);
    const rowTool = scriptNamespace ?? (normalizedPartTool || part.tool);
    const displayName = guestHeader?.title ?? (isChecklistTool(part.tool) ? t('chat.toolPart.checklist.title') : toolDisplayName(rowTool, t));

    const failureDetail = isError && !isExpanded ? failureReason : undefined;

    const guestSubtitle = guestHeader?.subtitle ?? null;
    const justificationText = React.useMemo(() => {
        if (guestSubtitle) {
            return null;
        }
        if (isShellTool(normalizedPartTool)) {
            return null;
        }
        if (isPatchTool(normalizedPartTool)) {
            return null;
        }
        if (
            descriptionPath
            && (isPatchTool(normalizedPartTool) || isEditTool(normalizedPartTool) || isWriteTool(normalizedPartTool))
        ) {
            return null;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [descriptionPath, guestSubtitle, normalizedPartTool, input]);
    const runtime = React.useContext(RuntimeAPIContext);
    const { openApplyPatchFile, handleMainClick, handleMainRowClick, handleMainKeyDown, quickOpenTarget, handleQuickOpen } = useToolRowOpenActions({
        part,
        normalizedPartTool,
        input,
        metadata,
        currentDirectory,
        isTaskTool,
        onToggle,
    });

    const iconStyle = !isTaskTool && isError ? TOOL_ERROR_ICON_STYLE : TOOL_NORMAL_ICON_STYLE;
    const titleStyle = !isTaskTool && isError ? TOOL_ERROR_TITLE_STYLE : TOOL_NORMAL_TITLE_STYLE;
    // The concise transcript folds a subagent's calls away like any tool's details.
    const usesTaskSummary = isTaskTool && (conciseTranscript || isNativeSessionId(part.sessionID) || metadataTaskSummaryEntries.length > 0);
    const shouldRenderTaskSummary = useDeferredExpandedContent(usesTaskSummary && (conciseTranscript
        ? isExpanded
        : (metadataTaskSummaryEntries.length > 0 || isActive || shouldTreatAsFinalized || !!taskSessionId)));
    const shouldRenderExpandedContent = useDeferredExpandedContent(!usesTaskSummary && isExpanded);
    const storeDirectory = useChatTranscriptDirectory();
    const contentCompletion = useToolContentCompletion(
        part,
        shouldRenderExpandedContent || (presentation !== null && guestToolHeaderReadsOutput(presentation)),
        storeDirectory ?? undefined,
    );
    const showsDuration = isShellTool(normalizedPartTool) || isTaskTool || part.tool === 'openchamber_image';

    if (!shouldTreatAsFinalized && !isActive && !isTaskTool) {
        return null;
    }

    const quickOpenButton = quickOpenTarget ? (
        <button
            type="button"
            onClick={handleQuickOpen}
            className={cn(
                'flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded transition-opacity hover:bg-interactive-hover',
                'opacity-60 hover:opacity-100 focus-visible:opacity-100',
            )}
            style={{ color: 'var(--tools-icon)' }}
            title={t('chat.toolPart.openFile')}
            aria-label={t('chat.toolPart.openFile')}
        >
            <Icon name="external-link" className="h-3 w-3" />
        </button>
    ) : null;

    const taskDetails = shouldRenderTaskSummary ? (
        <TaskToolSummary
            entries={metadataTaskSummaryEntries}
            isExpanded={isExpanded}
            isMobile={isMobile}
            output={taskOutputString}
            sessionId={taskSessionId}
            onShowPopup={onShowPopup}
            input={input}
            animateTailText={animateTailText}
            isActive={isActive}
        />
    ) : null;

    const expandedDetails = !usesTaskSummary ? (
            <div
                ref={expandedContentRef}
                aria-hidden={!isExpanded}
                style={{
                    height: isExpanded ? 'auto' : '0px',
                    overflow: isExpanded ? 'visible' : 'hidden',
                    overflowAnchor: 'none',
                }}
            >
                {shouldRenderExpandedContent ? (
                    <BlockBody onToggle={() => onToggle(part.id)}>
                        {contentCompletion.status === 'whole' ? (
                            <ToolExpandedContent
                                part={part}
                                state={state}
                                currentDirectory={currentDirectory}
                                isExpanded={isExpanded}
                                onShowPopup={onShowPopup}
                                presentation={presentation}
                                headerActionsSlot={headerActionsSlot}
                                checklistItems={checklistItems}
                            />
                        ) : contentCompletion.status === 'loading' ? (
                            contentCompletion.showProgress ? (
                                <div className="typography-meta text-muted-foreground">
                                    {t('chat.toolPart.content.loading')}
                                </div>
                            ) : null
                        ) : (
                            <div className="typography-meta flex items-center gap-2 text-muted-foreground">
                                <span>{t('chat.toolPart.content.loadFailed')}</span>
                                <QuietAction label={t('chat.toolPart.content.retry')} onClick={contentCompletion.retry} />
                            </div>
                        )}
                    </BlockBody>
                ) : null}
            </div>
    ) : null;

    if (conciseTranscript) {
        const conciseStatus: ConciseToolStatus = isError
            ? 'failed'
            : !isFinalized ? 'running' : status === 'completed' ? 'completed' : 'stopped';
        const argument = justificationText || description;
        const argumentDisplay = descriptionPath && !justificationText && !guestHeader?.subtitle && isFileChangeTool(normalizedPartTool)
            ? <span className="flex min-w-0 max-w-full">{renderAnimatedPathWithIcon(descriptionPath, false, true, false)}</span>
            : argument;
        return (
            <div>
                <ConciseToolHeader
                    name={guestHeader?.title ?? (isChecklistTool(part.tool) ? displayName : getConciseToolName(normalizedPartTool, part.tool))}
                    argument={argumentDisplay}
                    argumentTitle={argument}
                    status={conciseStatus}
                    result={getConciseToolResult({
                        tool: normalizedPartTool,
                        phase: isError ? 'failed' : isFinalized ? 'done' : 'running',
                        error: stateWithData.error,
                        output: stateOutput,
                        diffStats,
                        recordsFileChanges: recordedChanges !== null,
                        writeLines: writeLineCount,
                        subagentToolCalls: metadataTaskSummaryEntries.length,
                    })}
                    timer={effectiveTimeStart !== undefined ? (
                        <LiveDuration start={effectiveTimeStart} end={effectiveTimeEnd} active={isActive} />
                    ) : undefined}
                    expansion={{
                        isExpanded,
                        onToggle: () => onToggle(part.id),
                        onActivate: isMultiFileApplyPatch ? () => onToggle(part.id) : handleMainClick,
                    }}
                    actions={quickOpenButton}
                />
                {!isExpanded && conciseDiffFiles.length > 0 ? <ConciseDiff files={conciseDiffFiles} alwaysNameFiles={recordedChanges !== null} showLineNumbers={!isReplacementPreview(metadata)} /> : null}
                {!isExpanded && recordedChanges ? (
                    <ChangedFilesWithoutDiff
                        changes={recordedChanges}
                        paths={recordedPaths}
                        limit={COLLAPSED_CHANGED_FILE_NAMES}
                        className="mt-0.5 mb-1 ms-5"
                    />
                ) : null}
                {taskDetails}
                {expandedDetails}
            </div>
        );
    }

    return (
        <div ref={rowRef}>
            {}
            <div
                className={cn(
                    'group/tool flex gap-1.5 pe-2 ps-px py-1.5 rounded-xl',
                    isMultiFileApplyPatch ? 'flex-wrap items-start cursor-pointer' : 'items-center cursor-pointer',
                )}
                onClick={isMultiFileApplyPatch ? () => onToggle(part.id) : handleMainRowClick}
                onKeyDown={isMultiFileApplyPatch ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onToggle(part.id);
                } : handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className={cn('flex gap-1.5', isMultiFileApplyPatch ? 'w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5' : 'items-center flex-shrink-0')}>
                    {isMultiFileApplyPatch ? (
                        <>
                            <div className="flex h-5 flex-shrink-0 items-center gap-1.5">
                                <span className="relative h-3.5 w-3.5 flex-shrink-0">
                                    <span className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded ? 'opacity-0' : 'group-hover/tool:opacity-0',
                                    )} style={iconStyle}>
                                        {getToolIcon(rowTool, presentation)}
                                    </span>
                                    <Icon
                                        name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                                        className={cn(
                                            'absolute inset-0 h-3.5 w-3.5 transition-opacity',
                                            isExpanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                                        )}
                                    />
                                </span>
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                            <ApplyPatchFileButtons
                                currentDirectory={currentDirectory}
                                metadata={metadata}
                                animate={animateTailText}
                                showFileIcons={showToolFileIcons}
                                textClassName={TOOL_ROW_DESCRIPTION_CLASS}
                                openDiffLabel={t('chat.toolPart.openFileDiff')}
                                onFileClick={runtime?.editor ? openApplyPatchFile : undefined}
                            />
                        </>
                    ) : (
                        <>
                            <div
                                className="relative h-5 w-3.5 flex-shrink-0 cursor-pointer"
                                onClick={(event) => { event.stopPropagation(); onToggle(part.id); }}
                            >
                                <div
                                    className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded && 'opacity-0',
                                        !isExpanded && 'group-hover/tool:opacity-0'
                                    )}
                                    style={iconStyle}
                                >
                                    {getToolIcon(rowTool, presentation)}
                                </div>
                                <div
                                    className={cn(
                                        'absolute inset-0 transition-opacity flex items-center justify-center',
                                        isExpanded && 'opacity-100',
                                        !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
                                    )}
                                >
                                    {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                                </div>
                            </div>
                            <div className={cn('flex items-center min-w-0 flex-1', quickOpenTarget || taskSessionId ? 'gap-1' : 'gap-2')}>
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                    title={displayName}
                                >
                                    {displayName}
                                </MinDurationShineText>
                                {quickOpenButton}
                                {taskSessionId ? (
                                    <OpenSubtaskButton sessionId={taskSessionId} agent={subagentAgent(input)} isMobile={isMobile} />
                                ) : null}
                            </div>
                            {showsDuration && typeof effectiveTimeStart === 'number' && !header?.durationUnknown ? (
                                <span className={cn('flex-shrink-0 tabular-nums text-muted-foreground', TOOL_ROW_DESCRIPTION_CLASS)}>
                                    <LiveDuration
                                        start={effectiveTimeStart}
                                        end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                        active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
                                    />
                                </span>
                            ) : null}
                            {header?.label ? (
                                <span className={cn('flex-shrink-0 text-muted-foreground', TOOL_ROW_DESCRIPTION_CLASS)}>
                                    {header.label === 'stopped'
                                        ? t('chat.toolPart.background.stoppedLabel')
                                        : t('chat.toolPart.background.label')}
                                </span>
                            ) : null}
                        </>
                    )}
                </div>

                {!isMultiFileApplyPatch && (
                    <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                            {justificationText && (
                                <span
                                    className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                    style={{ color: 'var(--tools-description)' }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && description && (
                                descriptionPath && description === descriptionPath ? (
                                    renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                                ) : (
                                    <Text
                                        variant={animateTailText ? 'generate-effect' : 'static'}
                                        className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                        style={{ color: 'var(--tools-title)' }}
                                        title={description}
                                    >
                                        {description}
                                    </Text>
                                )
                            )}
                            {failureDetail ? (
                                <>
                                    {justificationText || description ? (
                                        <span aria-hidden="true" className="flex-shrink-0 text-muted-foreground/60">·</span>
                                    ) : null}
                                    <span
                                        className={cn('max-w-[50%] flex-shrink-0 truncate text-[var(--status-error)]', TOOL_ROW_DESCRIPTION_CLASS)}
                                        title={failureDetail}
                                    >
                                        {failureDetail}
                                    </span>
                                </>
                            ) : null}
                            {diffStats && (
                                <DiffCount added={diffStats.added} removed={diffStats.removed} className="typography-meta" />
                            )}
                            {writeLineCount && (
                                <DiffCount added={writeLineCount} removed={0} hideZero className="typography-meta" />
                            )}
                        </div>
                        {header?.stop ? (
                            <HoverTooltip label={header.stop.ariaLabel}>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    onClick={(event) => { event.stopPropagation(); header.stop?.onStop(); }}
                                    className="-my-0.5 flex-shrink-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                                    aria-label={header.stop.ariaLabel}
                                >
                                    <Icon name="stop" className="size-3" />
                                    {t('chat.toolPart.background.stopLabel')}
                                </Button>
                            </HoverTooltip>
                        ) : null}
                        <span
                            ref={setHeaderActionsSlot}
                            className="-my-0.5 flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity empty:hidden group-hover/tool:opacity-100 group-focus-within/tool:opacity-100 [@media(hover:none)]:opacity-100"
                        />
                    </div>
                )}
            </div>

            {taskDetails}

            {isExpanded && nativeDetails?.nativeOutputTruncated ? (
                <p role="status" className="typography-meta text-muted-foreground">{t('chat.toolPart.nativeOutputTruncated')}</p>
            ) : null}
            {isExpanded && (nativeDetails?.nativeSubagents?.length ?? 0) > 1 ? (
                <div className="flex min-w-0 flex-col items-start gap-1">
                    {nativeDetails?.nativeSubagents?.map((child) => (
                        <OpenSubtaskButton key={child.sessionID} sessionId={child.sessionID} agent={child.title} isMobile={isMobile} showLabel />
                    ))}
                </div>
            ) : null}

            {expandedDetails}
        </div>
    );
};
