import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/useUIStore';
import { WORK_STATUS_PANEL_WIDTH } from './useWorkStatusVisibility';
import { setWorkStatusReserved } from '@/components/layout/rightSlot';
import { LAYOUT_ANIMATION_EASING } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { WorkStatusGoalRow } from './WorkStatusGoalRow';
import { WorkStatusPrimaryGroup } from './WorkStatusPrimaryGroup';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';
import { WorkStatusTelemetrySection } from './WorkStatusTelemetrySection';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';
import { WorkStatusChecklistSection } from './WorkStatusChecklistSection';
import { WorkStatusBackgroundTasksSection } from './WorkStatusBackgroundTasksSection';
import { WorkStatusPlanSection } from './WorkStatusPlanSection';
import { WorkStatusTodosSection } from './WorkStatusTodosSection';
import { WorkStatusMcpSection } from './WorkStatusMcpSection';
import { WorkStatusPinnedSection } from './WorkStatusPinnedSection';
import { WorkStatusContextSection } from './WorkStatusContextSection';
import { WorkStatusSectionsDialog } from './WorkStatusSectionsDialog';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';
import {
  areAllWorkStatusSectionsHidden,
  getWorkStatusPanelPresentation,
  isExtensionSectionId,
  isWorkStatusSectionVisible,
  resolveWorkStatusSectionOrder,
  type WorkStatusSectionId,
} from './sections';
import { useWorkStatusExtensionSections } from './useWorkStatusExtensionSections';
import { WorkStatusPresenceProvider } from './presence';
import { Icon } from '@/components/icon/Icon';
import { isNativeSessionId } from '@/lib/native-agents/ids';

// What these list is OpenCode's (its MCP servers and skills) or context
// OpenChamber adds to OpenCode prompts (pins, memory). A native CLI session
// uses none of it, so the panel leaves them out there rather than misreport.
const OPENCODE_CONTEXT_SECTIONS = new Set<WorkStatusSectionId>(['mcp', 'pinned', 'contextSources']);

type WorkStatusPresentation = 'inline' | 'overlay' | 'sheet';

type Props = {
  /** Null on a new-session draft: repository readouts still apply. */
  sessionId: string | null;
  directory: string | null;
  /** Managed Chats have no project repository, even if another project remains active. */
  repositoryEnabled?: boolean;
  /** Whether the panel should currently be shown. */
  visible: boolean;
  /**
   * Inline only: the right slot keeps the card's column (see
   * `components/layout/rightSlot.ts`). True while the context panel covers
   * the card too, so closing the panel goes straight back to the card.
   */
  reserved?: boolean;
  /**
   * Inline sits beside the transcript, overlay floats over it, and sheet
   * renders as the body of a mobile bottom sheet with no width or scroll of
   * its own.
   */
  presentation?: WorkStatusPresentation;
  /** Mobile sheet only: warm the branch's change-request summary on open. */
  prewarmPrStatus?: boolean;
};

/**
 * The inline card lives in the right slot with the context panel, and the
 * slot animates the width (`components/layout/rightSlot.ts`): the card itself
 * keeps its width and only fades, on the slot's duration and curve, while the
 * context panel fades in over it. The overlay fades and lifts.
 */
const PANEL_TRANSITION_EASING = LAYOUT_ANIMATION_EASING;

/**
 * Work-status panel: a card inside the chat column reporting the state of the
 * session, its branch and its subagents.
 *
 * Sections follow the user's saved order. Each section renders
 * nothing when it has nothing, so the panel collapses toward the top instead of
 * reserving empty space.
 *
 * The card clips; the scroller lives inside it, so the same top/bottom scroll
 * shadows the transcript uses stay within the rounded border instead of
 * bleeding past it. The scrollbar itself is hidden — at this width it would
 * eat a visible slice of every row's trailing value, and the shadows already
 * say there is more to see.
 */
export const WorkStatusPanel: React.FC<Props> = ({ sessionId, directory, visible, reserved = false, repositoryEnabled = true, presentation = 'inline', prewarmPrStatus = false }) => {
  const { t, direction } = useI18n();
  const nativeSession = sessionId !== null && isNativeSessionId(sessionId);
  const isInline = presentation === 'inline';
  const isOverlay = presentation === 'overlay';
  const isSheet = presentation === 'sheet';
  // The card's fade and lift follow the side columns' animation setting.
  const panelTransitionMs = useLayoutAnimationMs();
  const setScrollTop = useUIStore((state) => state.setWorkStatusScrollTop);
  const setOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const hiddenSections = useUIStore((state) => state.workStatusHiddenSections);
  const storedOrder = useUIStore((state) => state.workStatusSectionOrder);
  const extensionSections = useWorkStatusExtensionSections();
  const sectionOrder = React.useMemo(
    () => resolveWorkStatusSectionOrder(storedOrder, extensionSections.ids),
    [extensionSections.ids, storedOrder],
  );
  const [sectionsDialogOpen, setSectionsDialogOpen] = React.useState(false);
  // Starts optimistic: sections report after their first commit, and rendering
  // nothing on the way in would make the card flash out and back on arrival.
  const [renderedSections, setRenderedSections] = React.useState(1);
  const sectionVisible = React.useCallback(
    (sectionId: Parameters<typeof isWorkStatusSectionVisible>[1]) =>
      isWorkStatusSectionVisible(hiddenSections, sectionId),
    [hiddenSections],
  );
  const frameRef = React.useRef<number | null>(null);

  // Restoring the offset has to happen the moment the scroller attaches, and
  // the panel unmounts whenever the context panel opens. Reading the stored
  // value through a ref keeps this a mount-time restore rather than a
  // subscription that would fight the user mid-scroll.
  // Content is dropped only after the collapse finishes, so the card animates
  // out with something in it rather than emptying first, and its subscriptions
  // stop once it is truly gone.
  const [contentMounted, setContentMounted] = React.useState(visible);
  // Hidden or mid-collapse: the card is not something the user can act on.
  // When `visible` but all sections are hidden, the panel stays interactive so
  // the settings button remains reachable — otherwise there is no way to
  // re-enable sections. The previous `renderedSections > 0` guard is preserved
  // for the transient "no data yet" state so the panel doesn't flash a bare
  // bordered card on first mount.
  const allSectionsHidden = areAllWorkStatusSectionsHidden(hiddenSections, extensionSections.ids);
  const presentationState = getWorkStatusPanelPresentation({
    visible,
    contentMounted,
    renderedSections,
    allSectionsHidden,
  });
  const interactive = isSheet ? visible : presentationState.interactive;
  const showEmptyState = presentationState.showEmptyState;
  React.useEffect(() => {
    if (visible) {
      setContentMounted(true);
      // Optimistic again, as on first mount: the sections left the presence
      // count when they unmounted, and reading that as "nothing to show"
      // would give the card's column back for the frames before they report.
      setRenderedSections((count) => Math.max(count, 1));
      return undefined;
    }
    const timer = window.setTimeout(() => setContentMounted(false), panelTransitionMs);
    return () => window.clearTimeout(timer);
  }, [panelTransitionMs, visible]);

  // Tells the right slot whether to keep the card's column. A card whose
  // sections all reported nothing gives it back, as its collapse did before.
  const empty = contentMounted && renderedSections === 0 && !allSectionsHidden;
  const wantsColumn = isInline && reserved && !empty;
  React.useLayoutEffect(() => {
    if (!isInline) return undefined;
    setWorkStatusReserved(wantsColumn);
    return () => setWorkStatusReserved(false);
  }, [isInline, wantsColumn]);

  const restore = React.useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const stored = useUIStore.getState().workStatusScrollTop;
    if (stored > 0) node.scrollTop = stored;
  }, []);

  // Coalesced to one write per frame: scroll fires far faster than the store
  // needs to hear about it.
  const handleScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
    const { scrollTop } = event.currentTarget;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(scrollTop);
    });
  }, [setScrollTop]);

  React.useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // The offset belongs to the panel a session produced, not to the panel in
  // general: restoring one session's scroll into another's shorter panel lands
  // somewhere arbitrary.
  React.useEffect(() => {
    if (isSheet) return;
    setScrollTop(0);
  }, [isSheet, sessionId, setScrollTop]);

  // Dismissed like any transient surface: a click elsewhere or Escape. It
  // covers the transcript, so leaving it up would block the thing it reports on.
  const overlayRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    // Only while it is actually up: a hidden overlay listening for clicks would
    // swallow the very press that opens it.
    if (!isOverlay || !visible || sectionsDialogOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (overlayRef.current?.contains(target)) return;
      // The header toggle closes it on its own; letting this fire too would
      // close and immediately reopen.
      if (target?.closest('[data-work-status-toggle]')) return;
      // Section menus render in a portal outside the panel; picking an item
      // in one is still a click inside the panel.
      if (target?.closest('[data-work-status-popup]')) return;
      setOverlayOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlayOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOverlay, setOverlayOpen, visible, sectionsDialogOpen]);

  // Keep these elements owned by the panel so primary readout updates do not
  // rerender unrelated sections through the composition callback.
  const secondarySections = {
    usage: <WorkStatusUsageSection />,
    telemetry: <WorkStatusTelemetrySection sessionId={sessionId} directory={directory} />,
    subagents: <WorkStatusSubagentsSection sessionId={sessionId} directory={directory} />,
    taskChecklist: <WorkStatusChecklistSection sessionId={sessionId} directory={directory} />,
    taskBackground: <WorkStatusBackgroundTasksSection sessionId={sessionId} directory={directory} />,
    mcp: <WorkStatusMcpSection directory={directory} />,
    pinned: <WorkStatusPinnedSection sessionId={sessionId} directory={directory} />,
    contextSources: <WorkStatusContextSection sessionId={sessionId} directory={directory} />,
    taskPlan: <WorkStatusPlanSection sessionId={sessionId} directory={directory} />,
    taskTodos: <WorkStatusTodosSection sessionId={sessionId} directory={directory} />,
  } satisfies Record<Exclude<WorkStatusSectionId, 'session' | 'repository'>, React.ReactNode>;

  const sections = (
    <WorkStatusPresenceProvider onChange={setRenderedSections}>
      <WorkStatusPrimaryGroup
        sessionId={sessionId}
        directory={directory}
        showSession={sectionVisible('session')}
        showRepository={repositoryEnabled && sectionVisible('repository')}
        prewarmPrStatus={prewarmPrStatus}
        goalRow={<WorkStatusGoalRow sessionId={sessionId} directory={directory} />}
      >
        {(primary) => sectionOrder.map((id) => {
          if (!sectionVisible(id) || (nativeSession && !isExtensionSectionId(id) && OPENCODE_CONTEXT_SECTIONS.has(id))) return null;
          if (isExtensionSectionId(id)) {
            const guest = extensionSections.byId.get(id);
            return guest ? <WorkStatusExtensionSection key={id} guest={guest} directory={directory} /> : null;
          }
          return <React.Fragment key={id}>{id === 'session' || id === 'repository' ? primary[id] : secondarySections[id]}</React.Fragment>;
        })}
      </WorkStatusPrimaryGroup>
    </WorkStatusPresenceProvider>
  );

  return (
    <aside
      ref={overlayRef}
      aria-label={t('chat.workStatus.ariaLabel')}
      aria-hidden={isSheet ? undefined : !interactive}
      // The card stays mounted while hidden so it can animate its own collapse,
      // and the sections button sits outside the content gate. Without `inert`
      // Tab could land on an invisible control — and `aria-hidden` around a
      // focusable descendant is an accessibility fault in its own right.
      inert={isSheet ? undefined : !interactive}
      data-work-status-presentation={presentation}
      className={cn(
        // `self-start` keeps the card at content height instead of stretching
        // to the row; `max-h` then caps it so a long panel scrolls rather than
        // overflowing the chat.
        // A left margin as well as a right one: flush against the transcript
        // the card's own shadow had no room and was clipped down that edge.
        (isInline || isOverlay) && 'relative flex shrink-0 flex-col self-start overflow-hidden',
        isInline && ['my-4 ms-2 me-4', 'max-h-[calc(100%-2rem)]'],
        // Out of the flow entirely, anchored to the chat column's top-right so
        // it reads as a dropdown from the header button. As a flex child it
        // took part in the layout and pushed the transcript, which is the one
        // thing an overlay must not do.
        isOverlay && [
          'absolute inset-e-3 top-3 z-30 mx-0 my-0',
          'max-h-[calc(100%-1.5rem)]',
        ],
        // The sheet host owns width, height, scrolling and animation.
        isSheet && 'relative flex w-full flex-col',
        // When every section is hidden the card keeps its edge and background
        // so the settings button stays discoverable — going transparent made the
        // only recovery path unreachable.
        'motion-reduce:transition-none',
        // Beside the chat: the layout panels' ring (`oc-panel-edge`, shared
        // with the context panel card). Over the chat it is a dropdown and
        // takes the dropdown's full edge (`data-edge-floating`).
        !isSheet && 'oc-panel-edge rounded-xl',
        isInline && 'bg-[var(--surface-muted)]/40',
      )}
      // Hidden, the overlay's edge fades out alongside the glass fade: see
      // the opacity note below.
      data-edge-hidden={isOverlay && !interactive ? '' : undefined}
      data-edge-floating={isOverlay ? '' : undefined}
      style={isSheet ? undefined : {
        // Neither form animates its width: inline, the right slot around the
        // card does; the overlay takes no space from the chat. Inline, the
        // card only fades. The overlay lifts like the dropdown it reads as and
        // never fades this element: an ancestor below full opacity cuts the
        // glass layer off from what is behind it, so the card showed clear,
        // unblurred, for the whole fade and frosted only at the end. The glass
        // layer fades itself; the edge fades with it.
        width: WORK_STATUS_PANEL_WIDTH,
        opacity: isOverlay || interactive ? 1 : 0,
        transform: isOverlay ? (visible ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.98)') : undefined,
        // The overlay sits at the chat's end corner: top right, or top left in RTL.
        transformOrigin: direction === 'rtl' ? 'top left' : 'top right',
        transitionProperty: isOverlay ? 'transform, box-shadow' : 'opacity',
        transitionDuration: `${panelTransitionMs}ms`,
        transitionTimingFunction: PANEL_TRANSITION_EASING,
        pointerEvents: interactive ? undefined : 'none',
      }}
    >
      {/* Beside the transcript the translucent fill reads as depth; on top of
          it, message bubbles showed straight through the rows, so the overlay
          is frosted. The glass sits on this inner layer, away from the card's
          shadow: on one element Chromium grows the backdrop-filter layer by
          the shadow's blur and paints a grey band past the card's edge. */}
      <div
        className={cn('flex min-h-0 flex-1 flex-col', isOverlay && 'oc-glass-panel')}
        style={isOverlay ? {
          opacity: interactive ? 1 : 0,
          transitionProperty: 'opacity',
          transitionDuration: `${panelTransitionMs}ms`,
          transitionTimingFunction: PANEL_TRANSITION_EASING,
        } : undefined}
      >
      {/* Overlaid rather than placed in flow: the panel has no header of its
          own, and giving it one would cost a row of height on every session. */}
      <button
        type="button"
        aria-label={t('chat.workStatus.sections.open')}
        onClick={() => setSectionsDialogOpen(true)}
        className="absolute inset-e-2 top-1.5 z-10 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="equalizer-2" className="size-4" />
      </button>

      {contentMounted ? (
        isSheet ? (
          <div className="p-2 [&>section:first-child>[data-work-status-heading]]:pe-7">{sections}</div>
        ) : (
          <ScrollShadow
            ref={restore}
            onScroll={handleScroll}
            size={24}
            // Sections returning null leave no DOM node, so this reserves room for
            // settings in the first rendered heading, regardless of saved order.
            className="oc-hide-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 [&>section:first-child>[data-work-status-heading]]:pe-7"
          >
            {sections}
          </ScrollShadow>
        )
      ) : null}

      {showEmptyState ? (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <span className="text-sm text-muted-foreground">{t('chat.workStatus.sections.allHidden')}</span>
          <Button
            variant="link"
            size="xs"
            onClick={() => setSectionsDialogOpen(true)}
            className="mt-2 normal-case text-muted-foreground hover:text-foreground"
          >
            {t('chat.workStatus.sections.open')}
          </Button>
        </div>
      ) : null}
      </div>

      <WorkStatusSectionsDialog open={sectionsDialogOpen} onOpenChange={setSectionsDialogOpen} />
    </aside>
  );
};
