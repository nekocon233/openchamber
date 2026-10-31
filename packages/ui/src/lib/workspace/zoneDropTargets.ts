export type ZoneRect = { left: number; top: number; width: number; height: number };
export type ZoneDropTargets = { left: ZoneRect; right: ZoneRect; bottom: ZoneRect };
export type ZonePoint = { x: number; y: number };

const SIDE_TARGET_MAX = 280;
const SIDE_TARGET_SHARE = 0.28;
const BOTTOM_TARGET_MAX = 240;
const BOTTOM_TARGET_SHARE = 0.35;

/**
 * Where a dragged surface can land, from rects measured once when the drag
 * starts: the workspace row (left zone, chat column, right slot), the chat
 * column (the chat and the bottom zone under it) and the open bottom zone's
 * card, if any.
 *
 * The bottom target is the open bottom zone, or the lower band of the chat,
 * across the chat column's full width. A side target is a full-height column
 * over whatever stands on its side of the chat (an open zone, the work-status
 * card); with nothing there, it is a strip of the chat's edge that stops
 * above the bottom target. No two targets overlap.
 */
export const computeZoneDropTargets = (
  row: ZoneRect,
  chatColumn: ZoneRect,
  bottomZone: ZoneRect | null = null,
  isRtl = false,
  editorColumn: ZoneRect | null = null,
): ZoneDropTargets => {
  // The measured row starts after navigation and the rail in both layouts.
  const rowLeft = row.left;
  const rowRight = row.left + row.width;
  const chatRight = chatColumn.left + chatColumn.width;
  const coreLeft = editorColumn ? Math.min(chatColumn.left, editorColumn.left) : chatColumn.left;
  const coreRight = editorColumn ? Math.max(chatRight, editorColumn.left + editorColumn.width) : chatRight;
  const chatBottom = chatColumn.top + chatColumn.height;
  const bottomTop = bottomZone
    ? bottomZone.top
    : chatBottom - Math.min(BOTTOM_TARGET_MAX, chatColumn.height * BOTTOM_TARGET_SHARE);
  // A strip taken from the chat itself stays narrow beside a narrow chat.
  const strip = Math.min(SIDE_TARGET_MAX, (rowRight - rowLeft) * SIDE_TARGET_SHARE, chatColumn.width / 4);
  const leftOccupied = coreLeft - rowLeft >= 1;
  const rightOccupied = rowRight - coreRight >= 1;
  const stripHeight = Math.max(0, bottomTop - row.top);
  const leftLeft = leftOccupied ? rowLeft : coreLeft;
  const leftRight = leftOccupied ? coreLeft : coreLeft + strip;
  const rightLeft = rightOccupied ? coreRight : coreRight - strip;
  const rightRight = rightOccupied ? rowRight : coreRight;
  const left = { left: leftLeft, top: row.top, width: leftRight - leftLeft, height: leftOccupied ? row.height : stripHeight };
  const right = { left: rightLeft, top: row.top, width: rightRight - rightLeft, height: rightOccupied ? row.height : stripHeight };
  return {
    left: isRtl ? right : left,
    right: isRtl ? left : right,
    bottom: { left: chatColumn.left, top: bottomTop, width: chatColumn.width, height: Math.max(0, chatBottom - bottomTop) },
  };
};

const contains = (rect: ZoneRect, point: ZonePoint): boolean => (
  point.x >= rect.left && point.x < rect.left + rect.width
  && point.y >= rect.top && point.y < rect.top + rect.height
);

/** The target under the pointer, if any. */
export const hitTestZoneDropTargets = (targets: ZoneDropTargets, point: ZonePoint): keyof ZoneDropTargets | null => {
  if (contains(targets.bottom, point)) return 'bottom';
  if (contains(targets.left, point)) return 'left';
  if (contains(targets.right, point)) return 'right';
  return null;
};
