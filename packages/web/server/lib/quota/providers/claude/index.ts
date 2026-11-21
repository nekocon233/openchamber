import type { LegacyAuthFile } from '../../../opencode/auth.js';
import { findClaudeCredential, loadClaudeCredential } from './auth.js';
import { createClaudeQuotaTracker } from './tracker.js';
import type { ClaudeQuotaTracker } from './tracker.js';

export const providerId = 'claude';
export const providerName = 'Claude';

const trackers = new Map<string, ClaudeQuotaTracker>();

export const isConfigured = (auth: LegacyAuthFile) => Boolean(findClaudeCredential(auth));

const trackerFor = (cacheScope: string): ClaudeQuotaTracker => {
  let tracker = trackers.get(cacheScope);
  if (!tracker) {
    tracker = createClaudeQuotaTracker({ cacheScope, loadCredential: loadClaudeCredential });
    trackers.set(cacheScope, tracker);
  }
  return tracker;
};

export const fetchQuota = (cacheScope = 'web') => trackerFor(cacheScope).fetchQuota();
export const readCachedQuota = (cacheScope = 'web') => trackerFor(cacheScope).readCachedQuota();

export const resetClaudeQuotaCache = () => {
  for (const tracker of trackers.values()) tracker.reset();
  trackers.clear();
};
