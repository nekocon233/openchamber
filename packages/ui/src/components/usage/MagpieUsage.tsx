import type { QuotaAccount } from '@/types/quota';
import { useDeadlineClock } from '@/hooks/useDurationTicker';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { formatMagpieError, magpieQuotaPace } from '@/lib/quota/magpie';
import { Icon } from '@/components/icon/Icon';
import { MagpieQuotaTrendPopover } from './MagpieQuotaTrendPopover';
import { formatQuotaResetLabel, formatQuotaResetShort, formatQuotaWindowValueLabel, formatWindowLabel } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { UsageCard } from '@/components/sections/usage/UsageCard';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { WorkStatusRow, WorkStatusValue } from '@/components/chat/work-status/WorkStatusPrimitives';

/** The same account/window hierarchy serves Settings, work status, and VS Code. */
export const MagpieUsage = ({ accounts, compact = false, trends }: {
  accounts: QuotaAccount[];
  compact?: boolean;
  trends?: 'current' | 'stale' | undefined;
}) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const displayMode = useQuotaStore(state => state.displayMode);
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  const deadlines = trends === 'current' ? accounts.flatMap(account => (
    account.error ? [] : Object.values(account.windows).flatMap(({ magpieTrend }) =>
      magpieTrend?.matchesSnapshot && magpieTrend.cycle ? [magpieTrend.cycle.reset] : [])
  )) : [];
  const now = useDeadlineClock(deadlines);
  const rows = accounts.map(account => {
    const title = [account.providerName, account.accountLabel, account.planLabel].filter(Boolean).join(' · ');
    const content = <>
      {account.error && <p role="status" className="typography-meta text-[var(--status-warning-text)] break-words">{formatMagpieError(account.error, t)}</p>}
      {account.sharedBalance && <p className="typography-meta text-muted-foreground break-words">{t('quota.magpie.sharedBalance', { account: account.sharedBalance })}</p>}
      {Object.entries(account.windows).map(([label, window]) => {
        if (!compact) return <UsageCard key={label} title={label} window={window} />;
        const percent = displayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
        const metric = formatQuotaWindowValueLabel(window, percent, t, displayMode);
        const resetFull = formatQuotaResetLabel(window.resetAt, null, timeFormat);
        const reset = trends ? formatQuotaResetShort(window.resetAt, null, timeFormat) : resetFull;
        const used = window.usedPercent;
        const tone = used !== null && used >= 80 ? 'error' : used !== null && used >= 50 ? 'warning' : 'default';
        const trend = trends ? window.magpieTrend : undefined;
        const pace = trends === 'current' && !account.error ? magpieQuotaPace(trend, now) : null;
        const paceLabel = pace !== null && window.remainingPercent !== 0
          ? pace >= 10 ? t('chat.workStatus.magpie.pace.fast') : pace <= -10 ? t('chat.workStatus.magpie.pace.slow') : null
          : null;
        const windowLabel = trends
          ? label.split(' · ').map(part => formatWindowLabel(part === '5 hours' ? '5h' : part === '7 days' ? '7d' : part)).join(' · ')
          : formatWindowLabel(label);
        const value = metric === '-' ? t('quota.magpie.unknown') : metric;
        const row = <WorkStatusRow
          key={label}
          className={trend === undefined ? undefined : 'group-hover:text-foreground group-focus-within:text-foreground pointer-coarse:min-h-11'}
          label={<span className="inline-flex min-w-0 items-baseline gap-1.5">
            <span dir="auto" className="truncate oc-ui-start-align" title={windowLabel}>{windowLabel}</span>
            {reset && <span className="shrink-0 typography-micro text-muted-foreground" title={resetFull ?? undefined}>{reset}</span>}
          </span>}
          value={<>
            {paceLabel && <WorkStatusValue tone={pace !== null && pace > 0 ? 'warning' : 'muted'}>
              <span className="typography-micro">{paceLabel}</span>
            </WorkStatusValue>}
            <WorkStatusValue tone={tone}>{value}</WorkStatusValue>
            {trends && <span aria-hidden className="inline-flex size-[13px] items-center text-muted-foreground">
              {trend !== undefined && <Icon name="line-chart" className="size-full" />}
            </span>}
          </>}
        />;
        return trend === undefined ? row : (
          <MagpieQuotaTrendPopover key={label} trend={trend} label={windowLabel} mobile={isMobile}
            rowLabel={[title, windowLabel, value, paceLabel, resetFull].filter(Boolean).join(' · ')}>
            {row}
          </MagpieQuotaTrendPopover>
        );
      })}
      {!account.error && !account.sharedBalance && Object.keys(account.windows).length === 0 &&
        <p className="typography-meta text-muted-foreground">{t('quota.magpie.unknown')}</p>}
    </>;
    return compact
      ? <section key={account.id} className="px-2 py-1">
        <p className="typography-meta font-medium text-foreground truncate oc-ui-start-align" dir="auto" title={title}>{title}</p>
        {content}
      </section>
      : <SettingsSection key={account.id} title={title}>{content}</SettingsSection>;
  });

  return rows.length > 0 ? rows : <p className="typography-meta text-muted-foreground">{t('quota.magpie.empty')}</p>;
};
