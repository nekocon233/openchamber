import { z } from 'zod';
import { desktopFailureSchema, desktopSessionSchema, desktopStatusSchema } from '../contract.ts';
export type { DesktopStatus, DesktopMode as Mode } from '../contract.ts';

export const readDesktopStatus = (body: string) => desktopStatusSchema.parse(JSON.parse(body));
export const readSession = (body: string) => desktopSessionSchema.parse(JSON.parse(body));
const failureSchema = z.object({ error: desktopFailureSchema });
export const readFailure = (body: string) => {
  try { const result = failureSchema.safeParse(JSON.parse(body)); if (result.success) return result.data.error; }
  catch { /* A host refusal can have an empty body. */ }
  return 'START_FAILED' as const;
};
