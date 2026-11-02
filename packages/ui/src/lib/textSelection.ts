/** A drag selecting row text must not also activate the row. */
export const hasTextSelectionWithin = (element: HTMLElement): boolean => {
  const selection = element.ownerDocument.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0
    && selection.getRangeAt(0).intersectsNode(element));
};
