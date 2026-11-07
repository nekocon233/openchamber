import type { FilesAPI } from '@/lib/api/types';
import { isFilesystemError } from '@/lib/api/files-errors';

export type UploadEntry =
  | { kind: 'directory'; relativePath: string }
  | { kind: 'file'; relativePath: string; file: File };

export type UploadSelection = { entries: UploadEntry[]; failures: string[] };

/** Only the browser drop members needed to collect files and directories. */
export type UploadDropData = {
  items: ArrayLike<{
    kind: string;
    getAsFile(): File | null;
    webkitGetAsEntry?(): FileSystemEntry | null;
  }>;
  files: ArrayLike<File>;
};

const isUploadRelativePath = (path: string): boolean => (
  Boolean(path) && !path.includes('\\') && !path.includes('\0') && !/^[a-z]:\//i.test(path)
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
);

const joinUploadPath = (directory: string, relativePath: string): string => (
  `${directory.replace(/[\\/]+$/, '')}/${relativePath}`
);

/** A directory picker returns files with paths including the selected folder. */
export const selectedUploadFiles = (files: File[], directory = false): UploadSelection => {
  const selection: UploadSelection = { entries: [], failures: [] };
  const directories = new Set<string>();
  for (const file of files) {
    const relativePath = directory ? file.webkitRelativePath : file.name;
    if (!isUploadRelativePath(relativePath) || (directory ? !relativePath.includes('/') : relativePath.includes('/'))) {
      selection.failures.push(file.name);
      continue;
    }
    const parts = relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (directories.has(parent)) continue;
      directories.add(parent);
      selection.entries.push({ kind: 'directory', relativePath: parent });
    }
    selection.entries.push({ kind: 'file', relativePath, file });
  }
  return selection;
};

/** Snapshot every browser entry before the drop event's data store closes. */
export const droppedUploadFiles = (dataTransfer: UploadDropData, isCurrent = () => true): Promise<UploadSelection> => {
  const items = Array.from(dataTransfer.items);
  if (items.length === 0) return Promise.resolve(selectedUploadFiles(Array.from(dataTransfer.files)));
  const sources = items.filter((item) => item.kind === 'file').map((item) => ({
    entry: item.webkitGetAsEntry?.() ?? null,
    file: item.getAsFile(),
  }));

  return (async () => {
    const selection: UploadSelection = { entries: [], failures: [] };
    const visit = async (entry: FileSystemEntry, parent = ''): Promise<void> => {
      if (!isCurrent()) return;
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      if (!isUploadRelativePath(relativePath)) {
        selection.failures.push(relativePath);
        return;
      }
      try {
        if (entry.isFile) {
          // SAFETY: The browser's isFile discriminator identifies FileSystemFileEntry.
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
          selection.entries.push({ kind: 'file', relativePath, file });
        } else if (entry.isDirectory) {
          selection.entries.push({ kind: 'directory', relativePath });
          // SAFETY: The browser's isDirectory discriminator identifies FileSystemDirectoryEntry.
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          for (;;) {
            if (!isCurrent()) break;
            const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
            if (children.length === 0) break;
            for (const child of children) await visit(child, relativePath);
          }
        }
      } catch {
        selection.failures.push(relativePath);
      }
    };
    for (const source of sources) {
      if (!isCurrent()) break;
      if (source.entry) await visit(source.entry);
      else if (source.file) {
        const selected = selectedUploadFiles([source.file]);
        selection.entries.push(...selected.entries);
        selection.failures.push(...selected.failures);
      } else selection.failures.push('');
    }
    return selection;
  })();
};

/** All writes stay in the captured workspace; one failed subtree leaves siblings usable. */
export const uploadFileTree = async ({ files, directory, workspaceRoot, selection, overwrite, isCurrent }: {
  files: FilesAPI;
  directory: string;
  workspaceRoot: string;
  selection: UploadSelection;
  overwrite: boolean;
  isCurrent: () => boolean;
}) => {
  const uploadedPaths: string[] = [];
  const changedDirectories = new Set<string>();
  const conflicts: UploadEntry[] = [];
  const failures = [...selection.failures];
  const blocked = new Set<string>();
  const directories = selection.entries.filter((entry) => entry.kind === 'directory');
  // Picker entries already have this order; sorting also handles caller-supplied trees.
  directories.sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
  const isBlocked = (relativePath: string): boolean => {
    for (let parent = relativePath; parent; parent = parentOf(parent)) {
      if (blocked.has(parent)) return true;
      if (!parent.includes('/')) break;
    }
    return false;
  };
  for (const entry of directories) {
    if (!isCurrent()) break;
    if (!isUploadRelativePath(entry.relativePath) || isBlocked(entry.relativePath)) {
      failures.push(entry.relativePath);
      blocked.add(entry.relativePath);
      continue;
    }
    const path = joinUploadPath(directory, entry.relativePath);
    try {
      const result = await files.createDirectory(path, { directory: workspaceRoot });
      if (!result.success) throw new Error('Directory creation failed');
      changedDirectories.add(parentOf(path));
    } catch {
      blocked.add(entry.relativePath);
      failures.push(entry.relativePath);
    }
  }
  const fileEntries = selection.entries.filter((entry) => entry.kind === 'file');
  for (let index = 0; index < fileEntries.length && isCurrent(); index += 3) {
    await Promise.all(fileEntries.slice(index, index + 3).map(async (entry) => {
      if (!isCurrent()) return;
      if (!isUploadRelativePath(entry.relativePath) || isBlocked(entry.relativePath)) {
        failures.push(entry.relativePath);
        return;
      }
      const path = joinUploadPath(directory, entry.relativePath);
      try {
        const result = await files.uploadFile?.(path, entry.file, { directory: workspaceRoot, overwrite });
        if (!result?.success) throw new Error('File upload failed');
        uploadedPaths.push(path);
        changedDirectories.add(parentOf(path));
      } catch (error) {
        if (!overwrite && isFilesystemError(error) && error.reason === 'already-exists') conflicts.push(entry);
        else failures.push(entry.relativePath);
      }
    }));
  }
  return { uploadedPaths, changedDirectories: [...changedDirectories], conflicts, failures };
};
