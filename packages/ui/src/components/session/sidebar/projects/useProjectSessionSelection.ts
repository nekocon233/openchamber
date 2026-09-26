import React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from '../types';
import { normalizePath } from '../utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ProjectSection = {
  project: { id: string; normalizedPath: string };
  groups: SessionGroup[];
};

type Args = {
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  activeSessionByProject: Map<string, string>;
  setActiveSessionByProject: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  currentSessionId: string | null;
  currentSessionOwnerProjectId?: string | null;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  newSessionDraftOpen: boolean;
  mobileVariant: boolean;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; preserveDirectoryOverride?: boolean }) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export type MissingProjectSessionSelection =
  | { kind: 'preserve-current' }
  | { kind: 'open-draft' }
  | { kind: 'select-session'; sessionId: string }
  | { kind: 'none' };

/**
 * Resolves the active-project action after its rendered session map does not
 * contain the current session.
 *
 * Authoritative ownership decides. A session owned by this project is kept, and
 * so is a session whose owner is still unknown: an unresolved owner is not
 * evidence that the session belongs elsewhere, and replacing the selection on
 * that basis discards a choice the user just made. The caller leaves the
 * project unprocessed while ownership is unknown, so this runs again — and can
 * still select — once ownership resolves.
 */
export function resolveMissingProjectSessionSelection<T>({
  activeProjectId,
  currentSessionId,
  currentSessionOwnerProjectId,
  projectMap,
  rememberedSessionId,
  fallbackSessionId,
}: {
  activeProjectId: string;
  currentSessionId: string | null;
  currentSessionOwnerProjectId?: string | null;
  projectMap: ReadonlyMap<string, T> | undefined;
  rememberedSessionId: string | undefined;
  fallbackSessionId: string | null;
}): MissingProjectSessionSelection {
  if (currentSessionId && currentSessionOwnerProjectId === activeProjectId) {
    return { kind: 'preserve-current' };
  }

  if (currentSessionId && currentSessionOwnerProjectId == null) {
    return { kind: 'preserve-current' };
  }

  if (!projectMap || projectMap.size === 0) {
    return { kind: 'open-draft' };
  }

  const remembered = rememberedSessionId && projectMap.has(rememberedSessionId)
    ? rememberedSessionId
    : null;
  const targetSessionId = remembered ?? fallbackSessionId;
  if (!targetSessionId || targetSessionId === currentSessionId) {
    return { kind: 'none' };
  }

  return { kind: 'select-session', sessionId: targetSessionId };
}

export const useProjectSessionSelection = (args: Args): void => {
  const {
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    currentSessionOwnerProjectId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setSessionSwitcherOpen,
  } = args;

  const projectSessionMeta = React.useMemo(() => {
    const metaByProject = new Map<string, Map<string, { directory: string | null }>>();
    const firstSessionByProject = new Map<string, { id: string; directory: string | null }>();

    const visitNodes = (
      projectId: string,
      projectRoot: string,
      fallbackDirectory: string | null,
      nodes: SessionNode[],
    ) => {
      if (!metaByProject.has(projectId)) {
        metaByProject.set(projectId, new Map());
      }
      const projectMap = metaByProject.get(projectId)!;
      nodes.forEach((node) => {
        const sessionDirectory = normalizePath(
          node.worktree?.path
          ?? (node.session as Session & { directory?: string | null }).directory
          ?? fallbackDirectory
          ?? projectRoot,
        );
        projectMap.set(node.session.id, { directory: sessionDirectory });
        if (!firstSessionByProject.has(projectId)) {
          firstSessionByProject.set(projectId, { id: node.session.id, directory: sessionDirectory });
        }
        if (node.children.length > 0) {
          visitNodes(projectId, projectRoot, sessionDirectory, node.children);
        }
      });
    };

    projectSections.forEach((section) => {
      section.groups.forEach((group) => {
        visitNodes(section.project.id, section.project.normalizedPath, group.directory, group.sessions);
      });
    });

    return { metaByProject, firstSessionByProject };
  }, [projectSections]);

  const previousActiveProjectRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    if (!activeProjectId) {
      return;
    }

    if (newSessionDraftOpen) {
      return;
    }

    if (useUIStore.getState().isNewWorktreeDialogOpen) {
      return;
    }

    if (previousActiveProjectRef.current === activeProjectId) {
      return;
    }

    const section = projectSections.find((item) => item.project.id === activeProjectId);
    if (!section) {
      return;
    }
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);

    if (currentSessionId && projectMap && projectMap.has(currentSessionId)) {
      previousActiveProjectRef.current = activeProjectId;
      setActiveSessionByProject((prev) => {
        if (prev.get(activeProjectId) === currentSessionId) {
          return prev;
        }
        const next = new Map(prev);
        next.set(activeProjectId, currentSessionId);
        return next;
      });
      return;
    }

    const selection = resolveMissingProjectSessionSelection({
      activeProjectId,
      currentSessionId,
      currentSessionOwnerProjectId,
      projectMap,
      rememberedSessionId: activeSessionByProject.get(activeProjectId),
      fallbackSessionId: projectSessionMeta.firstSessionByProject.get(activeProjectId)?.id ?? null,
    });

    // Only a confirmed owner marks this project done. While ownership is still
    // resolving the project stays unprocessed, so the selection runs again once
    // the owner is known instead of being skipped for the rest of the session.
    if (selection.kind === 'preserve-current') {
      if (currentSessionOwnerProjectId === activeProjectId) {
        previousActiveProjectRef.current = activeProjectId;
      }
      return;
    }

    previousActiveProjectRef.current = activeProjectId;

    if (selection.kind === 'open-draft') {
      if (mobileVariant) {
        setSessionSwitcherOpen(false);
      }
      openNewSessionDraft({
        selectedProjectId: section.project.id,
        directoryOverride: section.project.normalizedPath,
      });
      return;
    }

    if (selection.kind !== 'select-session') {
      return;
    }
    const targetDirectory = projectMap?.get(selection.sessionId)?.directory ?? null;
    handleSessionSelect(selection.sessionId, targetDirectory);
  }, [
    activeProjectId,
    activeSessionByProject,
    currentSessionId,
    currentSessionOwnerProjectId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    projectSections,
    projectSessionMeta,
    setSessionSwitcherOpen,
    setActiveSessionByProject,
  ]);

  React.useEffect(() => {
    if (!activeProjectId || !currentSessionId) {
      return;
    }
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);
    if (!projectMap || !projectMap.has(currentSessionId)) {
      return;
    }
    setActiveSessionByProject((prev) => {
      if (prev.get(activeProjectId) === currentSessionId) {
        return prev;
      }
      const next = new Map(prev);
      next.set(activeProjectId, currentSessionId);
      return next;
    });
  }, [activeProjectId, currentSessionId, projectSessionMeta, setActiveSessionByProject]);
};

type ProjectSessionSelectionEffectProps = Omit<
  Args,
  'activeSessionByProject' | 'setActiveSessionByProject' | 'currentSessionId' | 'newSessionDraftOpen' | 'currentSessionOwnerProjectId'
> & {
  initialActiveSessionByProject: Map<string, string>;
  persistActiveSessionByProject: (value: Map<string, string>) => void;
  sessionOwnerBySessionId?: ReadonlyMap<string, { projectId: string }>;
};

export const ProjectSessionSelectionEffect: React.FC<ProjectSessionSelectionEffectProps> = ({
  initialActiveSessionByProject,
  persistActiveSessionByProject,
  sessionOwnerBySessionId,
  ...args
}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionOwnerProjectId = currentSessionId
    ? sessionOwnerBySessionId?.get(currentSessionId)?.projectId ?? null
    : null;
  const [activeSessionByProject, setActiveSessionByProject] = React.useState(
    () => new Map(initialActiveSessionByProject),
  );
  useProjectSessionSelection({
    ...args,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    currentSessionOwnerProjectId,
    newSessionDraftOpen,
  });
  React.useEffect(() => {
    persistActiveSessionByProject(activeSessionByProject);
  }, [activeSessionByProject, persistActiveSessionByProject]);
  return null;
};
