import { z } from 'zod';

const stamp = z.string().transform(value => Date.parse(value)).pipe(z.number().finite().nonnegative());
const pointSchema = z.object({
  at: stamp,
  left: z.number().min(0).max(100),
  start: stamp.optional(),
  resetsAt: stamp.optional(),
});
const lineSchema = z.object({ name: z.string().min(1), points: z.array(pointSchema) });
const accountSchema = z.object({ provider: z.string().min(1), user: z.string(), lines: z.array(z.unknown()) });

type HistoryPoint = z.infer<typeof pointSchema>;
type HistoryLines = Map<string, HistoryPoint[] | undefined>;

export type MagpieHistory = Map<string, HistoryLines | undefined>;

export interface MagpieTrend {
  points: { at: number; left: number }[];
  cycle?: { start: number; reset: number } | undefined;
  matchesSnapshot: boolean;
}

const MAX_TREND_POINTS = 96;
const RESET_SLACK_MS = 5 * 60_000;

export const magpieHistoryKey = (provider: string, user: string | undefined) =>
  JSON.stringify([provider, (user ?? '').toLowerCase()]);

export const magpieHistorySchema = z.object({ object: z.literal('list'), data: z.array(z.unknown()) }).transform(({ data }) => {
  const accounts: MagpieHistory = new Map();
  for (const rawAccount of data) {
    const account = accountSchema.safeParse(rawAccount);
    if (!account.success) continue;
    const { provider, user, lines } = account.data;
    const key = magpieHistoryKey(provider, user);
    if (accounts.has(key)) {
      accounts.set(key, undefined);
      continue;
    }
    const windows: HistoryLines = new Map();
    for (const rawLine of lines) {
      const line = lineSchema.safeParse(rawLine);
      if (!line.success) continue;
      const { name, points } = line.data;
      const ordered = points.every((point, index) => (points[index - 1]?.at ?? -Infinity) < point.at);
      windows.set(name, windows.has(name) || !ordered ? undefined : points);
    }
    accounts.set(key, windows);
  }
  return accounts;
});
function startsAnotherCycle(previous: HistoryPoint, next: HistoryPoint): boolean {
  if (previous.resetsAt === undefined && next.resetsAt === undefined) return next.left > previous.left + 5;
  if (previous.resetsAt === undefined || next.resetsAt === undefined || next.at >= previous.resetsAt) return true;
  const elapsed = next.at - previous.at;
  const moved = next.resetsAt - previous.resetsAt;
  const rolling = moved > 0 && Math.abs(moved - elapsed) <= RESET_SLACK_MS;
  if (!rolling && Math.abs(moved) <= RESET_SLACK_MS && next.left > previous.left + 5) return true;
  return moved > elapsed + RESET_SLACK_MS || moved < -RESET_SLACK_MS;
}

const wholeSecond = (at: number) => Math.floor(at / 1_000) * 1_000;

export function magpieTrendFor(
  points: HistoryPoint[],
  { sampledAt, remaining, resetAt }: { sampledAt: number | null; remaining: number; resetAt: number | null },
): MagpieTrend | undefined {
  const reset = resetAt === null ? undefined : wholeSecond(resetAt);
  const snapshot = sampledAt !== null && reset !== undefined
    ? { at: sampledAt, left: remaining, resetsAt: reset }
    : undefined;
  let end = points.length - 1;
  if (snapshot) {
    while ((points[end]?.at ?? -Infinity) > snapshot.at) end -= 1;
  }
  const latest = points[end];
  if (!latest) return undefined;
  const matchesSnapshot = snapshot !== undefined && latest.at === wholeSecond(snapshot.at) &&
    latest.resetsAt === snapshot.resetsAt && Math.abs(latest.left - snapshot.left) <= 0.005001;
  if (snapshot && !matchesSnapshot && startsAnotherCycle(latest, snapshot)) return undefined;

  const reportedCycle = latest.start !== undefined && latest.resetsAt !== undefined &&
    latest.start <= latest.at && latest.at < latest.resetsAt
    ? { start: latest.start, reset: latest.resetsAt } : undefined;
  let first = end;
  let earliest = latest;
  let previous = points[first - 1];
  while (previous) {
    if ((reportedCycle && previous.at < reportedCycle.start) || startsAnotherCycle(previous, earliest)) break;
    first -= 1;
    earliest = previous;
    previous = points[first - 1];
  }
  const cycle = reportedCycle && (!previous || previous.at < reportedCycle.start) ? reportedCycle : undefined;
  const followsHistory = snapshot && cycle && cycle.reset === snapshot.resetsAt &&
    snapshot.at < cycle.reset && latest.at < wholeSecond(snapshot.at);
  const snapshotPoint = snapshot && (matchesSnapshot || followsHistory)
    ? { at: snapshot.at, left: snapshot.left }
    : undefined;
  const lastHistoryIndex = matchesSnapshot ? end - 1 : end;
  const count = Math.min(lastHistoryIndex - first + 1, snapshotPoint ? MAX_TREND_POINTS - 1 : MAX_TREND_POINTS);
  const samples = Array.from({ length: count }, (_, index) =>
    points[count === 1 ? lastHistoryIndex : first + Math.round(index * (lastHistoryIndex - first) / (count - 1))]);
  const selected = samples.flatMap(point => point ? [{ at: point.at, left: point.left }] : []);
  if (snapshotPoint) selected.push(snapshotPoint);
  return { points: selected, cycle, matchesSnapshot: snapshotPoint !== undefined };
}
