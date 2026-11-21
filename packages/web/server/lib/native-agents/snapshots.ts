import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PATHS_PER_COMMAND = 200;

export type SnapshotGitRunner = (args: string[], options: { cwd: string }) => Promise<string>;

export interface SnapshotStoreOptions {
  dataDir: string;
  git?: SnapshotGitRunner | undefined;
}

export interface SnapshotStore {
  repositoryRoot: (directory: string) => Promise<string | null>;
  capture: (root: string) => Promise<string>;
  changedFiles: (root: string, fromTree: string, toTree: string) => Promise<string[]>;
  restoreFiles: (root: string, tree: string, files: string[]) => Promise<void>;
}

const runGit: SnapshotGitRunner = (args, { cwd }) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

const splitNul = (output: string): string[] => output.split('\0').filter((entry) => entry.length > 0);

export const createSnapshotStore = ({ dataDir, git = runGit }: SnapshotStoreOptions): SnapshotStore => {
  const shadowRoot = path.join(dataDir, 'native-agents', 'snapshots');
  const queues = new Map<string, Promise<void>>();
  const shadows = new Map<string, Promise<string>>();

  const serialized = <Result>(root: string, work: () => Promise<Result>): Promise<Result> => {
    const previous = queues.get(root) ?? Promise.resolve();
    const run = previous.then(work);
    const settled = run.then(() => undefined, () => undefined);
    queues.set(root, settled);
    void settled.finally(() => {
      if (queues.get(root) === settled) queues.delete(root);
    });
    return run;
  };

  const shadowFor = (root: string): Promise<string> => {
    let shadow = shadows.get(root);
    if (!shadow) {
      const gitDir = path.join(shadowRoot, createHash('sha256').update(root).digest('hex').slice(0, 16));
      shadow = (async () => {
        await fs.mkdir(shadowRoot, { recursive: true });
        await git(['init', '--bare', '--quiet', gitDir], { cwd: shadowRoot });
        await git(['--git-dir', gitDir, 'config', 'core.autocrlf', 'false'], { cwd: shadowRoot });
        return gitDir;
      })();
      shadows.set(root, shadow);
      void shadow.catch(() => shadows.delete(root));
    }
    return shadow;
  };

  const treeGit = (gitDir: string, root: string, args: string[]): Promise<string> => git(
    ['--literal-pathspecs', '--git-dir', gitDir, '--work-tree', root, ...args],
    { cwd: root },
  );

  return {
    async repositoryRoot(directory) {
      try {
        const root = (await git(['rev-parse', '--show-toplevel'], { cwd: directory })).trim();
        return root.length > 0 ? root : null;
      } catch {
        return null;
      }
    },

    capture(root) {
      return serialized(root, async () => {
        const gitDir = await shadowFor(root);
        await treeGit(gitDir, root, ['add', '--all', '--', '.']);
        return (await treeGit(gitDir, root, ['write-tree'])).trim();
      });
    },

    changedFiles(root, fromTree, toTree) {
      return serialized(root, async () => {
        if (fromTree === toTree) return [];
        const gitDir = await shadowFor(root);
        return splitNul(await git(['--git-dir', gitDir, 'diff', '--name-only', '-z', '--no-renames', fromTree, toTree], { cwd: root }));
      });
    },

    restoreFiles(root, tree, files) {
      return serialized(root, async () => {
        if (files.length === 0) return;
        const gitDir = await shadowFor(root);
        const held = new Set<string>();
        for (let start = 0; start < files.length; start += PATHS_PER_COMMAND) {
          const chunk = files.slice(start, start + PATHS_PER_COMMAND);
          for (const file of splitNul(await git(['--literal-pathspecs', '--git-dir', gitDir, 'ls-tree', '-r', '-z', '--name-only', tree, '--', ...chunk], { cwd: root }))) {
            held.add(file);
          }
        }
        const restored = files.filter((file) => held.has(file));
        for (let start = 0; start < restored.length; start += PATHS_PER_COMMAND) {
          await treeGit(gitDir, root, ['checkout', tree, '--', ...restored.slice(start, start + PATHS_PER_COMMAND)]);
        }
        for (const file of files) {
          if (held.has(file)) continue;
          const target = path.resolve(root, file);
          if (target.startsWith(`${root}${path.sep}`)) await fs.rm(target, { force: true });
        }
      });
    },
  };
};
