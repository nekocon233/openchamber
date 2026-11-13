import { create } from 'zustand';

/** Fixed hosts in the workspace chrome. These are not draggable tool zones. */
export const useWorkspaceHosts = create<{
  editor: HTMLElement | null;
  chatHeader: HTMLElement | null;
  guestPageHeader: HTMLElement | null;
}>(() => ({ editor: null, chatHeader: null, guestPageHeader: null }));

export const setEditorHost = (editor: HTMLElement | null): void => {
  useWorkspaceHosts.setState({ editor });
};

export const setChatHeaderHost = (chatHeader: HTMLElement | null): void => {
  useWorkspaceHosts.setState({ chatHeader });
};

export const setGuestPageHeaderHost = (guestPageHeader: HTMLElement | null): void => {
  useWorkspaceHosts.setState({ guestPageHeader });
};
