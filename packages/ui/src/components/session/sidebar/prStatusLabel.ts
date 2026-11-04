import type { useI18n } from '@/lib/i18n';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { getPrStatusLabelKey } from './sessions/sessionPrSummaries';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export function getPrStatusLabel(
  pr: PrVisualSummary | null,
  tOrTerm: TranslateFn | unknown,
  maybeT?: TranslateFn,
): string | null {
  const t = (typeof tOrTerm === 'function' ? tOrTerm : maybeT) as TranslateFn | undefined;
  if (!pr || !t) return null;
  const labelKey = getPrStatusLabelKey(pr);
  if (!labelKey) return null;
  const label = t(changeRequestCopy(labelKey, pr.provider));
  return labelKey === 'sessions.sidebar.group.pr.status.mergeConflicts' && pr.checks?.state === 'failure'
    ? `${label} · ${t(changeRequestCopy('chat.chatInput.prCheckContext', pr.provider))}`
    : label;
}
