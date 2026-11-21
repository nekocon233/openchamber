import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey, MOBILE_DISCONNECTED_RUNTIME_KEY } from '@/lib/runtime-switch';
import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';

import { useGuestBadgeStore } from './badge-store.ts';
import { isGuestActive } from './capabilities.ts';
import { parseGuestCatalogJson } from './parse.ts';
import { proxyGuestServiceRequest } from './service.ts';
import { useGuestsStore } from './store.ts';

const alignCatalogRuntime = (runtimeKey: string): void => {
  const store = useGuestsStore.getState();
  if (store.runtimeKey !== runtimeKey) {
    store.resetForRuntimeSwitch(runtimeKey);
    useGuestBadgeStore.getState().resetForRuntimeSwitch();
  }
};

let announcedChanges = 0;
let inFlight: { runtimeKey: string; changes: number; request: Promise<void> } | null = null;

export const loadGuestCatalog = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const running = inFlight?.runtimeKey === runtimeKey ? inFlight : null;
  if (running && running.changes === announcedChanges) return running.request;
  const after = () => (getRuntimeKey() === runtimeKey ? loadGuestCatalogOnce(runtimeKey) : undefined);
  const request = (running ? running.request.then(after) : loadGuestCatalogOnce(runtimeKey))
    .finally(() => {
      if (inFlight?.request === request) inFlight = null;
    });
  inFlight = { runtimeKey, changes: announcedChanges, request };
  return request;
};

export const reloadGuestCatalog = (): Promise<void> => {
  announcedChanges += 1;
  return loadGuestCatalog();
};

const loadGuestCatalogOnce = async (runtimeKey: string): Promise<void> => {
  alignCatalogRuntime(runtimeKey);

  const store = useGuestsStore.getState();
  if (isVSCodeRuntime()) {
    store.markUnsupported(runtimeKey);
    return;
  }
  if (runtimeKey === MOBILE_DISCONNECTED_RUNTIME_KEY) {
    return;
  }
  const mobileSurface = isMobileSurfaceRuntime();

  store.markLoading();
  try {
    const response = await runtimeFetch('/api/guests');
    if (useGuestsStore.getState().runtimeKey !== runtimeKey) {
      return;
    }
    if (!response.ok) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'http', status: response.status });
      return;
    }
    const content = await response.text().catch(() => null);
    const catalog = content === null ? null : parseGuestCatalogJson(content);
    if (useGuestsStore.getState().runtimeKey !== runtimeKey) {
      return;
    }
    if (!catalog) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'invalid-response', status: response.status });
      return;
    }
    useGuestsStore.getState().replaceCatalog(
      catalog.guests,
      runtimeKey,
      catalog.unreadable,
      catalog.opencodePlugins,
      catalog.hostPlatform,
    );
    const desktopGuest = catalog.guests.find((guest) => guest.id === DESKTOP_GUEST_ID);
    if (!mobileSurface && catalog.hostPlatform === 'linux' && desktopGuest && isGuestActive(desktopGuest)) {
      void probeDesktopUrlReady(runtimeKey);
    }
  } catch {
    useGuestsStore.getState().markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'network' });
  }
};

const desktopReadyStatusSchema = z.object({
  platform: z.string().min(1),
  missing: z.array(z.string()),
  browser: z.boolean().optional(),
});

const probeDesktopUrlReady = async (runtimeKey: string): Promise<void> => {
  try {
    const response = await proxyGuestServiceRequest(DESKTOP_GUEST_ID, { method: 'GET', path: '/status' });
    if (useGuestsStore.getState().runtimeKey !== runtimeKey) return;
    if (!response.ok || response.result.status !== 200) {
      useGuestsStore.getState().setDesktopUrlReady(false, runtimeKey);
      return;
    }
    const parsed = desktopReadyStatusSchema.safeParse(JSON.parse(response.result.body));
    const ready = parsed.success
      && parsed.data.platform === 'linux'
      && parsed.data.missing.length === 0
      && parsed.data.browser !== false;
    useGuestsStore.getState().setDesktopUrlReady(ready, runtimeKey);
  } catch {
    useGuestsStore.getState().setDesktopUrlReady(false, runtimeKey);
  }
};
