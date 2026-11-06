import React from 'react';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';

export const useWorkspaceViewOwner = (directory: string | null | undefined) => {
  const runtime = useGitStore(state => state.runtimeKey);
  const projects = useProjectsStore(state => state.projects);
  const worktrees = useSessionUIStore(state => state.availableWorktreesByProject);
  return React.useMemo(() => {
    const path = normalizePath(directory);
    const project = path ? resolveProjectForSessionDirectory(projects, worktrees, path) : null;
    return { runtime, workspace: workspaceViewKey(runtime, path), project: workspaceViewKey(runtime, project?.path ?? path) };
  }, [directory, projects, runtime, worktrees]);
};

