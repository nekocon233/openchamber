// Working-tree snapshots that let OpenChamber revert what native turns changed
// on disk. The CLIs keep the conversation; restoring files is ours to do, the
// way OpenCode does it for its own sessions.
//
// Each git repository a session works in gets a shadow git repository under
// the data dir. Snapshots are trees written into it: every command runs with
// --git-dir pointing at the shadow repository and --work-tree at the user's
// repository root, so the user's own repository only ever answers
// `rev-parse`. The work tree's .gitignore files apply, and git never records a
// `.git` directory. Directories outside a git repository get no snapshots;
// their reverts rewind the conversation only.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PATHS_PER_COMMAND = 200;

/**
 * @param {string[]} args
 * @param {{ cwd: string }} options
 * @returns {Promise<string>} stdout
 */
const runGit = (args, { cwd }) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

const splitNul = (output) => output.split('\0').filter((entry) => entry.length > 0);

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory
 * @param {typeof runGit} [options.git]
 */
export const createSnapshotStore = ({ dataDir, git = runGit }) => {
  const shadowRoot = path.join(dataDir, 'native-agents', 'snapshots');
  /** @type {Map<string, Promise<unknown>>} work tree root → last queued operation */
  const queues = new Map();
  /** @type {Map<string, Promise<string>>} work tree root → shadow git dir, once initialized */
  const shadows = new Map();

  // One operation at a time per repository: they share the shadow index.
  const serialized = (root, work) => {
    const previous = queues.get(root) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    queues.set(root, run);
    run.finally(() => {
      if (queues.get(root) === run) queues.delete(root);
    }).catch(() => {});
    return run;
  };

  const shadowFor = (root) => {
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
      shadow.catch(() => shadows.delete(root));
    }
    return shadow;
  };

  // Paths are file names, never patterns: `*` or `:` in a name must not glob.
  const treeGit = (gitDir, root, args) => git(['--literal-pathspecs', '--git-dir', gitDir, '--work-tree', root, ...args], { cwd: root });

  return {
    /**
     * The root of the git repository `directory` belongs to, or null when it
     * belongs to none (or git is unavailable).
     * @param {string} directory
     */
    async repositoryRoot(directory) {
      try {
        const root = (await git(['rev-parse', '--show-toplevel'], { cwd: directory })).trim();
        return root.length > 0 ? root : null;
      } catch {
        return null;
      }
    },

    /**
     * Records the repository's work tree as it is now.
     * @param {string} root repository root from `repositoryRoot`
     * @returns {Promise<string>} tree id
     */
    capture(root) {
      return serialized(root, async () => {
        const gitDir = await shadowFor(root);
        await treeGit(gitDir, root, ['add', '--all', '--', '.']);
        return (await treeGit(gitDir, root, ['write-tree'])).trim();
      });
    },

    /**
     * Paths, relative to the root, whose content differs between two trees.
     * @param {string} root
     * @param {string} fromTree
     * @param {string} toTree
     */
    changedFiles(root, fromTree, toTree) {
      return serialized(root, async () => {
        if (fromTree === toTree) return [];
        const gitDir = await shadowFor(root);
        return splitNul(await git(['--git-dir', gitDir, 'diff', '--name-only', '-z', '--no-renames', fromTree, toTree], { cwd: root }));
      });
    },

    /**
     * Puts each listed file back the way `tree` holds it, and deletes the ones
     * `tree` does not hold. Files not listed are left alone.
     * @param {string} root
     * @param {string} tree
     * @param {string[]} files paths relative to the root
     */
    restoreFiles(root, tree, files) {
      return serialized(root, async () => {
        if (files.length === 0) return;
        const gitDir = await shadowFor(root);
        const held = new Set();
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
