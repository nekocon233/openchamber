import { useUIStore } from '@/stores/useUIStore';

// Whether the isolated-spaces feature is released to users. The feature is built, on local
// Docker, and stays hidden until the maintainers decide to show it (decision 17 in
// packages/web/server/lib/spaces/DOCUMENTATION.md). Flip this to show it; nothing else needs to
// change.
const ISOLATED_SPACES_RELEASED = false;

export const isIsolatedSpacesPageVisible = (): boolean =>
  ISOLATED_SPACES_RELEASED || useUIStore.getState().isolatedSpacesEnabled;
