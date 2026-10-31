import { create } from 'zustand';

/** Fixed hosts in the editor workspace. These are not draggable tool zones. */
export const useWorkspaceHosts = create<{
  editor: HTMLElement | null;
  chatHeader: HTMLElement | null;
}>(() => ({ editor: null, chatHeader: null }));

export const setEditorHost = (editor: HTMLElement | null): void => {
  useWorkspaceHosts.setState({ editor });
};

export const setChatHeaderHost = (chatHeader: HTMLElement | null): void => {
  useWorkspaceHosts.setState({ chatHeader });
};
