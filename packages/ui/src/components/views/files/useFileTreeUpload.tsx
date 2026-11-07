import React from 'react';

import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { notifyFileContentInvalidated } from '@/lib/fileContentInvalidation';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { droppedUploadFiles, selectedUploadFiles, uploadFileTree, type UploadDropData, type UploadEntry, type UploadSelection } from './fileTreeUpload';

type UploadDestination = {
  directory: string;
  workspaceRoot: string;
  runtimeKey: string;
  isCurrent: () => boolean;
};

type UploadConflicts = UploadDestination & {
  entries: UploadEntry[];
};

type FileTreeUploadOptions = {
  /** Normalized workspace root the tree shows; uploads are scoped to it. */
  root: string;
  refreshDirectories: (directories: string[]) => Promise<void>;
};

/**
 * Uploads external files into a workspace directory for a file tree:
 * drag-and-drop callers pass the drop data, picker callers open the
 * system file chooser (gallery/camera/files on mobile). Existing names
 * are never replaced silently; they surface in a replace-confirmation
 * dialog rendered through `uploadElements`.
 */
export const useFileTreeUpload = ({ root, refreshDirectories }: FileTreeUploadOptions) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const refreshDirectoriesRef = React.useRef(refreshDirectories);
  refreshDirectoriesRef.current = refreshDirectories;
  const [uploadingDirectory, setUploadingDirectory] = React.useState<string | null>(null);
  const [uploadConflicts, setUploadConflicts] = React.useState<UploadConflicts | null>(null);
  const activeUploadRef = React.useRef<object | null>(null);
  const scopeRef = React.useRef({ root });
  if (scopeRef.current.root !== root) scopeRef.current = { root };
  const mountedRef = React.useRef(true);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const directoryInputRef = React.useRef<HTMLInputElement>(null);
  const pickerDestinationRef = React.useRef<UploadDestination | null>(null);
  const [directoryPickerSupported] = React.useState(() => (
    'webkitdirectory' in document.createElement('input')
  ));
  const canPickDirectory = Boolean(files.uploadFile) && directoryPickerSupported;

  const resetUpload = React.useCallback(() => {
    activeUploadRef.current = null;
    pickerDestinationRef.current = null;
    setUploadingDirectory(null);
    setUploadConflicts(null);
  }, []);

  React.useEffect(() => {
    resetUpload();
  }, [root, resetUpload]);

  React.useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeRuntimeEndpointChanged(({ runtimeKey, previousRuntimeKey }) => {
      if (runtimeKey !== previousRuntimeKey) resetUpload();
    });
    return () => {
      mountedRef.current = false;
      activeUploadRef.current = null;
      unsubscribe();
    };
  }, [resetUpload]);

  const captureDestination = React.useCallback((directory: string): UploadDestination => {
    const scope = scopeRef.current;
    const sameRuntime = captureRuntimeInstance();
    return {
      directory,
      workspaceRoot: root,
      runtimeKey: getRuntimeKey(),
      isCurrent: () => mountedRef.current && scopeRef.current === scope && sameRuntime(),
    };
  }, [root]);

  const uploadSelection = React.useCallback(async (
    destination: UploadDestination,
    readSelection: () => UploadSelection | Promise<UploadSelection>,
    overwrite = false,
  ) => {
    if (!files.uploadFile || !destination.workspaceRoot || activeUploadRef.current || !destination.isCurrent()) return;
    const operation = {};
    activeUploadRef.current = operation;
    setUploadingDirectory(destination.directory);
    setUploadConflicts(null);
    try {
      const selection = await readSelection();
      if (!destination.isCurrent()) return;
      if (selection.entries.length === 0 && selection.failures.length === 0) {
        toast.error(t('sidebarFilesTree.toast.noUploadEntries'));
        return;
      }
      const result = await uploadFileTree({
        files,
        directory: destination.directory,
        workspaceRoot: destination.workspaceRoot,
        selection,
        overwrite,
        isCurrent: destination.isCurrent,
      });
      if (result.uploadedPaths.length > 0) {
        notifyFileContentInvalidated({ runtimeKey: destination.runtimeKey, paths: result.uploadedPaths });
      }
      if (!destination.isCurrent()) return;
      if (result.changedDirectories.length > 0) {
        await refreshDirectoriesRef.current(result.changedDirectories).catch(() => undefined);
      }
      if (!destination.isCurrent()) return;
      const uploadedOnlyDirectories = result.changedDirectories.length > 0 && result.failures.length === 0
        && selection.entries.every((entry) => entry.kind === 'directory');
      if (result.uploadedPaths.length > 0 || uploadedOnlyDirectories) {
        toast.success(t(result.conflicts.length > 0
          ? 'sidebarFilesTree.toast.uploadedWithoutConflicts'
          : 'sidebarFilesTree.toast.uploaded'));
      }
      if (result.failures.length > 0) {
        toast.error(t('sidebarFilesTree.toast.uploadFailed'), { description: result.failures.filter(Boolean).slice(0, 5).join('\n') });
      }
      if (result.conflicts.length > 0) {
        setUploadConflicts({ ...destination, entries: result.conflicts });
      }
    } catch {
      if (destination.isCurrent()) toast.error(t('sidebarFilesTree.toast.uploadFailed'));
    } finally {
      if (mountedRef.current && activeUploadRef.current === operation) {
        activeUploadRef.current = null;
        setUploadingDirectory(null);
      }
    }
  }, [files, t]);

  const uploadDroppedFiles = React.useCallback((directory: string, dataTransfer: UploadDropData) => {
    const destination = captureDestination(directory);
    return uploadSelection(destination, () => droppedUploadFiles(dataTransfer, destination.isCurrent));
  }, [captureDestination, uploadSelection]);

  const pickFiles = React.useCallback((directory: string) => {
    const input = inputRef.current;
    if (!input || activeUploadRef.current) return;
    pickerDestinationRef.current = captureDestination(directory);
    input.value = '';
    input.click();
  }, [captureDestination]);

  const pickDirectory = React.useCallback((directory: string) => {
    const input = directoryInputRef.current;
    if (!input || !canPickDirectory || activeUploadRef.current) return;
    pickerDestinationRef.current = captureDestination(directory);
    input.value = '';
    input.click();
  }, [canPickDirectory, captureDestination]);

  const handlePickerChange = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const destination = pickerDestinationRef.current;
    const picked = Array.from(input.files ?? []);
    pickerDestinationRef.current = null;
    try {
      if (destination) await uploadSelection(destination, () => selectedUploadFiles(picked, input === directoryInputRef.current));
    } finally {
      // Keep the native picker selection alive while the browser reads its files.
      input.value = '';
    }
  }, [uploadSelection]);

  const uploadElements = (
    <>
      <input ref={inputRef} type="file" multiple hidden onChange={handlePickerChange} />
      <input ref={(input) => { directoryInputRef.current = input; if (input) input.webkitdirectory = true; }} type="file" multiple hidden onChange={handlePickerChange} />
      <Dialog open={Boolean(uploadConflicts)} onOpenChange={(open: boolean) => !open && setUploadConflicts(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sidebarFilesTree.dialog.uploadConflicts.title')}</DialogTitle>
            <DialogDescription>
              {t('sidebarFilesTree.dialog.uploadConflicts.description', { path: uploadConflicts?.directory ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <ScrollableOverlay outerClassName="max-h-52" className="flex flex-col gap-1 pe-2">
            {uploadConflicts?.entries.map((entry) => (
              <div key={entry.relativePath} dir="ltr" className="truncate rounded-md bg-muted px-2 py-1 typography-meta" title={entry.relativePath}>
                {entry.relativePath}
              </div>
            ))}
          </ScrollableOverlay>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadConflicts(null)} disabled={uploadingDirectory !== null}>
              {t('sidebarFilesTree.dialog.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!uploadConflicts) return;
                if (!uploadConflicts.isCurrent()) {
                  setUploadConflicts(null);
                  return;
                }
                void uploadSelection(uploadConflicts, () => ({ entries: uploadConflicts.entries, failures: [] }), true);
              }}
              disabled={uploadingDirectory !== null}
            >
              {t('sidebarFilesTree.dialog.uploadConflicts.replace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    canUpload: Boolean(files.uploadFile),
    canPickDirectory,
    uploadingDirectory,
    uploadDroppedFiles,
    pickFiles,
    pickDirectory,
    uploadElements,
  };
};
