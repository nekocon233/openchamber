import { buildChangesTree, changedPathName as baseName, compactDirectory, type ChangesTreeDirectoryNode } from './git/changesTree';

type DiffTreeFile = { path: string; previousPath?: string | undefined };
type DiffTreeRow<F extends DiffTreeFile> =
  | { kind: 'directory'; key: string; depth: number; path: string; label: string; fileCount: number; expanded: boolean; viewerCommented: boolean }
  | { kind: 'file'; key: string; depth: number; name: string; file: F; viewerCommented: boolean };

export const buildDiffTreeRows = <F extends DiffTreeFile>(
  files: F[],
  collapsed: ReadonlySet<string>,
  commentedPaths?: ReadonlySet<string>,
): DiffTreeRow<F>[] => {
  const rows: DiffTreeRow<F>[] = [];
  const viewerCommentedOn = (file: F): boolean => (
    commentedPaths?.has(file.path) === true
    || (file.previousPath !== undefined && commentedPaths?.has(file.previousPath) === true)
  );

  const walk = (node: ChangesTreeDirectoryNode<F>, depth: number) => {
    const directories = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const directory of directories) {
      const { node: target, label } = compactDirectory(directory);
      const expanded = !collapsed.has(target.path);
      const viewerCommented = commentedPaths !== undefined && target.files.some(viewerCommentedOn);
      rows.push({ kind: 'directory', key: `dir:${target.path}`, depth, path: target.path, label, fileCount: target.files.length, expanded, viewerCommented });
      if (expanded) {
        walk(target, depth + 1);
      }
    }

    const directFiles = [...node.directFiles].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    for (const file of directFiles) {
      rows.push({ kind: 'file', key: `file:${file.path}`, depth, name: baseName(file.path), file, viewerCommented: viewerCommentedOn(file) });
    }
  };

  walk(buildChangesTree(files), 0);
  return rows;
};
