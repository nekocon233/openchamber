import { z } from 'zod';
import { isGuestAttachItem, type GuestItem, type JsonValue } from '@openchamber/sdk';
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

export type DesktopDisplayResolution = { width: number; height: number };

const DESKTOP_DISPLAY_RATIOS = ['auto', '16:9', '16:10', '4:3'] as const;
export type DesktopDisplayRatio = (typeof DESKTOP_DISPLAY_RATIOS)[number];

const displayRatioSchema = z.enum(DESKTOP_DISPLAY_RATIOS);

export const DESKTOP_DISPLAY_PRESETS = {
  '16:9': { width: 1920, height: 1080, label: '16:9 (1920×1080)' },
  '16:10': { width: 1440, height: 900, label: '16:10 (1440×900)' },
  '4:3': { width: 1280, height: 960, label: '4:3 (1280×960)' },
} as const satisfies Record<Exclude<DesktopDisplayRatio, 'auto'>, DesktopDisplayResolution & { label: string }>;

export const readDisplayRatio = (value: JsonValue | undefined): DesktopDisplayRatio => displayRatioSchema.catch('auto').parse(value);

export const targetDesktopResolution = (ratio: DesktopDisplayRatio): DesktopDisplayResolution | null => {
  if (ratio === 'auto') return null;
  const { width, height } = DESKTOP_DISPLAY_PRESETS[ratio];
  return { width, height };
};

export const resolveSessionSize = (
  ratio: DesktopDisplayRatio,
  viewportSize: DesktopDisplayResolution,
): DesktopDisplayResolution => targetDesktopResolution(ratio) ?? viewportSize;

export const displayRatioOptions = (autoLabel: string): Array<{ value: DesktopDisplayRatio; label: string }> => [
  { value: 'auto', label: autoLabel },
  ...(['16:9', '16:10', '4:3'] as const).map((ratio) => ({
    value: ratio,
    label: DESKTOP_DISPLAY_PRESETS[ratio].label,
  })),
];

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
