import { OpenCode } from '@opencode/client';

type InstanceDisposerDependencies = {
  buildOpenCodeUrl: (path: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
};

const WORKTREE_INSTANCE_DISPOSE_TIMEOUT_MS = 5_000;

const toLocationKey = (directory: string) => String(directory || '').replace(/\\/g, '/').replace(/\/+$/, '');

export const createWorktreeInstanceDisposer = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }: InstanceDisposerDependencies) => {
  return async (worktreeDirectory: string) => {
    const client = OpenCode.make({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(WORKTREE_INSTANCE_DISPOSE_TIMEOUT_MS) }),
    });
    const root = toLocationKey(worktreeDirectory);
    const errors: unknown[] = [];
    const inside = await client.debug.location.list().then(
      (locations) => locations.map((location) => location.directory)
        .filter((directory) => toLocationKey(directory).startsWith(`${root}/`)),
      (error) => {
        errors.push(error);
        return [];
      },
    );
    const evictions = await Promise.allSettled([worktreeDirectory, ...inside].map((directory) => (
      client.debug.location.evict({ location: { directory } })
    )));
    for (const eviction of evictions) {
      if (eviction.status === 'rejected') errors.push(eviction.reason);
    }
    if (errors.length > 0) throw errors[0];
  };
};
