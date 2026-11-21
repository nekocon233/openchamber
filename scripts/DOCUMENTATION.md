# Changed-files gate

## Ownership

`check-changed.mjs` runs the pre-commit checks and compares lint findings and file sizes with the branch base. Package scripts own the individual checks.

## Invariants

- Dead-code analysis sees tracked files in their current state and untracked files that Git does not ignore. Deleted files stay absent.
- Knip's gitignore rules must not match ancestors outside the checkout.
- The analysis snapshot retains root and workspace dependencies through links. Cleanup removes only the snapshot, including after a failed check.
- A fork integration compares changed files with the branch base and the upstream commits it actually incorporates. The newest upstream revision visible in either merge history is bounded by `refs/remotes/upstream/main`.
- The ratchet retains the highest finding count per path and rule across the baselines. The size check retains the longest parent version, using a TypeScript version when one exists.
- SDK example bundles use the existing generated-output treatment when their TypeScript entry exists beside them. The source entry remains subject to the size limit. The SDK bundle test regenerates shipping examples and compares them with the checked-in output.
- Git confirms a deleted server JavaScript file and its same-path TypeScript replacement before the migration allowance applies. When annotations obscure the rename, Git checks the type-erased source with its normal similarity threshold.

## Decisions

### Why the fork gate reads upstream ancestry

A fork merge changes files on both sides. Comparing with the fork branch base alone counts untouched upstream source as new, including upstream's existing oversized files. CI fetches the official upstream branch and Git finds the inherited revision from the integration history. The fork comparison still covers every changed file, and unmerged upstream changes cannot supply lint or size allowance.

### Why Knip runs in a temporary source snapshot

Knip 5.80.0 passes absolute package entry patterns to fast-glob with relative gitignore patterns. The repository's `*.local` rule then matches the `.local` ancestor of OpenCode worktrees and loses package source mappings. A root symlink also produces incorrect results because resolvers canonicalize paths back into the original checkout.

Checkouts without a dot-prefixed path segment run Knip in place. For hidden paths, the gate copies only the files listed by `git ls-files --cached --others --exclude-standard` into a system temporary directory and links root and package `node_modules` directories. Git metadata and ignored outputs, including `tmp`, `dist`, browser profiles and `packages/web/build`, stay out of the snapshot. The clean-tree and unused-export reports match an ordinary worktree without those outputs.

Runtime sockets and other special filesystem entries are skipped because Knip analyzes files and they cannot be copied. Copy-on-write is requested where available, but the snapshot also stays source-sized on filesystems without it. No ignore rules or findings change, and the original checkout stays in place. POSIX uses `/tmp` so a hidden `TMPDIR` cannot reintroduce the failure.
