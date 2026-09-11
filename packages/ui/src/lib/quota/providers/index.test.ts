import { describe, expect, test } from 'bun:test';

import { QUOTA_PROVIDERS } from './index';

describe('quota provider catalog', () => {
  test('does not expose the removed xAI quota provider', () => {
    expect(QUOTA_PROVIDERS.map((provider) => provider.id)).not.toContain('xai');
  });
});
