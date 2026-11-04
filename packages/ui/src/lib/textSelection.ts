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
  element: Parameters<typeof hasTextSelectionWithin>[0],
): boolean => hasTextSelectionWithin(element);
