import { z } from 'zod';

export const desktopFailureSchema = z.enum(['UNSUPPORTED', 'NO_VIRTUAL_SERVER', 'NO_PASSWORD_TOOL', 'NO_DESKTOP', 'NO_DISPLAY', 'START_FAILED', 'STOPPED']);
export type DesktopFailure = z.infer<typeof desktopFailureSchema>;
export const desktopSessionSchema = z.object({ id: z.string().min(1), password: z.string().length(8), display: z.string().regex(/^:\d+$/) });
export const desktopStatusSchema = z.object({
  platform: z.string().min(1),
  missing: z.array(desktopFailureSchema),
  session: z.object({ id: z.string().min(1), display: z.string(), ready: z.boolean() }).nullable(),
  install: z.object({ debian: z.string(), fedora: z.string(), arch: z.string() }),
});
export type DesktopStatus = z.infer<typeof desktopStatusSchema>;
export const desktopStartSchema = z.object({
  width: z.number().int().min(320).max(4096).default(1280),
  height: z.number().int().min(200).max(4096).default(800),
}).refine((request) => request.width * request.height <= 16_000_000);
export type DesktopServiceReply = DesktopStatus | z.infer<typeof desktopSessionSchema> | { ok: true } | { stopped: true } | { error: DesktopFailure | 'UNAUTHORIZED' | 'BAD_REQUEST' | 'NOT_FOUND' | 'REQUEST_FAILED' };
