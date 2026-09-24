// Unified diffs for the edit/write/apply_patch renderers. Both CLIs report
// file changes in their own form; the UI reads `metadata.files[]` entries of
// `{ filePath, type, diff, additions, deletions }` plus a combined
// `metadata.diff`.

const header = (type, filePath, movePath = null) => {
  const from = type === 'add' ? '/dev/null' : filePath;
  const to = type === 'delete' ? '/dev/null' : (movePath ?? filePath);
  return `--- ${from}\n+++ ${to}\n`;
};

const countChanges = (diffBody) => {
  let additions = 0;
  let deletions = 0;
  for (const line of diffBody.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
};

const addedFileHunk = (content) => {
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const range = lines.length === 0 ? '0,0' : `1,${lines.length}`;
  let hunk = `@@ -0,0 +${range} @@\n${lines.map((line) => `+${line}`).join('\n')}${lines.length > 0 ? '\n' : ''}`;
  if (content !== '' && !content.endsWith('\n')) hunk += '\\ No newline at end of file\n';
  return hunk;
};

const deletedFileHunk = (content) => {
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const range = lines.length === 0 ? '0,0' : `1,${lines.length}`;
  return `@@ -${range} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}${lines.length > 0 ? '\n' : ''}`;
};

/**
 * @param {{ filePath: string, type: 'add' | 'update' | 'delete', body: string, movePath?: string | null }} change
 */
const fileEntry = ({ filePath, type, body, movePath = null }) => {
  const diff = header(type, filePath, movePath) + body;
  const entry = { filePath, type, diff, ...countChanges(body) };
  if (movePath !== null) entry.movePath = movePath;
  return entry;
};

/** Metadata for the renderers from a list of file entries. */
export const fileDiffMetadata = (files) => ({
  files,
  diff: files.map((file) => file.diff).join(''),
});

/**
 * Claude Edit/Write/MultiEdit results carry `structuredPatch` hunks; a created
 * file may carry only its content.
 * @param {{ filePath: string, type?: string, content?: string, structuredPatch?: Array<{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }> }} result
 */
export const claudeFileEntry = (result) => {
  const type = result.type === 'create' ? 'add' : 'update';
  if (result.structuredPatch && result.structuredPatch.length > 0) {
    const body = result.structuredPatch
      .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`)
      .join('');
    return fileEntry({ filePath: result.filePath, type, body });
  }
  if (type === 'add' && result.content !== undefined) {
    return fileEntry({ filePath: result.filePath, type, body: addedFileHunk(result.content) });
  }
  return null;
};

/**
 * Codex fileChange items give each change's kind and diff. For an added or
 * deleted file the diff is the file content; for an update it is the hunks.
 * @param {{ path: string, kind: { type: 'add' | 'update' | 'delete', move_path?: string | null }, diff: string }} change
 */
export const codexFileEntry = (change) => {
  const type = change.kind.type;
  if (type === 'add') return fileEntry({ filePath: change.path, type, body: addedFileHunk(change.diff) });
  if (type === 'delete') return fileEntry({ filePath: change.path, type, body: deletedFileHunk(change.diff) });
  const body = change.diff.endsWith('\n') || change.diff === '' ? change.diff : `${change.diff}\n`;
  return fileEntry({ filePath: change.path, type, body, movePath: change.kind.move_path ?? null });
};
