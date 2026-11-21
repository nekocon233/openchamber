import { z } from 'zod';
import { zonePlacementSchema, type ContextZonePlacement } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

const UI_STORE_KEY = 'ui-store';

const persistedPlacementSchema = z.object({
  state: z.object({ contextSurfaceZones: z.record(z.string(), z.unknown()) }),
});

export const readPersistedZonePlacement = (raw: string | null): ContextZonePlacement | null => {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = persistedPlacementSchema.safeParse(json);
  return parsed.success ? zonePlacementSchema.parse(parsed.data.state.contextSurfaceZones) : null;
};

export const followZonePlacementOfOtherWindows = (): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== UI_STORE_KEY) return;
    const incoming = readPersistedZonePlacement(event.newValue);
    if (!incoming) return;
    useUIStore.getState().setContextSurfaceZones(incoming);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
};
