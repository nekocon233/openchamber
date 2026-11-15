import { z } from 'zod';
import { isGuestAttachItem, type GuestItem } from '@openchamber/sdk';
import { desktopFailureSchema, desktopSessionSchema, desktopStatusSchema, type DesktopFailure } from '../contract.ts';
export type { DesktopStatus } from '../contract.ts';

export const readDesktopStatus = (body: string) => desktopStatusSchema.parse(JSON.parse(body));
export const readSession = (body: string) => desktopSessionSchema.parse(JSON.parse(body));
const failureSchema = z.object({ error: desktopFailureSchema });
export const readFailure = (body: string, fallback: DesktopFailure = 'START_FAILED'): DesktopFailure => {
  try { const result = failureSchema.safeParse(JSON.parse(body)); if (result.success) return result.data.error; }
  catch { /* A host refusal can have an empty body. */ }
  return fallback;
};

export const readDesktopUrlItem = (item: GuestItem | null): { id: string; url: string } | null => {
  if (!isGuestAttachItem(item) || item.providerId !== 'openchamber-builtin-desktop') return null;
  const url = item.url.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { id: item.id, url };
};
