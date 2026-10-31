import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import type { FileEditorHandle } from '@/components/views/FilesView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { resolveZoneActiveTab, zoneOfMode } from '@/lib/workspace/zones';
import { getEditorDiffTabState } from '@/lib/workspace/editorTabs';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { MovablePane } from './MovablePane';
import { useDefaultContextZone, useIsEditorWorkspaceLayout } from './workspaceLayout';
import { useWorkspaceHosts } from './workspaceHosts';

const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));

/** One editor instance moves between the classic file panel and the fixed workspace column. */
export const FileEditorPane: React.FC<{
  directoryKey: string;
  classicHost: HTMLElement | null;
  classicVisible: boolean;
  onDiffHostChange: (host: HTMLDivElement | null) => void;
}> = ({ directoryKey, classicHost, classicVisible, onDiffHostChange }) => {
  const { t, direction } = useI18n();
  const editorLayout = useIsEditorWorkspaceLayout();
  const residentHost = useWorkspaceHosts((state) => state.editor);
  const panel = useUIStore((state) => state.contextPanelByDirectory[directoryKey]);
  const placement = useUIStore((state) => state.contextSurfaceZones);
  const defaultZone = useDefaultContextZone();
  const selectedPath = useFilesViewTabsStore((state) => state.byRoot[directoryKey]?.selectedPath ?? null);
  const editorRef = React.useRef<FileEditorHandle | null>(null);
  const files = React.useMemo(() => panel?.tabs.filter((tab) => tab.mode === 'file' && tab.targetPath) ?? [], [panel?.tabs]);
  const diffState = getEditorDiffTabState(panel, placement, defaultZone);
  const showsDiff = editorLayout && diffState === 'active';
  const tabs = panel?.tabs.filter((tab) => tab.mode === 'file' && tab.targetPath || tab.mode === 'diff' && diffState !== 'closed') ?? [];
  const [loaded, setLoaded] = React.useState(files.length > 0);
  if (files.length > 0 && !loaded) setLoaded(true);

  React.useEffect(() => {
    if (!editorLayout || !directoryKey || files.some((tab) => tab.targetPath === selectedPath)) return;
    const recent = files.reduce<(typeof files)[number] | null>((best, tab) => !best || tab.touchedAt >= best.touchedAt ? tab : best, null);
    const active = panel ? resolveZoneActiveTab(panel, placement, zoneOfMode(placement, 'file', defaultZone), defaultZone) : null;
    const path = active?.mode === 'file' && active.targetPath ? active.targetPath : recent?.targetPath ?? null;
    if (selectedPath !== path) {
      useFilesViewTabsStore.getState().setSelectedPath(directoryKey, path, { allowOutsideRoot: true });
    }
  }, [defaultZone, directoryKey, editorLayout, files, panel, placement, selectedPath]);

  const closeTabs = (ids: readonly string[]) => {
    if (tabs.some((tab) => tab.mode === 'diff' && ids.includes(tab.id))) {
      useUIStore.getState().setEditorDiffTabState(directoryKey, 'closed');
    }
    const paths = files.filter((tab) => ids.includes(tab.id)).flatMap((tab) => tab.targetPath ? [tab.targetPath] : []);
    // The editor asks about unsaved changes before the host removes any tabs.
    if (editorRef.current) editorRef.current.requestCloseFiles(paths);
    else useUIStore.getState().closeContextPanelTabs(directoryKey, files.filter((tab) => ids.includes(tab.id)).map((tab) => tab.id));
  };
  const onCloseFile = React.useCallback((path: string) => {
    useUIStore.getState().closeContextFile(directoryKey, path);
  }, [directoryKey]);
  React.useEffect(() => {
    if (!showsDiff) return;
    return registerCloseTabTarget(() => useUIStore.getState().setEditorDiffTabState(directoryKey, 'closed'));
  }, [directoryKey, showsDiff]);

  return (
    <MovablePane host={editorLayout ? residentHost : classicHost}>
      <section data-file-editor="true" className={cn('relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background', editorLayout && 'oc-panel-edge rounded-[10px]')}>
        {editorLayout && <header className="flex min-h-10 shrink-0 items-stretch border-b border-border">
          {tabs.length > 0 ? <SortableTabsStrip
            items={tabs.map((tab) => {
              const label = tab.mode === 'diff' ? t('contextPanel.mode.diff') : tab.label || tab.targetPath?.split('/').at(-1) || t('contextPanel.mode.files');
              return { id: tab.id, label, title: tab.targetPath ?? label, preview: tab.preview,
                icon: tab.mode === 'diff' ? <DiffViewIcon className="h-3.5 w-3.5" /> : <FileTypeIcon filePath={tab.targetPath ?? ''} className="h-3.5 w-3.5" />,
                closeLabel: t('contextPanel.tab.closeTabAria', { label }) };
            })}
            activeId={showsDiff ? 'diff' : files.find((tab) => tab.targetPath === selectedPath)?.id ?? null}
            onSelect={(id) => id === 'diff'
              ? useUIStore.getState().setEditorDiffTabState(directoryKey, 'active')
              : useUIStore.getState().setActiveContextPanelTab(directoryKey, id)}
            onClose={(id) => closeTabs([id])}
            onDoubleClickTab={(id) => useUIStore.getState().pinContextPanelTab(directoryKey, id)}
            onReorder={(id, over) => useUIStore.getState().reorderContextPanelTabs(directoryKey, id, over)}
            layoutMode="scrollable"
            tabContextMenu={({ id, index, allIds, close }) => {
              const before = allIds.slice(0, index);
              const after = allIds.slice(index + 1);
              const left = direction === 'rtl' ? after : before;
              const right = direction === 'rtl' ? before : after;
              return <>
                <ContextMenuItem onClick={close}>{t('contextPanel.tab.menu.close')}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={allIds.length < 2} onClick={() => closeTabs(allIds.filter((other) => other !== id))}>{t('contextPanel.tab.menu.closeOthers')}</ContextMenuItem>
                <ContextMenuItem disabled={!left.length} onClick={() => closeTabs(left)}>{t('contextPanel.tab.menu.closeToLeft')}</ContextMenuItem>
                <ContextMenuItem disabled={!right.length} onClick={() => closeTabs(right)}>{t('contextPanel.tab.menu.closeToRight')}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => closeTabs(allIds)}>{t('contextPanel.tab.menu.closeAll')}</ContextMenuItem>
              </>;
            }}
          /> : <div className="flex items-center gap-1.5 px-3 typography-ui-label"><Icon name="file-code" className="size-3.5" />{t('contextPanel.mode.files')}</div>}
        </header>}
        <div className="relative min-h-0 flex-1">
          <div ref={onDiffHostChange} data-editor-diff-host="" className={cn('absolute inset-0', !showsDiff && 'hidden')} />
          {loaded && <div className={cn('absolute inset-0', (files.length === 0 || showsDiff) && 'hidden')}>
            <React.Suspense fallback={null}><FilesView editorRef={editorRef} mode="editor-only" visible={files.length > 0 && !showsDiff && (editorLayout || classicVisible)} onCloseFile={onCloseFile} /></React.Suspense>
          </div>}
          {files.length === 0 && !showsDiff && <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
            <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
            <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
          </div>}
        </div>
      </section>
    </MovablePane>
  );
};
