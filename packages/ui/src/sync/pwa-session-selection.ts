import { z } from 'zod';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getPWADisplayMode } from '@/lib/pwa';
import { isLinkIdentifier } from '@/lib/router/messageFocus';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { isPrimarySessionNavigationSurface } from './session-navigation';

const route = '/api/pwa/session-selection';
const selectionSchema = z.object({ sessionId: z.string().refine(isLinkIdentifier).nullable() });

export const isPwaSessionSelectionEnabled = (): boolean => {
  if (isDesktopShell() || isVSCodeRuntime() || isCapacitorApp() || !isPrimarySessionNavigationSurface()) return false;
  const mode = getPWADisplayMode();
  return mode === 'standalone' || mode === 'window-controls-overlay' || mode === 'minimal-ui' || mode === 'twa';
};

export const readPwaSessionSelection = async (signal: AbortSignal): Promise<string | null> => {
  const response = await runtimeFetch(route, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read the PWA session selection');
  return selectionSchema.parse(await response.json()).sessionId;
};

type Selection = { sessionId: string; runtimeKey: string; isCurrent: () => boolean };
let writing = false;
let pending: Selection | undefined;

const writeSelections = async () => {
  writing = true;
  while (pending) {
    const { sessionId, runtimeKey, isCurrent } = pending;
    pending = undefined;
    if (!isCurrent()) continue;
    // Keep writes ordered even when several sessions are selected quickly.
    // An outstanding request can finish when the installed page closes.
    await runtimeFetch(route, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
      signal: AbortSignal.timeout(5_000),
      expectedRuntimeKey: runtimeKey,
    }).catch(() => {});
  }
  writing = false;
};

export const sharePwaSessionSelection = (sessionId: string): void => {
  if (!isPwaSessionSelectionEnabled() || !isLinkIdentifier(sessionId)) return;
  pending = { sessionId, runtimeKey: getRuntimeKey(), isCurrent: captureRuntimeInstance() };
  if (!writing) void writeSelections();
};
