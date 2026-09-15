import os from 'os';
import path from 'path';

import { readAuthFile } from '../../opencode/auth.js';
import {
  asNonEmptyString,
  asObject,
  getAuthEntry,
  normalizeAuthEntry,
  readJsonFile,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  formatMoney
} from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'Codex';
const aliases = ['openai', 'codex', 'chatgpt'];

const codexHomeDirectory = () => {
  const override = asNonEmptyString(process.env.CODEX_HOME);
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex');
};

/**
 * Credentials the Codex CLI wrote for itself.
 *
 * The CLI owns its own sign-in, and the opencode-codex plugin deliberately
 * stores nothing in OpenCode's auth file — so a user signed in through the CLI
 * has no OpenCode entry to read, and without this source their quota would
 * report "not configured" while Codex works fine.
 *
 * Read fresh per request: the CLI rewrites this file whenever it refreshes, so
 * a cached token would outlive the record it came from.
 */
const readCodexCliCredential = () => {
  const tokens = asObject(asObject(readJsonFile(path.join(codexHomeDirectory(), 'auth.json')))?.tokens);
  const accessToken = asNonEmptyString(tokens?.access_token);
  if (!accessToken) return null;
  return { accessToken, accountId: asNonEmptyString(tokens.account_id) };
};

/**
 * OpenCode's own entry wins: that is the account OpenCode itself signs requests
 * with, so reporting the CLI's quota over it would describe the wrong session.
 */
const loadCodexCredential = () => {
  const entry = normalizeAuthEntry(getAuthEntry(readAuthFile(), aliases));
  const accessToken = asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  if (accessToken) return { accessToken, accountId: asNonEmptyString(entry.accountId) };
  return readCodexCliCredential();
};

export const isConfigured = () => Boolean(loadCodexCredential());

export const fetchQuota = async () => {
  const credential = loadCodexCredential();
  const accessToken = credential?.accessToken;
  const accountId = credential?.accountId;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {})
    };
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired \u2014 please re-authenticate with OpenAI'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at)
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at)
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const label = unlimited
        ? 'Unlimited'
        : balance !== null
          ? `$${formatMoney(balance)}`
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label
      });
    }

    // Business/enterprise accounts expose a dollar spend cap under
    // `spend_control.individual_limit`. Surface it as an additive `credits`
    // window so existing consumers keep working.
    if (payload?.spend_control?.individual_limit) {
      const spendLimit = payload.spend_control.individual_limit;
      const used = toNumber(spendLimit.used);
      const limit = toNumber(spendLimit.limit);
      const valueLabel = used !== null && limit !== null
        ? `${used.toFixed(0)} / ${limit.toFixed(0)} used`
        : null;
      windows.credits = toUsageWindow({
        usedPercent: toNumber(spendLimit.used_percent),
        windowSeconds: null,
        resetAt: null,
        valueLabel
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
