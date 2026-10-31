import { create } from 'zustand';

/** Full-page views cover both the conversation and its bottom tool zone. */
export const useChatCoverageStore = create<{ covered: boolean }>(() => ({ covered: false }));

export const setChatCovered = (covered: boolean): void => {
  if (useChatCoverageStore.getState().covered !== covered) useChatCoverageStore.setState({ covered });
};
