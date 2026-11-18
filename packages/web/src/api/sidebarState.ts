import { z } from 'zod';
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
import { getRuntimeEndpointGeneration } from '@openchamber/ui/lib/runtime-switch';

const SNAPSHOT_PATH = '/api/sidebar-state';
const MUTATIONS_PATH = '/api/sidebar-state/mutations';

const errorPayload = z.object({
  error: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  latestSnapshot: z.unknown().optional(),
});
const readErrorPayload = async (response: Response) => errorPayload.safeParse(await response.json().catch(() => null)).data;

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
      throw new Error(payload?.error ?? `Failed to load sidebar state (${response.status})`);
    }
    return parseSidebarStateSnapshot(await response.json());
  },

  async mutate(
    request: SidebarStateMutationRequest,
    options,
  ): Promise<SidebarStateMutationResult> {
    const generation = getRuntimeEndpointGeneration();
    const post = (body: SidebarStateMutationRequest) => runtimeFetch(MUTATIONS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    let response = await post(request);
    const { operation } = request;
    if (response.status === 400 && operation.type === 'project.update' && operation.patch.defaultVariant === null) {
      const payload = await readErrorPayload(response);
      const message = payload?.error ?? 'Invalid project update';
      // A host from before project variants cannot hold a value to clear. Its
      // strict schema rejects the entire patch before applying any of it.
      if (payload?.code !== 'SIDEBAR_STATE_VALIDATION' || message !== 'operation.patch contains unsupported field defaultVariant'
        || options?.signal?.aborted || generation !== getRuntimeEndpointGeneration()) throw new Error(message);
      const patch = { ...operation.patch };
      delete patch.defaultVariant;
      if (!Object.keys(patch).length) throw new Error(message);
      response = await post({ ...request, operation: { ...operation, patch } });
    }
    if (response.status === 409) {
      const payload = await readErrorPayload(response);
      if (payload?.latestSnapshot !== undefined) {
        throw new SidebarStateConflictError(parseSidebarStateSnapshot(payload.latestSnapshot));
      }
      throw new Error(payload?.error ?? 'Sidebar mutation was rejected');
    }
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      throw new Error(payload?.error ?? `Failed to mutate sidebar state (${response.status})`);
    }
    return parseSidebarStateMutationResult(await response.json());
  },
});
