import { expect, test } from 'bun:test';
import { createVSCodeNativeAgentsAPI } from './nativeAgents';
import { NativeAgentsUnsupportedError } from '@openchamber/ui/lib/native-agents/errors';

test('native statistics are explicitly unsupported in VS Code', async () => {
  const api = createVSCodeNativeAgentsAPI();
  expect(api.supported).toBe(false);
  await expect(api.stats({ to: 100, timezone: 'UTC', tools: 'none' })).rejects.toBeInstanceOf(NativeAgentsUnsupportedError);
});
