import { create } from 'zustand';

type EditorCursorStop = {
  path: string;
  line: number;
  column: number;
};

type DirectoryHistory = {
  backStack: EditorCursorStop[];
  forwardStack: EditorCursorStop[];
};

const MAX_HISTORY_ENTRIES = 50;

const sameStop = (a: EditorCursorStop | undefined, b: EditorCursorStop): boolean => (
  Boolean(a && a.path === b.path && a.line === b.line)
);

type EditorNavigationState = {
  byDirectory: Record<string, DirectoryHistory>;
  recordJump: (directory: string, from: EditorCursorStop, to: EditorCursorStop) => void;
  stepBack: (directory: string, current?: EditorCursorStop | null) => EditorCursorStop | null;
  stepForward: (directory: string, current?: EditorCursorStop | null) => EditorCursorStop | null;
  clearDirectory: (directory: string) => void;
};

const EMPTY_HISTORY: DirectoryHistory = { backStack: [], forwardStack: [] };

export const useEditorNavigationStore = create<EditorNavigationState>((set, get) => ({
  byDirectory: {},

  recordJump: (directory, from, to) => {
    const key = directory.trim();
    if (!key || !from.path || !to.path || sameStop(from, to)) return;
    set((state) => {
      const current = state.byDirectory[key] ?? EMPTY_HISTORY;
      const prevTop = current.backStack[current.backStack.length - 1];
      const nextBack = sameStop(prevTop, from)
        ? current.backStack
        : [...current.backStack, from].slice(-MAX_HISTORY_ENTRIES);
      return {
        byDirectory: {
          ...state.byDirectory,
          [key]: {
            backStack: nextBack,
            forwardStack: [],
          },
        },
      };
    });
  },

  stepBack: (directory, current) => {
    const key = directory.trim();
    if (!key) return null;
    const history = get().byDirectory[key];
    if (!history || history.backStack.length === 0) return null;

    const target = history.backStack[history.backStack.length - 1];
    const nextBack = history.backStack.slice(0, -1);
    const prevForwardTop = history.forwardStack[history.forwardStack.length - 1];
    const nextForward = current && current.path && !sameStop(prevForwardTop, current)
      ? [...history.forwardStack, current].slice(-MAX_HISTORY_ENTRIES)
      : history.forwardStack;

    set((state) => ({
      byDirectory: {
        ...state.byDirectory,
        [key]: {
          backStack: nextBack,
          forwardStack: nextForward,
        },
      },
    }));
    return target;
  },

  stepForward: (directory, current) => {
    const key = directory.trim();
    if (!key) return null;
    const history = get().byDirectory[key];
    if (!history || history.forwardStack.length === 0) return null;

    const target = history.forwardStack[history.forwardStack.length - 1];
    const nextForward = history.forwardStack.slice(0, -1);
    const prevBackTop = history.backStack[history.backStack.length - 1];
    const nextBack = current && current.path && !sameStop(prevBackTop, current)
      ? [...history.backStack, current].slice(-MAX_HISTORY_ENTRIES)
      : history.backStack;

    set((state) => ({
      byDirectory: {
        ...state.byDirectory,
        [key]: {
          backStack: nextBack,
          forwardStack: nextForward,
        },
      },
    }));
    return target;
  },

  clearDirectory: (directory) => {
    const key = directory.trim();
    if (!key) return;
    set((state) => {
      if (!state.byDirectory[key]) return state;
      const next = { ...state.byDirectory };
      delete next[key];
      return { byDirectory: next };
    });
  },
}));
