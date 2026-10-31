export const MAX_PULL_REQUEST_PATCH_BYTES = 20 * 1024 * 1024;

const invalidSnapshot = () => Object.assign(new Error('Pull request file statistics are incomplete'), {
  code: 'INVALID_REQUEST', status: 502,
});

/** Git's NUL-delimited metadata preserves paths containing tabs, newlines or quotes. */
function snapshotFiles(patch, nameStatus, numstat) {
  if ((!nameStatus && patch) || (nameStatus && !nameStatus.endsWith('\0')) || (numstat && !numstat.endsWith('\0'))) {
    throw invalidSnapshot();
  }
  const stats = new Map();
  const counts = numstat.split('\0');
  for (let index = 0; index < counts.length - 1; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(counts[index]);
    if (!match) throw invalidSnapshot();
    let filename = match[3];
    if (!filename) {
      if (!counts[index + 1] || !counts[index + 2]) throw invalidSnapshot();
      filename = counts[index + 2];
      index += 2;
    }
    stats.set(filename, { additions: Number.parseInt(match[1], 10) || 0, deletions: Number.parseInt(match[2], 10) || 0 });
  }
  const patches = patch ? patch.split(/(?=^diff --git )/m).filter(Boolean) : [];
  const names = nameStatus.split('\0');
  const statuses = { A: 'added', D: 'removed', M: 'modified', R: 'renamed', C: 'copied', T: 'changed' };
  const files = [];
  for (let index = 0; index < names.length - 1; index += 1) {
    const code = names[index];
    if (!/^(?:[ADMT]|[RC]\d+)$/.test(code)) throw invalidSnapshot();
    const previousFilename = /^[RC]/.test(code) ? names[++index] : undefined;
    const filename = names[++index];
    const count = stats.get(filename);
    const filePatch = patches[files.length];
    if (!filename || !count || !filePatch?.startsWith('diff --git ')) throw invalidSnapshot();
    const file = { filename, status: statuses[code[0]], ...count, changes: count.additions + count.deletions };
    const hunk = filePatch.indexOf('\n@@ ');
    if (hunk >= 0) file.patch = filePatch.slice(hunk + 1);
    if (previousFilename) file.previous_filename = previousFilename;
    files.push(file);
  }
  if (files.length !== patches.length || files.length !== stats.size) throw invalidSnapshot();
  return files;
}

/** Reads one immutable pair of commit trees. The caller owns transfer and cleanup. */
export async function readPullRequestSnapshot({ headSha, mergeBaseSha, git }) {
  const common = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames',
    '--ignore-submodules=none', '--submodule=short'];
  const refs = [mergeBaseSha, headSha, '--'];
  const patch = await git([...common, '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', ...refs]);
  const names = await git([...common, '--name-status', '-z', ...refs]);
  const counts = await git([...common, '--numstat', '-z', ...refs]);
  return { patch, headSha, files: snapshotFiles(patch, names, counts) };
}
