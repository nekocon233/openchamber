export type FileDiffKind = 'add' | 'update' | 'delete';

export type FileDiffEntry = {
  filePath: string;
  type: FileDiffKind;
  diff: string;
  additions: number;
  deletions: number;
  movePath?: string;
};

export type FileDiffMetadata = {
  files: FileDiffEntry[];
  diff: string;
};

export type ClaudeHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export interface ClaudeFileDiffResult {
  filePath: string;
  type?: string | undefined;
  content?: string | undefined;
  structuredPatch?: ClaudeHunk[] | undefined;
}

export interface ClaudeBashFileDiff {
  filePath: string;
  hunks: ClaudeHunk[];
  created?: boolean | undefined;
  deleted?: boolean | undefined;
}

export interface CodexFileChange {
  path: string;
  kind: {
    type: FileDiffKind;
    move_path?: string | null | undefined;
  };
  diff: string;
}

const header = (type: FileDiffKind, filePath: string, movePath: string | null = null): string => {
  const from = type === 'add' ? '/dev/null' : filePath;
  const to = type === 'delete' ? '/dev/null' : (movePath ?? filePath);
  return `--- ${from}\n+++ ${to}\n`;
};

const countChanges = (diffBody: string) => {
  let additions = 0;
  let deletions = 0;
  for (const line of diffBody.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
};

const addedFileHunk = (content: string): string => {
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const range = lines.length === 0 ? '0,0' : `1,${lines.length}`;
  let hunk = `@@ -0,0 +${range} @@\n${lines.map((line) => `+${line}`).join('\n')}${lines.length > 0 ? '\n' : ''}`;
  if (content !== '' && !content.endsWith('\n')) hunk += '\\ No newline at end of file\n';
  return hunk;
};

const deletedFileHunk = (content: string): string => {
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const range = lines.length === 0 ? '0,0' : `1,${lines.length}`;
  return `@@ -${range} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}${lines.length > 0 ? '\n' : ''}`;
};

const fileEntry = ({ filePath, type, body, movePath = null }: {
  filePath: string;
  type: FileDiffKind;
  body: string;
  movePath?: string | null | undefined;
}): FileDiffEntry => {
  const diff = header(type, filePath, movePath) + body;
  const entry: FileDiffEntry = { filePath, type, diff, ...countChanges(body) };
  if (movePath !== null) entry.movePath = movePath;
  return entry;
};

export const fileDiffMetadata = (files: FileDiffEntry[]): FileDiffMetadata => ({
  files,
  diff: files.map((file) => file.diff).join(''),
});

const hunkBody = (hunks: ReadonlyArray<ClaudeHunk>): string => hunks
  .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`)
  .join('');

export const claudeFileEntry = (result: ClaudeFileDiffResult): FileDiffEntry | null => {
  const type: FileDiffKind = result.type === 'create' ? 'add' : 'update';
  if (result.structuredPatch && result.structuredPatch.length > 0) {
    return fileEntry({ filePath: result.filePath, type, body: hunkBody(result.structuredPatch) });
  }
  if (type === 'add' && result.content !== undefined) {
    return fileEntry({ filePath: result.filePath, type, body: addedFileHunk(result.content) });
  }
  return null;
};

export const claudeBashFileEntry = ({ filePath, hunks, created, deleted }: ClaudeBashFileDiff): FileDiffEntry | null => {
  const type: FileDiffKind = created ? 'add' : deleted ? 'delete' : 'update';
  if (hunks.length > 0) return fileEntry({ filePath, type, body: hunkBody(hunks) });
  if (type === 'add') return fileEntry({ filePath, type, body: addedFileHunk('') });
  if (type === 'delete') return fileEntry({ filePath, type, body: deletedFileHunk('') });
  return null;
};

export const codexFileEntry = (change: CodexFileChange): FileDiffEntry => {
  const type = change.kind.type;
  if (type === 'add') return fileEntry({ filePath: change.path, type, body: addedFileHunk(change.diff) });
  if (type === 'delete') return fileEntry({ filePath: change.path, type, body: deletedFileHunk(change.diff) });
  const body = change.diff.endsWith('\n') || change.diff === '' ? change.diff : `${change.diff}\n`;
  return fileEntry({ filePath: change.path, type, body, movePath: change.kind.move_path ?? null });
};
