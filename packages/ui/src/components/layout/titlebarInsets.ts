import type { LayoutDirection } from '@/lib/i18n/runtime';

type TitlebarInsetsInput = {
  direction: LayoutDirection;
  isDesktopApp: boolean;
  isMacPlatform: boolean;
  isDesktopWindowFullscreen?: boolean;
  isTabletStandalonePwa: boolean;
  usesFramelessChrome: boolean;
  isVSCode?: boolean;
};

/**
 * Resolves logical start/end header insets that clear native window controls
 * (macOS traffic lights) and browser Window Controls Overlay buttons in both
 * LTR and RTL layouts.
 */
export function resolveTitlebarInsets({
  direction,
  isDesktopApp,
  isMacPlatform,
  isDesktopWindowFullscreen = false,
  isTabletStandalonePwa,
  usesFramelessChrome,
  isVSCode = false,
}: TitlebarInsetsInput) {
  const titlebarLeftInset = (() => {
    if (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      // Native traffic lights have a fixed physical footprint. Keep this
      // clearance in pixels so shrinking the interface cannot overlap them.
      return '88px';
    }
    if (isTabletStandalonePwa) {
      return 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)';
    }
    if ((!isDesktopApp || usesFramelessChrome) && !isVSCode) {
      return 'calc(0.75rem + var(--oc-wco-left-inset, 0px))';
    }
    return '0.75rem';
  })();

  const titlebarRightInset = (!isDesktopApp || usesFramelessChrome) && !isVSCode
    ? 'calc(0.75rem + var(--oc-wco-right-inset, 0px))'
    : '0.75rem';

  const isRtl = direction === 'rtl';
  return {
    titlebarStartInset: isRtl ? titlebarRightInset : titlebarLeftInset,
    titlebarEndInset: isRtl ? titlebarLeftInset : titlebarRightInset,
  };
}
