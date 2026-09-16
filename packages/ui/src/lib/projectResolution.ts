import type { ProjectEntry } from "@/lib/api/types";
import type { WorktreeMetadata } from "@/types/worktree";

import { normalizePath } from "@/lib/pathNormalization";
export const normalizeProjectPath = normalizePath;

/**
 * Managed worktree checkouts live at
 * `<XDG_DATA_HOME>/opencode/worktree/<project id>/<name>` (server side:
 * `getOpenCodeDataPath` in `packages/web/server/lib/git/service.js`). That data
 * directory defaults to `~/.local/share`, so every managed worktree is a
 * descendant of the user's home directory — and of any other directory they
 * happen to have registered as a project.
 *
 * Ancestor matching must therefore never claim these paths: the registry is the
 * only source that knows which project a worktree belongs to.
 */
const MANAGED_WORKTREE_SEGMENT = "/opencode/worktree/";

export const isManagedWorktreePath = (directory: string | null | undefined): boolean => {
  const nd = normalizeProjectPath(directory ?? null);
  if (!nd) return false;
  const index = nd.indexOf(MANAGED_WORKTREE_SEGMENT);
  // The registry root itself (`.../opencode/worktree`) is not a checkout, so a
  // match only counts when at least the project-id level follows it.
  return index >= 0 && nd.length > index + MANAGED_WORKTREE_SEGMENT.length;
};

export const resolveProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let best: ProjectEntry | null = null;
  for (const p of projects) {
    const pp = normalizeProjectPath(p.path);
    if (!pp) continue;
    if (nd !== pp && !nd.startsWith(pp.endsWith('/') ? pp : `${pp}/`)) continue;
    if (!best || pp.length > (normalizeProjectPath(best.path)?.length ?? 0)) best = p;
  }
  return best;
};

const resolveProjectFromWorktreeDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): { project: ProjectEntry; matchedWorktreePathLength: number } | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let matchedWorktree: WorktreeMetadata | null = null;
  let matchedProjectPath: string | null = null;
  let bestLen = -1;
  for (const [projectPath, worktrees] of availableWorktreesByProject.entries()) {
    for (const wt of worktrees) {
      const wp = normalizeProjectPath(wt.path);
      if (!wp) continue;
      if (nd !== wp && !nd.startsWith(wp.endsWith('/') ? wp : `${wp}/`)) continue;
      if (wp.length > bestLen) {
        bestLen = wp.length;
        matchedWorktree = wt;
        matchedProjectPath = normalizeProjectPath(projectPath);
      }
    }
  }
  if (!matchedWorktree) return null;
  const candidates = [normalizeProjectPath(matchedWorktree.projectDirectory), matchedProjectPath]
    .filter((v): v is string => Boolean(v));
  for (const c of candidates) {
    const exact = projects.find((p) => normalizeProjectPath(p.path) === c) ?? null;
    if (exact) return { project: exact, matchedWorktreePathLength: bestLen };
    const nested = resolveProjectForDirectory(projects, c);
    if (nested) return { project: nested, matchedWorktreePathLength: bestLen };
  }
  return null;
};

const resolveExactProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  return projects.find((p) => normalizeProjectPath(p.path) === nd) ?? null;
};

/**
 * Resolve the project a session's directory belongs to, in decreasing order of
 * authority:
 *
 * 1. a project registered at exactly this directory;
 * 2. the worktree registry, which knows the owning project of a checkout;
 * 3. the nearest ancestor project.
 *
 * The registry outranks ancestor matching because a worktree living inside an
 * unrelated registered directory still belongs to the repository it was cut
 * from. A managed worktree missing from the registry — one created moments ago,
 * before discovery caught up — resolves to no project at all rather than to an
 * ancestor: attributing it to, say, a project registered at the home directory
 * makes selecting that session switch the sidebar to a different project.
 */
export const resolveProjectForSessionDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null => {
  const directProject = resolveProjectForDirectory(projects, directory);
  const worktreeResolution = resolveProjectFromWorktreeDirectory(projects, availableWorktreesByProject, directory);

  // A managed worktree is owned by whichever project the registry says cut
  // it, never by an ancestor directory. Discovery may not have published it
  // yet; handing it to a containing project (the home directory, typically)
  // would switch the sidebar there when the session is selected.
  if (!worktreeResolution && isManagedWorktreePath(directory)) return null;

  if (!directProject) return worktreeResolution?.project ?? null;
  if (!worktreeResolution) return directProject;

  const directPathLength = normalizeProjectPath(directProject.path)?.length ?? 0;
  return worktreeResolution.matchedWorktreePathLength > directPathLength
    ? worktreeResolution.project
    : directProject;
};
