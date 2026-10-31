import React from 'react';
import { useI18n } from '@/lib/i18n';
import { formatWindowLabel, getQuotaProviderList } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { formatQuotaRefreshStatus } from '@/lib/quota/refreshStatus';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId, UsageWindow } from '@/types';

export type UsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
  window: UsageWindow;
};

export type UsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  planLabel?: string | null;
  rows: UsageLimitRow[];
  /** Provider-level message: a fetch error, or "nothing reported". */
  status: string | null;
};

/**
 * Quota windows grouped by provider, shaped for the compact usage list.
 *
 * Used by desktop and mobile work status to select providers, filter model
 * rows and report provider-level status.
 *
 * Include selected, configured providers and first-load failures whose
 * configuration is still unknown. Confirmed unconfigured providers stay hidden.
 */
export const useUsageProviderGroups = (): UsageProviderGroup[] => {
  const { t } = useI18n();
  const quotaResults = useQuotaStore((state) => state.results);
  const nativeProviders = useQuotaStore((state) => state.nativeProviders);
  const refreshErrors = useQuotaStore((state) => state.refreshErrors);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);

  return React.useMemo<UsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return getQuotaProviderList(nativeProviders)
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        return result?.configured === true || (!result && (providerMeta.id === 'claude' || Boolean(refreshErrors[providerMeta.id])));
      })
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        const rows: UsageLimitRow[] = [];

        for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
          rows.push({ key: `window-${label}`, label: formatWindowLabel(label), window });
        }

        const modelEntries = Object.entries(result?.usage?.models ?? {});
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const visibleWindows = providerMeta.id === 'antigravity-cli' ? entries : entries.slice(0, 1);
          for (const [label, window] of visibleWindows) {
            rows.push({
              key: `model-${modelName}-${label}`,
              label: formatWindowLabel(label),
              subtitle: getDisplayModelName(modelName),
              window,
            });
          }
        }

        const refreshError = refreshErrors[providerMeta.id];
        let status = formatQuotaRefreshStatus(result, t, refreshError);
        if (!status) {
          if (refreshError) {
            status = result?.usage
              ? t('header.services.usageRefreshFailedStale', { error: refreshError })
              : refreshError;
          } else if (!result?.ok && result?.error) {
            status = result.error;
          } else if (rows.length === 0 && providerMeta.id !== 'claude') {
            status = t('header.services.noRateLimitsReported');
          }
        }

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          planLabel: result?.planLabel,
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, nativeProviders, quotaResults, refreshErrors, selectedQuotaModels, t]);
};
