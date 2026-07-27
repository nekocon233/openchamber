import type { FollowUpQueueAPI } from '@openchamber/ui/lib/api/types';

export const createVSCodeFollowUpQueueAPI = (): FollowUpQueueAPI => ({
  supported: false,
  load: async () => null,
  mutate: async () => null,
});
