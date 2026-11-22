type BuiltInQuotaProviderId =
  | 'openai'
  | 'codex'
  | 'cursor'
  | 'claude'
  | 'magpie'
  | 'cline-pass'
  | 'github-copilot'
  | 'github-copilot-addon'
  | 'google'
  | 'antigravity'
  | 'antigravity-cli'
  | 'kimi-for-coding'
  | 'nano-gpt'
  | 'openrouter'
  | 'zai-coding-plan'
  | 'zhipuai-coding-plan'
  | 'minimax-coding-plan'
  | 'minimax-cn-coding-plan'
  | 'ollama-cloud'
  | 'wafer'
  | 'opencode-go'
  | 'opencode'
  | 'deepinfra'
  | 'deepseek'
  | 'exe-dev'
  | 'hyper'
  | 'neuralwatt'
  | 'kilo'
  | 'zenmux'
  | 'xai'
  | 'mistral';

export type ExtensionQuotaProviderId = `ext-${string}`;

export type QuotaProviderId = BuiltInQuotaProviderId | ExtensionQuotaProviderId | `kimi-claude:${string}`;

export interface UsageWindowGiftReset {
  recordId: number;
  expireAt: number;
  grantType?: string;
}

export type UsageWindowValue =
  | { kind: 'requests'; count: number }
  | { kind: 'remaining'; amount: number; used?: number; unit: string }
  | { kind: 'unlimited' }
  | { kind: 'spend'; spent: number; limit: number | null };

export interface MagpieQuotaTrend {
  points: { at: number; left: number }[];
  cycle?: { start: number; reset: number };
  matchesSnapshot: boolean;
}

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  value?: UsageWindowValue;
  creditsUsed?: number;
  giftReset?: UsageWindowGiftReset | null;
  magpieTrend?: MagpieQuotaTrend | null;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

export interface ConsoleBudget {
  id: string;
  limit: number;
  spent: number;
  usedPercent: number;
  reached: boolean;
  resetsAt: number;
  sharing: 'you' | 'everyone' | 'group';
  perModel: boolean;
  kind: 'all' | 'vendors' | 'price' | 'models' | 'each';
  vendors: string[];
  models: string[];
  inputPriceAtLeast: number | null;
}

export interface ConsoleBudgets {
  workspace: string | null;
  budgets: ConsoleBudget[];
}

/** A Magpie account keeps all its windows and its own failure state. */
export interface QuotaAccount extends UsageWindows {
  id: string;
  providerId: string;
  providerName: string;
  accountLabel: string | null;
  planLabel: string | null;
  sampledAt: number | null;
  error: string | null;
  sharedBalance?: string;
}

interface ProviderUsage extends UsageWindows {
  accounts?: QuotaAccount[];
  models?: Record<string, UsageWindows>;
  consoleBudgets?: ConsoleBudgets;
}

export interface QuotaRefresh {
  state: 'fresh' | 'cached' | 'rate-limited' | 'error';
  /** Last successful upstream sample, never the time a cache entry was served. */
  sampledAt: number | null;
  /** Earliest next upstream attempt, also respected by manual refresh. */
  nextAttemptAt: number;
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  /** Whether the active runtime owns enough credential state to answer. */
  availability?: 'available' | 'unsupported';
  /** Subscription tier reported by the provider, when it exposes one. */
  planLabel?: string | null;
  accountLabel?: string | null;
  usage: ProviderUsage | null;
  fetchedAt: number;
  refresh?: QuotaRefresh;
}
