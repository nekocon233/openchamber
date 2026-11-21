import React from 'react';

type SessionRowMenuStateArgs = {
  menuInstanceKey: string;
  contextMenuInstanceKey: string | null;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  hasDeferredCloseWork: () => boolean;
  onCloseComplete: () => void;
};

export const useSessionRowMenuState = ({
  menuInstanceKey,
  contextMenuInstanceKey,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  hasDeferredCloseWork,
  onCloseComplete,
}: SessionRowMenuStateArgs) => {
  const [legacyContextMenuOpen, setLegacyContextMenuOpen] = React.useState(false);
  const [closeRequested, setCloseRequested] = React.useState(false);

  const isMenuOpen = openSidebarMenuKey === menuInstanceKey && !closeRequested;
  const isContextMenuOpen = contextMenuInstanceKey
    ? openSidebarMenuKey === contextMenuInstanceKey && !closeRequested
    : legacyContextMenuOpen;

  const requestClose = (instanceKey: string) => {
    if (openSidebarMenuKey !== instanceKey) return;
    if (hasDeferredCloseWork()) {
      setCloseRequested(true);
      return;
    }
    setOpenSidebarMenuKey(null);
  };

  const handleMenuOpenChange = (open: boolean) => {
    if (open) {
      setLegacyContextMenuOpen(false);
      setCloseRequested(false);
      setOpenSidebarMenuKey(menuInstanceKey);
      return;
    }
    requestClose(menuInstanceKey);
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    if (!contextMenuInstanceKey) {
      setLegacyContextMenuOpen(open);
      return;
    }
    if (open) {
      setCloseRequested(false);
      setOpenSidebarMenuKey(contextMenuInstanceKey);
      return;
    }
    requestClose(contextMenuInstanceKey);
  };

  const handleMenuOpenChangeComplete = (open: boolean) => {
    if (open) return;
    onCloseComplete();
    setCloseRequested(false);
    if (openSidebarMenuKey === menuInstanceKey || openSidebarMenuKey === contextMenuInstanceKey) {
      setOpenSidebarMenuKey(null);
    }
  };

  const toggleMenu = () => {
    setCloseRequested(false);
    setOpenSidebarMenuKey(isMenuOpen ? null : menuInstanceKey);
  };

  // Dismiss open menus when the browser window loses focus.
  // Base UI's controlled ContextMenu.Root does not fire onOpenChange(false) on
  // window blur, so the popover stays rendered while the app is in the
  // background. When the user returns, clicks outside no longer dismiss it
  // because Base UI's internal pointer tracking was reset.
  // The blur listener lives as long as a menu stays open; it reads the
  // handlers of the latest render, so a close follows current deferred work.
  const openChangeHandlersRef = React.useRef({ menu: handleMenuOpenChange, contextMenu: handleContextMenuOpenChange });
  openChangeHandlersRef.current = { menu: handleMenuOpenChange, contextMenu: handleContextMenuOpenChange };
  React.useEffect(() => {
    if (!isMenuOpen && !isContextMenuOpen) return;
    const onBlur = () => {
      if (isContextMenuOpen) {
        openChangeHandlersRef.current.contextMenu(false);
      }
      if (isMenuOpen) {
        openChangeHandlersRef.current.menu(false);
      }
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [isMenuOpen, isContextMenuOpen]);

  return {
    isMenuOpen,
    isContextMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
    toggleMenu,
  };
};
