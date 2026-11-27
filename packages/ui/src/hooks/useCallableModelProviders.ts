import { useEffect, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { NATIVE_PROVIDER_ANTIGRAVITY } from '@/lib/native-agents/ids';

export function useCallableModelProviders(enabled = true, scope: 'all' | 'native' = 'all'): string[] | undefined {
  const catalog = useConfigStore((state) => state.providers);
  const currentDirectory = useDirectoryStore((state) => scope === 'all' ? state.currentDirectory : null);
  const runtimeKey = getRuntimeKey();
  const [snapshot, setSnapshot] = useState<{ runtimeKey: string; scope: typeof scope; providerIds: string[] }>();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = scope === 'native' ? '/api/small-model?providers=native'
          : currentDirectory ? `/api/small-model?directory=${encodeURIComponent(currentDirectory)}` : '/api/small-model';
        const response = await runtimeFetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        // SAFETY: `GET /api/small-model` (server `small-model/routes.js`)
        // answers `{ authenticatedProviders: string[], ... }`; the array check
        // and the string filter below reject anything else.
        const payload = (await response.json().catch(() => null)) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && runtimeKey === getRuntimeKey() && Array.isArray(payload?.authenticatedProviders)) {
          const providerIds = payload.authenticatedProviders
            .filter((id): id is string => typeof id === 'string')
            .filter((id) => id !== NATIVE_PROVIDER_ANTIGRAVITY);
          setSnapshot({ providerIds, runtimeKey, scope });
        }
      } catch {
        // Transport failure: keep whatever we knew.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog, currentDirectory, enabled, runtimeKey, scope]);

  return snapshot?.runtimeKey === runtimeKey && snapshot.scope === scope ? snapshot.providerIds : undefined;
}
