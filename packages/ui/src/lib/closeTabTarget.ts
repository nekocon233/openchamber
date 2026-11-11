import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';
import { isMacOS } from '@/lib/utils';

/**
 * What Cmd/Ctrl+W closes in the desktop and web app.
 *
 * A surface with a tab of its own (a file open in the editor, a terminal, a
 * browser tab) registers here; the desktop shell is told whether one is
 * registered, and while one is, the shortcut arrives as an
 * `openchamber:close-tab` event or a captured `Mod+W` keydown instead of
 * closing the window.
 *
 * The surface the user clicked or focused last wins. A surface's place is the
 * zone or editor host it sits in (`[data-context-zone], [data-file-editor]`),
 * so a click on the zone's or editor's tab strip counts as much as one in its
 * content. When places nest, such as the header's session tabs registered on
 * the whole page around a zone or editor with tabs, a click counts for the
 * innermost one.
 */
type Target = { close: () => void; area: { current: Element | null }; usedAt: number };

const targets: Target[] = [];
let clock = 0;
let listening = false;

const report = (): void => {
  if (!hasDesktopInvoke()) return;
  void invokeDesktop('desktop_set_close_tab_target', { active: targets.length > 0 });
};

const placeOf = (element: Element): Element => (
  element.closest('[data-context-zone], [data-file-editor]') ?? element
);

const markUsedForNode = (node: Node | null): void => {
  if (!node) return;
  const hits: Array<{ target: Target; place: Element }> = [];
  for (const target of targets) {
    const area = target.area.current;
    const place = area ? placeOf(area) : null;
    if (place?.contains(node)) hits.push({ target, place });
  }
  // Only the innermost places count: a click in a zone or editor with tabs goes
  // to them, not to a target around the whole page.
  for (const hit of hits) {
    const outer = hits.some((other) => other.place !== hit.place && hit.place.contains(other.place));
    if (!outer) hit.target.usedAt = ++clock;
  }
};

const handleUse = (event: Event): void => {
  const node = event.target;
  if (!(node instanceof Node)) return;
  markUsedForNode(node);
};

const handleCloseTab = (): void => {
  const activeElement = globalThis.document?.activeElement;
  if (activeElement && activeElement !== globalThis.document?.body) {
    markUsedForNode(activeElement);
  }
  let latest: Target | undefined;
  for (const target of targets) {
    if (!latest || target.usedAt > latest.usedAt) latest = target;
  }
  latest?.close();
};

const isCloseTabChord = (event: KeyboardEvent): boolean => {
  const mod = isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === 'w' || event.code === 'KeyW');
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (targets.length === 0 || !isCloseTabChord(event)) return;
  if (event.target instanceof Node) {
    markUsedForNode(event.target);
  }
  event.preventDefault();
  event.stopPropagation();
  handleCloseTab();
};

export const registerCloseTabTarget = (close: () => void, area: { current: Element | null } = { current: null }): (() => void) => {
  if (!listening) {
    window.addEventListener('openchamber:close-tab', handleCloseTab);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('pointerdown', handleUse, true);
    // `focus`, captured: a click into a browser tab's page focuses its
    // `<webview>` with a `focus` event only, no `focusin` and no pointer event.
    window.addEventListener('focus', handleUse, true);
    listening = true;
  }
  const target: Target = { close, area, usedAt: ++clock };
  targets.push(target);
  report();
  return () => {
    const index = targets.indexOf(target);
    if (index >= 0) targets.splice(index, 1);
    report();
  };
};
