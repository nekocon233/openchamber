export type WorkspaceLayout = 'classic' | 'editor';

// The session toolbar needs at least 264 px; the initial width is 280 px.
export const clampSidebarWidth = (width: number): number => Math.min(500, Math.max(264, width));

export const getSidebarWidth = (savedWidth: number): number => clampSidebarWidth(savedWidth || 280);

