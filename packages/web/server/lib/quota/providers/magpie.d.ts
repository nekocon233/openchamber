import type { ProviderResult } from '../../../../../ui/src/types/quota';

export function createMagpieQuotaReader(options?: {
  fetchImpl?: typeof fetch;
  configDir?: string;
  timeoutMs?: number;
}): (options?: { refresh?: boolean }) => Promise<ProviderResult>;
export const fetchMagpieQuota: ReturnType<typeof createMagpieQuotaReader>;
