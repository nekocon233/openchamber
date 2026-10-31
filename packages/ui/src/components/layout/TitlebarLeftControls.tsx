import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { getInlineStartSide, useI18n } from '@/lib/i18n';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { publishTitlebarControlsWidth } from './titlebarControlsWidth';
import { useTitlebarControlsOverSidebar } from './workspaceLayout';

// Like the icon rail: muted at rest, full strength on hover or while what it
// controls is on, and no hover fill.
const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-6 w-6 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors';

/**
 * Native window controls and the app menu stay at the start of the titlebar.
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so the buttons never migrate / re-mount between the
 * two while the sidebar animates open or closed — the panels slide *underneath*
 * a fixed control cluster instead. Its height tracks `--oc-header-height` and
 * its start padding clears the OS window controls via `--oc-titlebar-start-inset`.
 * The cluster's measured width is published as `--oc-titlebar-controls-width`
 * onto the elements that reserve room for it (`titlebarControlsWidth.ts`), so
 * the header can reserve matching space when the sidebar is collapsed.
 */
export const TitlebarLeftControls: React.FC = () => {
  const { t, locale, direction } = useI18n();
  const titlebarControlsOverSidebar = useTitlebarControlsOverSidebar();
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
      locale,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, [locale]);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const node = clusterRef.current;
    if (!node) {
      return;
    }

    const publishWidth = () => {
      // Prefer scrollWidth so negative child margins / overflow cannot under-report
      // the space the overlay actually occupies over the header.
      const width = Math.max(node.getBoundingClientRect().width, node.scrollWidth);
      publishTitlebarControlsWidth(width);
    };

    publishWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publishWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      className={cn(
        'app-region-no-drag absolute inset-s-0 top-0 z-30 flex select-none items-center pe-2',
      )}
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingInlineStart: 'var(--oc-titlebar-start-inset, 0.75rem)',
        // The overlay floats above the sidebar rather than inside it, so it is
        // sized by its own content. Keep the native control cluster within
        // the sidebar when that column owns the titlebar area.
        maxWidth: titlebarControlsOverSidebar ? 'var(--oc-left-sidebar-width, 100%)' : undefined,
      }}
    >
      <div ref={clusterRef} className="flex min-w-0 items-center gap-2">
        {usesFramelessChrome && windowControlsSide === getInlineStartSide(direction) ? (
          <WindowsWindowControls visible position={windowControlsSide} />
        ) : null}

        {usesFramelessChrome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

      </div>
    </div>
  );
};
