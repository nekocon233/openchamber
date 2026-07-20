import type { SidebarStateAPI } from '@openchamber/ui/lib/api/types';

export const createVSCodeSidebarStateAPI = (): SidebarStateAPI => ({
  supported: false,
  load: async () => null,
  mutate: async () => null,
});
