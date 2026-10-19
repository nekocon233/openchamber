import { findClaudeCredential, loadClaudeCredential } from './auth.js';
import { createClaudeQuotaTracker } from './tracker.js';

export const providerId = 'claude';
export const providerName = 'Claude';

const trackers = new Map();

export const isConfigured = (auth) => Boolean(findClaudeCredential(auth));

export const fetchQuota = (cacheScope = 'web') => {
  let tracker = trackers.get(cacheScope);
  if (!tracker) {
    tracker = createClaudeQuotaTracker({ cacheScope, loadCredential: loadClaudeCredential });
    trackers.set(cacheScope, tracker);
  }
  return tracker.fetchQuota();
};

/** Clears memory; durable snapshots belong to each runtime scope. */
export const resetClaudeQuotaCache = () => {
  for (const tracker of trackers.values()) tracker.reset();
  trackers.clear();
};
