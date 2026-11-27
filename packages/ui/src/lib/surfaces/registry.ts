import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import {
  isPluginContextPanelMode,
  type ContextPanelMode,
} from '@/lib/surfaces/modes';

type BuiltInContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'issues'
  | 'ci'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'notes'
  | 'context'
  | 'browser'
  | 'workflows'
  | 'subagents'
  | 'chat'
  | 'pages';

export type ContextSurfaceId = BuiltInContextSurfaceId | `plugin:${string}`;

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  mode: ContextPanelMode;
  icon: IconName;
  iconSrc?: string;
  label?: string;
  labelKey: I18nKey;
  availability: 'always' | 'has-content';
  descriptionKey: I18nKey;
  /**
   * Default panel width in px, used until the user resizes this surface. The
   * panel never takes more than the chat area leaves after a minimum chat
   * column, so a small window shows it narrower.
   */
  defaultWidth?: number;
};

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    descriptionKey: 'contextRail.surface.context.description',
    defaultWidth: 540,
    mode: 'context',
    icon: 'pie-chart',
    labelKey: 'contextPanel.mode.context',
    availability: 'always',
  },
  {
    id: 'git',
    descriptionKey: 'contextRail.surface.git.description',
    defaultWidth: 480,
    mode: 'git',
    icon: 'git-branch',
    labelKey: 'layout.rightSidebar.git',
    availability: 'always',
  },
  {
    id: 'pr',
    descriptionKey: 'contextRail.surface.pr.description',
    defaultWidth: 540,
    mode: 'pr',
    icon: 'github',
    labelKey: 'contextPanel.mode.pr',
    availability: 'always',
  },
  {
    id: 'issues',
    descriptionKey: 'contextRail.surface.issues.description',
    defaultWidth: 540,
    mode: 'issues',
    icon: 'record-circle',
    labelKey: 'references.picker.tab.issues',
    availability: 'always',
  },
  {
    id: 'ci',
    descriptionKey: 'contextRail.surface.ci.description',
    defaultWidth: 540,
    mode: 'ci',
    icon: 'play-circle',
    labelKey: 'gitView.pullRequest.tab.ci',
    availability: 'always',
  },
  {
    id: 'diff',
    descriptionKey: 'contextRail.surface.diff.description',
    defaultWidth: 640,
    mode: 'diff',
    icon: 'layout-column',
    labelKey: 'contextPanel.mode.diff',
    availability: 'always',
  },
  {
    id: 'walkthrough',
    descriptionKey: 'contextRail.surface.walkthrough.description',
    defaultWidth: 640,
    mode: 'walkthrough',
    icon: 'route',
    labelKey: 'contextPanel.mode.walkthrough',
    availability: 'always',
  },
  {
    id: 'editor',
    descriptionKey: 'contextRail.surface.editor.description',
    defaultWidth: 640,
    mode: 'file',
    icon: 'file-edit',
    labelKey: 'contextPanel.mode.files',
    availability: 'always',
  },
  {
    id: 'terminal',
    descriptionKey: 'contextRail.surface.terminal.description',
    defaultWidth: 640,
    mode: 'terminal',
    icon: 'terminal-box',
    labelKey: 'layout.mainTab.terminal',
    availability: 'always',
  },
  {
    id: 'browser',
    descriptionKey: 'contextRail.surface.browser.description',
    defaultWidth: 540,
    mode: 'browser',
    icon: 'global',
    labelKey: 'contextPanel.mode.browser',
    availability: 'always',
  },
  {
    id: 'notes',
    descriptionKey: 'contextRail.surface.notes.description',
    // As wide as the files surface: this panel carries a sidebar and a
    // content column, and a narrower panel leaves the content column too
    // narrow to read a note in.
    defaultWidth: 640,
    mode: 'notes',
    icon: 'book-marked',
    labelKey: 'contextRail.surface.notes',
    availability: 'always',
  },
  {
    id: 'workflows',
    descriptionKey: 'contextRail.surface.workflows.description',
    defaultWidth: 640,
    mode: 'workflows',
    icon: 'flow-chart',
    labelKey: 'contextPanel.mode.workflows',
    availability: 'always',
  },
  {
    id: 'subagents',
    descriptionKey: 'contextRail.surface.subagents.description',
    mode: 'subagents',
    icon: 'ai-agent',
    labelKey: 'contextPanel.mode.subagents',
    availability: 'has-content',
  },
  {
    id: 'chat',
    descriptionKey: 'contextRail.surface.chat.description',
    defaultWidth: 540,
    mode: 'chat',
    icon: 'chat-4',
    labelKey: 'contextPanel.mode.chat',
    availability: 'has-content',
  },
  {
    id: 'pages',
    descriptionKey: 'contextRail.surface.pages.description',
    mode: 'pages',
    icon: 'pages',
    labelKey: 'contextPanel.mode.pages',
    availability: 'has-content',
  },
];

const DEFAULT_WIDTH_BY_MODE = new Map(CONTEXT_SURFACES.map((surface) => [surface.mode, surface.defaultWidth]));

export const GUEST_SURFACE_DEFAULT_WIDTH = 540;

export const WALKTHROUGH_MIN_WIDTH = 768;

export const getContextSurfaceDefaultWidth = (mode: ContextPanelMode): number => {
  if (isPluginContextPanelMode(mode)) return GUEST_SURFACE_DEFAULT_WIDTH;
  return DEFAULT_WIDTH_BY_MODE.get(mode) ?? GUEST_SURFACE_DEFAULT_WIDTH;
};
export const sortContextSurfaces = (
  railOrder: readonly string[],
  extras: readonly ContextSurfaceDescriptor[] = [],
): ContextSurfaceDescriptor[] => {
  const all = extras.length === 0 ? CONTEXT_SURFACES : [...CONTEXT_SURFACES, ...extras];
  const byId = new Map<string, ContextSurfaceDescriptor>(all.map((surface) => [surface.id, surface]));
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<string>();

  for (const id of railOrder) {
    if (seen.has(id)) {
      continue;
    }
    const surface = byId.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of all) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  hiddenSurfaces?: readonly string[];
  isVSCode: boolean;
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode; targetPath?: string | null }[];
  sourceControlConnected: boolean;
  githubConnected?: boolean;
  repositoryProvider?: string | null;
  workflowsShown?: boolean;
  receivedPagesShown?: boolean;
  extras?: readonly ContextSurfaceDescriptor[];
};

export const getVisibleContextRailSurfaces = (options: VisibleRailSurfacesOptions): ContextSurfaceDescriptor[] => {
  return sortContextSurfaces(options.railOrder, options.extras).filter((surface) => {
    if (options.hiddenSurfaces?.includes(surface.id)) {
      return false;
    }
    if (isPluginContextPanelMode(surface.mode) && options.isVSCode) {
      return false;
    }
    if (surface.id === 'walkthrough' && (options.isVSCode || options.screenWidth < WALKTHROUGH_MIN_WIDTH)) {
      return false;
    }
    if (surface.id === 'browser' && options.isVSCode) {
      return false;
    }
    if (surface.id === 'pr' && !options.sourceControlConnected
      && !options.tabs.some((tab) => tab.mode === 'pr' && tab.targetPath)) {
      return false;
    }
    const knownNonGitHub = options.repositoryProvider && options.repositoryProvider !== 'github' && options.repositoryProvider !== 'none';
    if (surface.id === 'issues' && (options.isVSCode || !options.githubConnected || knownNonGitHub)) {
      return false;
    }
    if (surface.id === 'ci' && (
      options.isVSCode
      || !options.githubConnected
      || options.repositoryProvider === 'gitlab'
    )) {
      return false;
    }
    if (surface.id === 'workflows' && (options.isVSCode || !options.workflowsShown)) {
      return false;
    }
    if (surface.id === 'pages' && options.receivedPagesShown) {
      return true;
    }
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    return true;
  });
};
