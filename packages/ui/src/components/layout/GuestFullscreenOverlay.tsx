import React from 'react';

import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { resolveTitlebarInsets } from '@/components/layout/titlebarInsets';
import { setFullscreenBodyHost, setFullscreenHeaderHost } from '@/components/layout/workspaceHosts';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useTabletStandalonePwaRuntime } from '@/lib/device';
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { isGuestActive } from '@/lib/guests/capabilities';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { useGuestsStore } from '@/lib/guests/store';
import { getInlineStartSide, useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Window-filling overlay for an extension surface (e.g. Remote Desktop).
 * Always stays mounted so `fullscreenBody` remains connected across enter/exit
 * transitions and `MovablePane` can move the live iframe without reloading it.
 */
export const GuestFullscreenOverlay: React.FC = () => {
  const { direction } = useI18n();
  const guestFullscreen = useUIStore((state) => state.guestFullscreen);
  const setGuestFullscreen = useUIStore((state) => state.setGuestFullscreen);
  const catalogStatus = useGuestsStore((state) => state.status);
  const guest = useGuestsStore((state) => (
    guestFullscreen ? state.guests.find((entry) => entry.id === guestFullscreen.id) ?? null : null
  ));
  const guestActive = guest !== null && isGuestActive(guest);
  const isOpen = Boolean(guestFullscreen && guestActive);

  const isDesktopApp = React.useMemo(() => isDesktopShell(), []);
  const isMacPlatform = React.useMemo(
    () => /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? ''),
    [],
  );
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();
  const startControls = usesFramelessChrome && windowControlsSide === getInlineStartSide(direction);
  const endControls = usesFramelessChrome && !startControls;
  const { titlebarStartInset, titlebarEndInset } = React.useMemo(
    () => resolveTitlebarInsets({
      direction,
      isDesktopApp,
      isMacPlatform,
      isTabletStandalonePwa,
      usesFramelessChrome,
    }),
    [direction, isDesktopApp, isMacPlatform, isTabletStandalonePwa, usesFramelessChrome],
  );

  React.useEffect(() => {
    if (guestFullscreen && (!guestActive && (catalogStatus === 'ready' || guest !== null))) {
      setGuestFullscreen(null);
    }
  }, [catalogStatus, guest, guestActive, guestFullscreen, setGuestFullscreen]);

  React.useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event)) return;
      // Leave Escape to the remote desktop when the guest iframe holds focus.
      if (document.activeElement instanceof HTMLIFrameElement) return;
      if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setGuestFullscreen(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, setGuestFullscreen]);

  const handleDragStart = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || event.button !== 0) return;
    if (target.closest('.app-region-no-drag') || target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (isDesktopApp) void startDesktopWindowDrag();
  }, [isDesktopApp]);

  const title = guestFullscreen?.surface === 'page' ? (guest?.pageTitle ?? guest?.name ?? '') : (guest?.name ?? '');
  const icon = guest ? resolveGuestIconName(guest.icon) : 'computer';
  const iconSrc = guest ? guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset) : undefined;
  const titlebarHeight = isDesktopApp && (isMacPlatform || usesFramelessChrome)
    ? 'var(--oc-header-height, 2.75rem)'
    : 'max(2.5rem, var(--oc-wco-titlebar-height, 0px))';
  const headerStyle: React.CSSProperties = {
    minHeight: titlebarHeight,
    height: titlebarHeight,
    paddingInlineStart: isDesktopApp && isMacPlatform && direction !== 'rtl'
      ? 'var(--oc-titlebar-start-inset, 88px)'
      : titlebarStartInset,
    paddingInlineEnd: endControls ? '0px' : titlebarEndInset,
  };

  return (
    <div
      data-guest-fullscreen={isOpen ? 'open' : 'closed'}
      aria-hidden={!isOpen || undefined}
      inert={!isOpen || undefined}
      className={cn('fixed inset-0 z-[45] flex flex-col bg-background', !isOpen && 'hidden')}
    >
      <header className="header-safe-area shrink-0 border-b border-border bg-background">
        <div
          onMouseDown={handleDragStart}
          style={headerStyle}
          className="app-region-drag flex select-none items-center justify-between gap-2"
        >
          <div className="app-region-no-drag flex min-w-0 items-center gap-2">
            {startControls ? <WindowsWindowControls visible position={windowControlsSide} /> : null}
            {guest ? <GuestIcon icon={icon} iconSrc={iconSrc} className="size-3.5 shrink-0" /> : null}
            <span className="truncate typography-ui-label text-foreground">{title}</span>
          </div>
          <div className="app-region-no-drag flex shrink-0 items-center gap-2">
            <div ref={setFullscreenHeaderHost} className="flex shrink-0 items-center gap-1 empty:hidden" />
            {endControls ? <WindowsWindowControls visible position={windowControlsSide} /> : null}
          </div>
        </div>
      </header>
      <div ref={setFullscreenBodyHost} data-guest-fullscreen-body="" className="relative min-h-0 flex-1 overflow-hidden bg-background" />
    </div>
  );
};
