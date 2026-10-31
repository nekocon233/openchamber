import { useUIStore } from '@/stores/useUIStore';
import { getDefaultContextZone } from '@/lib/workspace/zones';

export const useIsEditorWorkspaceLayout = () => useUIStore((state) => state.workspaceLayout === 'editor');

export const useDefaultContextZone = () => useUIStore((state) => getDefaultContextZone(state.workspaceLayout));

export const useTitlebarControlsOverSidebar = () => useUIStore((state) => state.isSidebarOpen && state.workspaceLayout !== 'editor');
