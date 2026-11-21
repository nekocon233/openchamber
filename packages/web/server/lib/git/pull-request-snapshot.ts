export const MAX_PULL_REQUEST_PATCH_BYTES = 20 * 1024 * 1024;

export type PullRequestFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed';

export interface PullRequestSnapshotFile {
  filename: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface PullRequestSnapshot {
  patch: string;
  headSha: string;
  files: PullRequestSnapshotFile[];
}

export interface ReadPullRequestSnapshotOptions {
  headSha: string;
  mergeBaseSha: string;
  git: (args: string[]) => Promise<string>;
}

const STATUS_MAP = new Map<string, PullRequestFileStatus>([
  ['A', 'added'],
  ['D', 'removed'],
  ['M', 'modified'],
  ['R', 'renamed'],
  ['C', 'copied'],
  ['T', 'changed'],
]);

const invalidSnapshot = () => Object.assign(new Error('Pull request file statistics are incomplete'), {
  code: 'INVALID_REQUEST',
  status: 502,
});

function snapshotFiles(patch: string, nameStatus: string, numstat: string): PullRequestSnapshotFile[] {
  if ((!nameStatus && patch) || (nameStatus && !nameStatus.endsWith('\0')) || (numstat && !numstat.endsWith('\0'))) {
    throw invalidSnapshot();
  }
  const stats = new Map<string, { additions: number; deletions: number }>();
  const counts = numstat.split('\0');
  for (let index = 0; index < counts.length - 1; index += 1) {
    const line = counts[index];
    if (line === undefined) throw invalidSnapshot();
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(line);
    if (!match) throw invalidSnapshot();
    const additionsText = match[1];
    const deletionsText = match[2];
    let filename = match[3];
    if (additionsText === undefined || deletionsText === undefined || filename === undefined) {
      throw invalidSnapshot();
    }
    if (!filename) {
      const oldName = counts[index + 1];
      const newName = counts[index + 2];
      if (!oldName || !newName) throw invalidSnapshot();
      filename = newName;
      index += 2;
    }
    stats.set(filename, {
      additions: Number.parseInt(additionsText, 10) || 0,
      deletions: Number.parseInt(deletionsText, 10) || 0,
    });
  }
  const patches = patch ? patch.split(/(?=^diff --git )/m).filter(Boolean) : [];
  const names = nameStatus.split('\0');
  const files: PullRequestSnapshotFile[] = [];
  for (let index = 0; index < names.length - 1; index += 1) {
    const code = names[index];
    if (!code || !/^(?:[ADMT]|[RC]\d+)$/.test(code)) throw invalidSnapshot();
    const previousFilename = /^[RC]/.test(code) ? names[++index] : undefined;
    const filename = names[++index];
    const count = filename ? stats.get(filename) : undefined;
    const filePatch = patches[files.length];
    const statusCode = code[0];
    const status = statusCode ? STATUS_MAP.get(statusCode) : undefined;
    if (!filename || !count || !status || !filePatch?.startsWith('diff --git ')) throw invalidSnapshot();
    const file: PullRequestSnapshotFile = {
      filename,
      status,
      additions: count.additions,
      deletions: count.deletions,
      changes: count.additions + count.deletions,
    };
    const hunk = filePatch.indexOf('\n@@ ');
    if (hunk >= 0) file.patch = filePatch.slice(hunk + 1);
    if (previousFilename) file.previous_filename = previousFilename;
    files.push(file);
  }
  if (files.length !== patches.length || files.length !== stats.size) throw invalidSnapshot();
  return files;
}

export async function readPullRequestSnapshot({ headSha, mergeBaseSha, git }: ReadPullRequestSnapshotOptions): Promise<PullRequestSnapshot> {
  const common = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames',
    '--ignore-submodules=none', '--submodule=short'];
  const refs = [mergeBaseSha, headSha, '--'];
  const patch = await git([...common, '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', ...refs]);
  const names = await git([...common, '--name-status', '-z', ...refs]);
  const counts = await git([...common, '--numstat', '-z', ...refs]);
  return { patch, headSha, files: snapshotFiles(patch, names, counts) };
}
