import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SidebarStateMutationRequest } from '@openchamber/ui/lib/api/types';
import { createWebSidebarStateAPI } from './sidebarState';

const fetchMock = vi.fn<typeof fetch>();

const unsupported = () => Response.json({
  code: 'SIDEBAR_STATE_VALIDATION', error: 'operation.patch contains unsupported field defaultVariant',
}, { status: 400 });
const request = (defaultVariant: string | null): SidebarStateMutationRequest => ({
  baseRevision: 3, clientMutationId: 'edit-project',
  operation: { type: 'project.update', projectId: 'project-a', patch: { defaultModel: 'codex-native/sol', defaultVariant } },
});

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

it('sends explicit clears and preserves the mutation identity if an older host rejects the field', async () => {
  fetchMock.mockResolvedValueOnce(unsupported()).mockResolvedValueOnce(Response.json({
    applied: true, deduplicated: false, mutationRevision: 4,
    snapshot: { schemaVersion: 1, revision: 4, projects: [], pinnedSessionIds: [], worktreeOrderByProject: {}, sessionFoldersByScope: {} },
  }));
  await createWebSidebarStateAPI().mutate(request(null));
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    request(null),
    { ...request(null), operation: { type: 'project.update', projectId: 'project-a', patch: { defaultModel: 'codex-native/sol' } } },
  ]);
});

it('propagates an old host refusal when the user chose a concrete variant', async () => {
  fetchMock.mockResolvedValueOnce(unsupported());
  await expect(createWebSidebarStateAPI().mutate(request('high-ultrafast'))).rejects.toThrow('unsupported field defaultVariant');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
