import type { ExtensionNotificationDelivery } from './extension-channels.js';

interface NotificationSessionTarget {
  url: string;
  directory?: string;
  spaceId?: string;
}

export const buildSessionDeepLinkUrl = (sessionId: string | undefined, directory?: string | null) => {
  if (!sessionId) return '/';
  const search = new URLSearchParams({ session: sessionId });
  if (directory) search.set('directory', directory);
  return `/?${search}`;
};

export const buildSessionNotificationData = (
  sessionId: string | undefined,
  sessionName: string,
  type: ExtensionNotificationDelivery['notification']['kind'],
  directory?: string | null,
  spaceId?: string | null,
) => {
  const target: NotificationSessionTarget = { url: buildSessionDeepLinkUrl(sessionId, directory) };
  if (directory) target.directory = directory;
  if (spaceId) target.spaceId = spaceId;
  return { ...target, sessionId, sessionName, type };
};
