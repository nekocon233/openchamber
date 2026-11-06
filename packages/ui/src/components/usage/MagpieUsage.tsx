import type { QuotaAccount } from '@/types/quota';
import { useI18n } from '@/lib/i18n';
import { formatMagpieError } from '@/lib/quota/magpie';
import { formatQuotaResetLabel, formatQuotaWindowValueLabel, formatWindowLabel } from '@/lib/quota';
import { useUIStore } from '@/stores/useUIStore';
import { UsageCard } from '@/components/sections/usage/UsageCard';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { WorkStatusRow, WorkStatusValue } from '@/components/chat/work-status/WorkStatusPrimitives';

/** The same account/window hierarchy serves Settings, work status, and VS Code. */
export const MagpieUsage = ({ accounts, compact = false }: { accounts: QuotaAccount[]; compact?: boolean }) => {
  const { t } = useI18n();
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  if (accounts.length === 0) return <p className="typography-meta text-muted-foreground">{t('quota.magpie.empty')}</p>;

  return accounts.map(account => {
    const title = [account.providerName, account.accountLabel, account.planLabel].filter(Boolean).join(' · ');
    const content = <>
      {account.error && <p role="status" className="typography-meta text-[var(--status-warning-text)] break-words">{formatMagpieError(account.error, t)}</p>}
      {account.sharedBalance && <p className="typography-meta text-muted-foreground break-words">{t('quota.magpie.sharedBalance', { account: account.sharedBalance })}</p>}
      {Object.entries(account.windows).map(([label, window]) => {
        if (!compact) return <UsageCard key={label} title={label} window={window} displayMode="remaining" />;
        const metric = formatQuotaWindowValueLabel(window, window.remainingPercent, t);
        const reset = formatQuotaResetLabel(window.resetAt, null, timeFormat);
        const used = window.usedPercent;
        const tone = used !== null && used >= 80 ? 'error' : used !== null && used >= 50 ? 'warning' : 'default';
        return <WorkStatusRow key={label}
          label={<span className="inline-flex min-w-0 items-baseline gap-1.5"><span dir="auto" className="truncate oc-ui-start-align" title={formatWindowLabel(label)}>{formatWindowLabel(label)}</span>
            {reset && <span className="shrink-0 typography-micro text-muted-foreground">{reset}</span>}</span>}
          value={<WorkStatusValue tone={tone}><span dir="auto">{metric === '-' ? t('quota.magpie.unknown') : metric}</span></WorkStatusValue>}
        />;
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
};
