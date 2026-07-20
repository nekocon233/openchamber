import React from 'react';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { startBrowserPushSubscriptionReconciliation } from '@/lib/browserPushRegistration';
import { isCapacitorApp } from '@/lib/platform';

export const useBrowserPushSubscriptionReconciliation = (options?: { enabled?: boolean }): void => {
  const enabled = options?.enabled ?? true;

  React.useEffect(() => {
    if (
      !enabled
      || !isWebRuntime()
      || isDesktopShell()
      || isCapacitorApp()
      || typeof window === 'undefined'
      || typeof navigator === 'undefined'
      || !('serviceWorker' in navigator)
    ) {
      return;
    }

    return startBrowserPushSubscriptionReconciliation();
  }, [enabled]);
};
