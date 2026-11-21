import type { UsageProviderGroup, UsageLimitRow } from '@/components/usage/usageGroups';


/**
 * Quota provider ids mostly match OpenCode provider ids; these are the ones
 * that do not. Unmatched providers simply produce no headline.
 *
 * `claude-code` is the provider the opencode-claude integration registers, and
 * it bills against the same Claude subscription the `claude` quota reports.
 * The native CLI providers bill against their CLI's subscription the same way,
 * unless a managed connection gives them their own billing identity.
 * `kilocode` / `kilo-code` are the same Kilo Gateway account as `kilo`.
 */
const QUOTA_PROVIDER_ALIASES = new Map<string, string>([
  ['openai', 'codex'],
  ['chatgpt', 'codex'],
  ['anthropic', 'claude'],
  ['claude-agent', 'claude'],
  ['claude-code', 'claude'],
  ['claude-native', 'claude'],
  ['codex-native', 'codex'],
  ['antigravity-native', 'antigravity-cli'],
  ['gemini', 'google'],
  ['kilocode', 'kilo'],
  ['kilo-code', 'kilo'],
]);

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

export const resolveQuotaProviderId = (modelProviderId: string | null | undefined, modelId?: string | null): string | null => {
  const normalized = normalize(modelProviderId);
  if (!normalized) return null;
  if (normalized === 'claude-native' && modelId?.startsWith('connection:')) {
    const connectionId = modelId.split(':')[1];
    return connectionId ? `kimi-claude:${connectionId}` : null;
  }
  return QUOTA_PROVIDER_ALIASES.get(normalized) ?? normalized;
};

export const pickUsageHeadline = (
  groups: readonly UsageProviderGroup[],
  modelProviderId: string | null | undefined,
  modelId?: string | null,
): { group: UsageProviderGroup; row: UsageLimitRow } | null => {
  const quotaProviderId = resolveQuotaProviderId(modelProviderId, modelId);
  if (!quotaProviderId) return null;
  // Magpie chooses its upstream account at request time; its account list
  // cannot identify the account that will handle the composer's next turn.
  if (quotaProviderId === 'magpie') return null;

  const group = groups.find((candidate) => normalize(candidate.providerId) === quotaProviderId);
  if (!group || group.rows.length === 0) return null;

  const providerRows = group.rows.filter((row) => !row.subtitle);
  let rows = providerRows.length > 0 ? providerRows : group.rows;
  if (quotaProviderId === 'antigravity-cli') {
    const family = modelId?.startsWith('gemini-') ? 'Gemini'
      : modelId?.startsWith('claude-') || modelId?.startsWith('gpt-') ? 'Claude / GPT' : null;
    rows = rows.filter((row) => family !== null && row.subtitle === family);
    if (rows.length === 0) return null;
  }

  let best: UsageLimitRow | null = null;
  let bestSeconds = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const seconds = row.window.windowSeconds;
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) continue;
    if (seconds < bestSeconds) {
      best = row;
      bestSeconds = seconds;
    }
  }

  return { group, row: best ?? rows[0] };
};
