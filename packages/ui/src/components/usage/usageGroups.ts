import React from 'react';
import { useI18n } from '@/lib/i18n';
import { formatWindowLabel } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { formatQuotaRefreshStatus } from '@/lib/quota/refreshStatus';
import { formatMagpieError } from '@/lib/quota/magpie';
import { useQuotaProviders, useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId, UsageWindow } from '@/types';
import type { QuotaAccount } from '@/types/quota';
import { selectVisibleModelEntries } from './usageModelSelection';

const FIVE_HOUR_NAMES = new Set(['5h', '5 hour', '5-hour', '5 hours', 'five_hour', '5 小时', '5 小時', '5小时', '5小時']);

export function isWorkStatusQuotaWindow(
  name: string,
  { windowSeconds, magpieTrend }: Pick<UsageWindow, 'windowSeconds' | 'magpieTrend'>,
): boolean {
  const cycle = magpieTrend?.matchesSnapshot ? magpieTrend.cycle : undefined;
  const seconds = windowSeconds ?? (cycle ? (cycle.reset - cycle.start) / 1000 : null);
  if (seconds !== null) return seconds !== 5 * 3600;
  return !name.split(' · ').some(part => FIVE_HOUR_NAMES.has(part.trim().toLowerCase()));
}

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
  accountLabel?: string | null;
  rows: UsageLimitRow[];
  accounts?: QuotaAccount[];
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
export const useUsageProviderGroups = () => {
  const { t } = useI18n();
  const quotaResults = useQuotaStore((state) => state.results);
  const nativeProviders = useQuotaStore((state) => state.nativeProviders);
  const refreshErrors = useQuotaStore((state) => state.refreshErrors);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const providers = useQuotaProviders();

  return React.useMemo(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    const seenProviderIds = new Set<QuotaProviderId>();
    const allProviders = [
      ...providers.map((provider) => (
        provider.id === 'kimi-for-coding' && nativeProviders.length > 0 && !provider.name.endsWith(' / OpenCode')
          ? { ...provider, name: `${provider.name} / OpenCode` }
          : provider
      )),
      ...nativeProviders,
    ].filter((provider) => {
      if (seenProviderIds.has(provider.id)) return false;
      seenProviderIds.add(provider.id);
      return true;
    });
    const configuredProviders = allProviders
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        return result?.configured === true || (!result && (providerMeta.id === 'claude' || Boolean(refreshErrors[providerMeta.id])));
      });
    const groups: UsageProviderGroup[] = configuredProviders.flatMap((providerMeta) => {
      const result = resultsByProvider.get(providerMeta.id);
      const rows: UsageLimitRow[] = [];
      let hidWindow = false;
      const keepWindows = (windows: Record<string, UsageWindow>) => {
        const all = Object.entries(windows);
        const kept = all.filter(([name, window]) => isWorkStatusQuotaWindow(name, window));
        hidWindow ||= kept.length < all.length;
        return kept;
      };

      for (const [label, window] of keepWindows(result?.usage?.windows ?? {})) {
        rows.push({ key: `window-${label}`, label: formatWindowLabel(label), window });
      }

      const modelEntries = Object.entries(result?.usage?.models ?? {});
      const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
      const visibleModelEntries = selectVisibleModelEntries(providerMeta.id, modelEntries, providerSelectedModels);
      for (const [modelName, modelUsage] of visibleModelEntries) {
        const entries = keepWindows(modelUsage.windows ?? {});
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

      const accountSource = result?.usage?.accounts;
      const visibleAccounts = accountSource?.flatMap(account => {
        const kept = keepWindows(account.windows);
        if (kept.length === Object.keys(account.windows).length) return [account];
        if (kept.length === 0 && !account.error && !account.sharedBalance) return [];
        return [{ ...account, windows: Object.fromEntries(kept) }];
      });
      const accounts = accountSource?.length && visibleAccounts?.length === 0 ? undefined : visibleAccounts;

      const refreshError = refreshErrors[providerMeta.id];
      let status = formatQuotaRefreshStatus(result, t, refreshError);
      if (!status) {
        if (refreshError && providerMeta.id === 'magpie') {
          status = formatMagpieError(refreshError, t);
        } else if (refreshError) {
          status = result?.usage
            ? t('header.services.usageRefreshFailedStale', { error: refreshError })
            : refreshError;
        } else if (!result?.ok && result?.error) {
          status = result.error;
        } else if (rows.length === 0) {
          if (hidWindow && !accounts?.length) return [];
          if (providerMeta.id !== 'claude' && providerMeta.id !== 'magpie') {
            status = t('header.services.noRateLimitsReported');
          }
        }
      }

      return [{
        providerId: providerMeta.id,
        providerName: providerMeta.name,
        planLabel: result?.planLabel,
        accountLabel: result?.accountLabel,
        rows,
        accounts,
        status,
      }];
    });
    return { groups, hasQuotaProviders: configuredProviders.length > 0 };
  }, [dropdownProviderIds, nativeProviders, providers, quotaResults, refreshErrors, selectedQuotaModels, t]);
};
