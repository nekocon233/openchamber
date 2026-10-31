import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { editorWidthForRatio, EDITOR_MIN_WIDTH, CHAT_MIN_WIDTH } from '@/lib/workspace/editorSplit';
import { useUIStore } from '@/stores/useUIStore';
import { setEditorHost } from './workspaceHosts';

/** The fixed editor and chat share the width left by the docked tools. */
export const EditorWorkspaceColumns: React.FC<{ enabled: boolean; children: React.ReactNode }> = ({ enabled, children }) => {
  const { t, direction } = useI18n();
  const ratio = useUIStore((state) => state.editorChatSplitRatio);
  const columns = React.useRef<HTMLDivElement | null>(null);
  const editor = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ pointer: number; x: number; width: number; next: number } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const available = React.useRef(0);
  const [width, setWidth] = React.useState(0);
  const [resizing, setResizing] = React.useState(false);

  const applyWidth = React.useCallback((value: number) => {
    if (editor.current) editor.current.style.width = `${value}px`;
  }, []);

  React.useLayoutEffect(() => {
    if (!enabled || !columns.current) return;
    const row = columns.current;
    const right = row.querySelector<HTMLElement>('[data-context-zone="right"]');
    const measure = () => {
      const rightWidth = right && getComputedStyle(right).position !== 'absolute' ? right.clientWidth : 0;
      available.current = row.clientWidth - rightWidth;
      if (drag.current) return;
      const next = editorWidthForRatio(available.current, ratio);
      applyWidth(next);
      setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    if (right) observer.observe(right);
    return () => observer.disconnect();
  }, [applyWidth, enabled, ratio]);

  const finish = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const active = drag.current;
    drag.current = null;
    if (!active) return;
    applyWidth(active.next);
    setWidth(active.next);
    setResizing(false);
    if (available.current > 0) useUIStore.getState().setEditorChatSplitRatio(active.next / available.current);
  }, [applyWidth]);

  React.useEffect(() => {
    if (!resizing) return;
    window.addEventListener('blur', finish);
    return () => window.removeEventListener('blur', finish);
  }, [finish, resizing]);
  React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  return <div ref={columns} data-workspace-columns="true" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
    <div ref={editor} data-workspace-editor="true" className={cn('relative h-full shrink-0 px-0.5 pb-1', !enabled && 'hidden')} style={{ width: enabled ? width : 0 }}>
      <div ref={setEditorHost} className="h-full min-h-0 min-w-0" />
      {enabled && <div
        role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('workspace.resizeEditorChat')}
        aria-valuemin={EDITOR_MIN_WIDTH} aria-valuemax={Math.max(EDITOR_MIN_WIDTH, Math.round(available.current - CHAT_MIN_WIDTH))} aria-valuenow={Math.round(width)}
        className="absolute inset-e-0 inset-y-0 z-20 w-[5px] cursor-col-resize rounded focus-visible:outline-none focus-visible:bg-[var(--interactive-border)] hover:bg-[var(--interactive-border)]/50"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const current = editor.current?.clientWidth ?? width;
          drag.current = { pointer: event.pointerId, x: event.clientX, width: current, next: current };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.pointer !== event.pointerId) return;
          const delta = (event.clientX - active.x) * (direction === 'rtl' ? -1 : 1);
          active.next = editorWidthForRatio(available.current, (active.width + delta) / available.current);
          // Match panel resizing: bound transcript remeasurement during a drag.
          if (timer.current === null) timer.current = setTimeout(() => {
            timer.current = null;
            if (drag.current) applyWidth(drag.current.next);
          }, 100);
        }}
        onPointerUp={finish} onPointerCancel={finish}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const delta = (event.key === 'ArrowRight' ? 20 : -20) * (direction === 'rtl' ? -1 : 1);
          const target = event.key === 'Home' ? EDITOR_MIN_WIDTH : event.key === 'End' ? available.current - CHAT_MIN_WIDTH : width + delta;
          const next = editorWidthForRatio(available.current, target / available.current);
          useUIStore.getState().setEditorChatSplitRatio(next / available.current);
        }}
      />}
    </div>
    {children}
  </div>;
};
