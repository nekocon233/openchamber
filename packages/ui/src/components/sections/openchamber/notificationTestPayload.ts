import type { NotificationPayload } from '@/lib/api/types';

export const buildTestNotificationPayload = (options: {
  title: string;
  body: string;
  sessionId?: string | null;
  sessionDirectory?: string | null;
  currentDirectory?: string | null;
}): NotificationPayload => {
  const sessionId = options.sessionId?.trim();
  const directory = sessionId
    ? (options.sessionDirectory?.trim() || options.currentDirectory?.trim())
    : undefined;

  return {
    title: options.title,
    body: options.body,
    tag: 'openchamber-test',
    kind: 'test',
    ...(sessionId ? { sessionId } : {}),
    ...(directory ? { directory } : {}),
  };
};
