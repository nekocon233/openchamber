import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { useI18n } from '@/lib/i18n';
import { type ContextPanelMode } from '@/stores/useUIStore';
import { browserUrlLabel } from '@/lib/browser/url';
import { Icon } from "@/components/icon/Icon";
import { useGuestsStore } from '@/lib/guests/store';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';
import { ContextGuestIcon, ChatTabIcon, TrackerTabIcon } from './ContextPanelTabIcons';

export type TranslateFn = ReturnType<typeof useI18n>['t'];

export const getModeLabel = (
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'walkthrough') return t('contextPanel.mode.walkthrough');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  if (mode === 'git') return t('layout.rightSidebar.git');
  if (mode === 'pr') return t('contextPanel.mode.pr');
  if (mode === 'issues') return t('references.picker.tab.issues');
  if (mode === 'ci') return t('gitView.pullRequest.tab.ci');
  if (mode === 'notes') return t('contextRail.surface.notes');
  if (mode === 'terminal') return t('layout.mainTab.terminal');
  if (isPluginContextPanelMode(mode)) {
    const guest = useGuestsStore.getState().guests.find((entry) => entry.id === pluginIdFromMode(mode));
    return guest?.name ?? t('contextRail.surface.plugin');
  }
  return t(CONTEXT_SURFACES.find((surface) => surface.mode === mode)?.labelKey ?? 'contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

export const getTabLabel = (
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; dedupeKey?: string; sessionTitleFallback?: string | null; stagedDiff?: boolean },
  sessionTitleById: ReadonlyMap<string, string>,
  t: TranslateFn
): string => {
  if (tab.mode === 'chat') {
    const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
    if (sessionID) {
      const sessionTitle = sessionTitleById.get(sessionID)?.trim();
      if (sessionTitle) {
        return sessionTitle;
      }
    }

    const sessionTitleFallback = tab.sessionTitleFallback?.trim();
    if (sessionTitleFallback) {
      return sessionTitleFallback;
    }

    return t('contextPanel.mode.chat');
  }

  if (tab.mode === 'browser') {
    return browserUrlLabel(tab.targetPath ?? '') || tab.label || t('contextPanel.mode.browser');
  }

  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'diff') {
    return t('contextPanel.mode.diff');
  }

  return getModeLabel(tab.mode, t);
};

export const getTabIcon = (
  tab: { mode: ContextPanelMode; targetPath: string | null; dedupeKey?: string },
  faviconByOrigin: Record<string, string> = {},
  active = true,
  visible = true,
): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <DiffViewIcon className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'pr') {
    return <TrackerTabIcon url={tab.targetPath} active={active} visible={visible} />;
  }

  if (tab.mode === 'ci') {
    return <Icon name="play-circle" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'notes') {
    return <Icon name="sticky-note" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    const sessionId = getSessionIDFromDedupeKey(tab.dedupeKey);
    return sessionId
      ? <ChatTabIcon sessionId={sessionId} />
      : <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (isPluginContextPanelMode(tab.mode)) {
    return <ContextGuestIcon mode={tab.mode} />;
  }

  if (tab.mode === 'browser') {
    const icon = browserFaviconFor(tab.targetPath ?? '', faviconByOrigin);
    return icon
      ? <img src={icon} alt="" aria-hidden="true" className="h-3.5 w-3.5 rounded-[3px] object-contain" />
      : <Icon name="global" className="h-3.5 w-3.5" />;
  }

  const surface = CONTEXT_SURFACES.find((entry) => entry.mode === tab.mode);
  return surface ? <Icon name={surface.icon} className="h-3.5 w-3.5" /> : undefined;
};

const browserFaviconFor = (url: string, faviconByOrigin: Record<string, string>): string => {
  try {
    return faviconByOrigin[new URL(url).origin] ?? '';
  } catch {
    return '';
  }
};
