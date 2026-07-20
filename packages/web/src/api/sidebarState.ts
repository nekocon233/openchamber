import type {
  SidebarStateAPI,
  SidebarStateMutationRequest,
  SidebarStateMutationResult,
  SidebarStateSnapshot,
} from '@openchamber/ui/lib/api/types';
import {
  SidebarStateConflictError,
  parseSidebarStateMutationResult,
  parseSidebarStateSnapshot,
} from '@openchamber/ui/lib/sidebarState';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const SNAPSHOT_PATH = '/api/sidebar-state';
const MUTATIONS_PATH = '/api/sidebar-state/mutations';

const readErrorPayload = async (response: Response): Promise<Record<string, unknown> | null> => {
  const value = await response.json().catch(() => null) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

export const createWebSidebarStateAPI = (): SidebarStateAPI => ({
  supported: true,

  async load(options): Promise<SidebarStateSnapshot> {
    const response = await runtimeFetch(SNAPSHOT_PATH, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: options?.signal,
    });
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Failed to load sidebar state (${response.status})`);
    }
    return parseSidebarStateSnapshot(await response.json());
  },

  async mutate(
    request: SidebarStateMutationRequest,
    options,
  ): Promise<SidebarStateMutationResult> {
    const response = await runtimeFetch(MUTATIONS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    if (response.status === 409) {
      const payload = await readErrorPayload(response);
      if (payload?.latestSnapshot !== undefined) {
        throw new SidebarStateConflictError(parseSidebarStateSnapshot(payload.latestSnapshot));
      }
      throw new Error(typeof payload?.error === 'string' ? payload.error : 'Sidebar mutation was rejected');
    }
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Failed to mutate sidebar state (${response.status})`);
    }
    return parseSidebarStateMutationResult(await response.json());
  },
});
