import type { ProviderResult } from '../../../../../../ui/src/types/quota';

interface ClaudeQuotaCredential {
  accessToken: string;
  refreshToken: string | null;
  planLabel: string | null;
}

type CredentialReader = () => ClaudeQuotaCredential | null | Promise<ClaudeQuotaCredential | null>;

export function createClaudeQuotaTracker(options: {
  cacheScope: string;
  loadCredential: CredentialReader;
  cacheFile?: () => string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): {
  fetchQuota: (loadCredential?: CredentialReader) => Promise<ProviderResult>;
  readCachedQuota: (loadCredential?: CredentialReader) => Promise<ProviderResult | null>;
  reset: () => void;
};
