/** A drag selecting row text must not also activate the row. */
export const hasTextSelectionWithin = (
  element: { contains?: (node: Node | null) => boolean; ownerDocument?: Document | null } | HTMLElement | null | undefined,
): boolean => {
  if (!element || !('ownerDocument' in element) || !element.ownerDocument) return false;
  const selection = element.ownerDocument.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0
    && selection.getRangeAt(0).intersectsNode(element as Node));
};

export const hasTextSelectionInside = (
  container: { contains: (node: Node | null) => boolean } | null | undefined,
): boolean => {
  if (!container) {
    return false;
  }

  const selection = globalThis.window?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  return container.contains(range.startContainer) || container.contains(range.endContainer);
};
