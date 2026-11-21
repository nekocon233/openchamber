import React from 'react';
import { trackerTargetOfUrl } from '@/components/sourceBoard/openTrackerItem';
import { type RepositoryUrlMatcher, useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { type TrackerUrlMatcher, useTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { useTrackedRecords } from '@/stores/useTrackedItemsStore';
import { repositoryStateLook } from '@/components/references/referencePickerItems';
import { repositoryThread, workItem } from '@/lib/trackedItems/fromLinks';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import type { TrackedItem, TrackedItemState } from '@/lib/trackedItems/model';
import { trackerStateGlyph } from '@/lib/trackers/stateLook';
import { type ContextPanelMode } from '@/stores/useUIStore';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { GuestIcon } from './GuestRailIcon';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';
import { REPOSITORY_KIND_ICONS } from '@/components/references/referencePickerItems';

export const ContextGuestIcon: React.FC<{ mode: ContextPanelMode }> = ({ mode }) => {
  const surfaces = useGuestSurfaces();
  const surface = surfaces.find((entry) => entry.mode === mode);
  return <GuestIcon icon={surface?.icon ?? FALLBACK_GUEST_ICON} iconSrc={surface?.iconSrc} className="h-3.5 w-3.5" />;
};

export const ChatTabIcon: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const activity = useSessionTurnActivity(sessionId);
  return activity
    ? <SessionActivityIndicator state={activity} className="h-3.5 w-3.5" />
    : <Icon name="chat-4" className="h-3.5 w-3.5" />;
};

const NO_TRACKED: TrackedItem[] = [];

const trackedItemOfLink = (url: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): TrackedItem | null => {
  const tracker = trackerUrls(url);
  if (tracker) return workItem(tracker.provider, tracker.identifier);
  const thread = urls.match(url);
  return thread ? repositoryThread(thread.kind, thread) : null;
};

const trackedStateLook = (record: TrackedItemState | null): { icon: IconName; color: string } | null => {
  switch (record?.type) {
    case 'pull':
      return record.state ? repositoryStateLook({ kind: 'pull', state: record.state.state, draft: record.state.draft }, record.state) : null;
    case 'issue':
      return record.state ? repositoryStateLook({ kind: 'issue', state: record.state.state }, null) : null;
    case 'discussion':
      return record.state ? repositoryStateLook({ kind: 'discussion', state: record.state.state, answered: record.state.answered }, null) : null;
    case 'work-item':
      return record.state ? trackerStateGlyph(record.state.state.category) : null;
    default:
      return null;
  }
};

export const TrackerTabIcon: React.FC<{ url: string | null; active: boolean; visible: boolean }> = ({ url, active, visible }) => {
  const urls = useRepositoryUrlMatcher();
  const trackerUrls = useTrackerUrlMatcher();
  const tracked = React.useMemo(() => (url ? trackedItemOfLink(url, urls, trackerUrls) : null), [trackerUrls, url, urls]);
  const followed = React.useMemo(() => (tracked ? [tracked] : []), [tracked]);
  useTrackedItems(visible ? followed : NO_TRACKED);
  const look = trackedStateLook(useTrackedRecords(followed)[0] ?? null);
  const target = url ? trackerTargetOfUrl(url, urls, trackerUrls) : null;
  if (target && look) {
    return <Icon name={look.icon} className="h-3.5 w-3.5" style={active ? undefined : { color: look.color }} />;
  }
  const name: IconName = !target ? 'git-branch'
    : target.source === 'tracker' ? trackerPresentation(target.provider).icon
      : REPOSITORY_KIND_ICONS[target.kind];
  return <Icon name={name} className="h-3.5 w-3.5" />;
};
