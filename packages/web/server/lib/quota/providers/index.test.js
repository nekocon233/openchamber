import { describe, expect, it } from 'vitest';

import * as google from './google/index.js';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './index.js';

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('can list configured providers without missing provider exports', () => {
    expect(() => listConfiguredQuotaProviders()).not.toThrow();
  });

  it('treats the removed xAI quota provider as unsupported', async () => {
    expect(listConfiguredQuotaProviders()).not.toContain('xai');

    await expect(fetchQuotaForProvider('xai')).resolves.toMatchObject({
      providerId: 'xai',
      providerName: 'xai',
      ok: false,
      configured: false,
      usage: null,
      error: 'Unsupported provider'
    });
  });

  it('coalesces concurrent refreshes by provider ID', async () => {
    const first = fetchQuotaForProvider('unsupported-test-provider');
    const second = fetchQuotaForProvider('unsupported-test-provider');

    expect(first).toBe(second);
    await first;
    expect(fetchQuotaForProvider('unsupported-test-provider')).not.toBe(first);
  });
});
