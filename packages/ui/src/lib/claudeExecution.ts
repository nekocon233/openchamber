import { runtimeFetch } from '@/lib/runtime-fetch';
import { z } from 'zod';

const preparedExecutionSchema = z.object({ prepared: z.literal(true) });

export async function prepareClaudeExecutionRequest(request: {
  sessionID: string;
  messageID: string;
  directory: string;
  executionFramework: 'opencode' | 'claude-code';
}): Promise<void> {
  const response = await runtimeFetch('/api/claude-execution/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error('Could not preserve the queued execution framework');
  preparedExecutionSchema.parse(await response.json());
}
