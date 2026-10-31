import { describe, expect, test } from 'bun:test';
import { pickUsageHeadline, resolveQuotaProviderId } from './usageHeadline';
import type { UsageProviderGroup } from '@/components/usage/usageGroups';

const HOUR = 3600;

const window = (windowSeconds: number | null) => ({
  usedPercent: 10,
  remainingPercent: 90,
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const group = (providerId: UsageProviderGroup['providerId'], rows: Array<{ key: string; label: string; subtitle?: string; seconds: number | null }>): UsageProviderGroup => ({
  providerId,
  providerName: providerId,
  status: null,
  rows: rows.map((row) => ({
    key: row.key,
    label: row.label,
    subtitle: row.subtitle,
    window: window(row.seconds),
  })),
});

describe('resolveQuotaProviderId', () => {
  test('passes through ids that already match a quota provider', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
  });

  test('maps the known divergences', () => {
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
    expect(resolveQuotaProviderId('kilocode')).toBe('kilo');
    expect(resolveQuotaProviderId('kilo-code')).toBe('kilo');
  });

  test('maps the native CLI providers onto their subscriptions', () => {
    expect(resolveQuotaProviderId('claude-native')).toBe('claude');
    expect(resolveQuotaProviderId('codex-native')).toBe('codex');
  });

  test('is case and whitespace tolerant, and rejects empties', () => {
    expect(resolveQuotaProviderId('  OpenAI ')).toBe('codex');
    expect(resolveQuotaProviderId('')).toBeNull();
    expect(resolveQuotaProviderId(null)).toBeNull();
  });
});

describe('pickUsageHeadline', () => {
  test('matches the native Antigravity family without borrowing Claude subscription quota', () => {
    const groups = [group('antigravity-cli', [
      { key: 'gw', label: 'Weekly', subtitle: 'Gemini', seconds: 7 * 24 * HOUR },
      { key: 'gh', label: 'Gemini 5h', subtitle: 'Gemini', seconds: 5 * HOUR },
      { key: 'ch', label: 'Claude 5h', subtitle: 'Claude / GPT', seconds: 5 * HOUR },
    ])];
    expect(pickUsageHeadline(groups, 'antigravity-native', 'gemini-4-argon-high')?.row.key).toBe('gh');
    expect(pickUsageHeadline(groups, 'antigravity-native', 'claude-opus-5-5-high')?.row.key).toBe('ch');
    expect(pickUsageHeadline(groups, 'antigravity-native', 'unknown-model')).toBeNull();
    expect(pickUsageHeadline(groups, 'claude-native', 'connection:gateway:claude')).toBeNull();
  });
  const groups = [
    group('codex', [{ key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR }]),
    group('opencode-go', [
      { key: 'm', label: 'Monthly Limit', seconds: 30 * 24 * HOUR },
      { key: 'h', label: '5-Hour', seconds: 5 * HOUR },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ]),
  ];

  test('picks the shortest window of the matching provider', () => {
    // The tightest bucket is the one that decides whether the next turn lands.
    expect(pickUsageHeadline(groups, 'opencode-go')?.row.label).toBe('5-Hour');
  });

  test('resolves the provider through the alias table', () => {
    expect(pickUsageHeadline(groups, 'openai')?.group.providerId).toBe('codex');
  });

  test('returns null when no group matches the composer provider', () => {
    // Showing another provider's quota would read as the active one.
    expect(pickUsageHeadline(groups, 'mistral')).toBeNull();
    expect(pickUsageHeadline(groups, null)).toBeNull();
  });

  test('ignores model-scoped rows while any provider-level row exists', () => {
    const scoped = [group('zai-coding-plan', [
      { key: 'model', label: '5-Hour', subtitle: 'GLM-5', seconds: 5 * HOUR },
      { key: 'provider', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(scoped, 'zai-coding-plan')?.row.label).toBe('Weekly Limit');
  });

  test('falls back to a durationless row when nothing reports a window', () => {
    const balances = [group('codex', [{ key: 'credits', label: 'Credits Balance', seconds: null }])];
    expect(pickUsageHeadline(balances, 'codex')?.row.label).toBe('Credits Balance');
  });

  test('prefers any real window over a durationless row', () => {
    const mixed = [group('codex', [
      { key: 'credits', label: 'Credits Balance', seconds: null },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(mixed, 'codex')?.row.label).toBe('Weekly Limit');
  });

  test('returns null for a matched provider that reported no rows', () => {
    expect(pickUsageHeadline([group('codex', [])], 'codex')).toBeNull();
  });
});


test('managed connections never show the default Claude or Codex account quota', () => {
  expect(resolveQuotaProviderId('claude-native', 'connection:account:model')).toBe('kimi-claude:account');
  expect(pickUsageHeadline([], 'claude-native', 'connection:account:model')).toBeNull();
});


test('selects the exact Kimi connection instead of either other account', () => {
  const claude = group('claude', [{ key: 'claude', label: 'Claude', seconds: 18000 }]);
  const opencode = group('kimi-for-coding', [{ key: 'opencode', label: 'OpenCode', seconds: 18000 }]);
  const native = group('kimi-claude:account', [{ key: 'native', label: 'Native', seconds: 18000 }]);
  expect(pickUsageHeadline([claude, opencode, native], 'claude-native', 'connection:account:model')?.group).toBe(native);
  expect(pickUsageHeadline([claude, opencode], 'claude-native', 'connection:account:model')).toBeNull();
});
