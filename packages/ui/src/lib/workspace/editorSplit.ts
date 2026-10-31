export const EDITOR_MIN_WIDTH = 320;
export const CHAT_MIN_WIDTH = 400;
export const EDITOR_WORKSPACE_MIN_WIDTH = EDITOR_MIN_WIDTH + CHAT_MIN_WIDTH;

export const editorWidthForRatio = (available: number, ratio: number): number =>
  Math.max(0, Math.min(Math.max(EDITOR_MIN_WIDTH, available * ratio), available - CHAT_MIN_WIDTH));

export const validEditorSplitRatio = (ratio: number): boolean => Number.isFinite(ratio) && ratio > 0 && ratio < 1;
