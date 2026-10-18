/**
 * OpenCode's experimental usage route (`session.stats`,
 * `GET /api/experimental/session/stats`), translated into the shape the usage
 * page reads.
 *
 * Route semantics (OpenCode 2.0.15, `packages/core/src/session/stats.ts`):
 * - `from`/`to` are epoch milliseconds, `from` inclusive, `to` exclusive.
 *   `to` defaults to now; without `from` the range starts at the oldest
 *   message. `from >= to` is a 400.
 * - `project` is an OpenCode project id, not a directory; without it every
 *   project on the server is counted.
 * - `timezone` is an IANA zone used to bucket `activity` into `YYYY-MM-DD`
 *   days (defaults to UTC, so we always send the viewer's zone).
 * - `tools` selects the tool-call breakdown. Reports use `"none"`; a separate
 *   on-demand `"detail"` read adds per-tool counts and median durations.
 * - Activity exposes step counts only. Per-day token totals come from bounded
 *   SDK reads for active dates, with the same project, zone and fixed window.
 *
 * A failed read throws; it is never a zeroed report.
 */

import type { SessionStatsInfo } from "@opencode/client"
import { CronDate } from "cron-parser"
import { normalizeOpencodeError, opencodeClient } from "./client"

export interface UsageTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface UsageModel {
  providerID: string
  modelID: string
  variant: string | null
  steps: number
  tokens: UsageTokens
  cost: number
  coverage?: UsageCoverage
}

export interface UsageCoverage {
  tokens: { known: number; missing: number }
  cost: { known: number; missing: number }
  reasoning: { known: number; missing: number }
  undated: number
  failedSessions: number
}

export interface UsageSourceState {
  source: 'opencode' | 'claude' | 'codex' | 'deepseek'
  status: 'ok' | 'partial' | 'error' | 'unavailable'
  message?: string
}

export interface UsageActivityDay {
  date: string
  steps: number
  /** Recorded input, output, reasoning and cache tokens; null if none are known. */
  tokens: number | null
  tokensComplete: boolean
}

/** Tool-call counts for the whole report. */
interface UsageToolTotals {
  calls: number
  succeeded: number
  failed: number
  /** Neither completed nor errored: interrupted, pending or unknown state. */
  unfinished: number
}

/** One tool's counts; `detail` reports carry these per tool. */
interface UsageToolUsage {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  /** Median duration of completed calls in ms; absent when none completed. */
  durationP50: number | null
}

/** The tool-call breakdown the request mode produced; `none` carries nothing. */
export type UsageTools = (
  | { mode: "none" }
  | { mode: "summary"; totals: UsageToolTotals }
  | { mode: "detail"; totals: UsageToolTotals; usage: UsageToolUsage[] }
) & { sources?: UsageSourceState[] }

export interface UsageStats {
  range: { from: number; to: number }
  sessions: number
  subagents: number
  prompts: number
  steps: number
  tokens: UsageTokens
  cost: number
  tools: UsageTools
  activeDays: number
  /** Longest run of consecutive active days inside the range. */
  streak: number
  /** Active days only, ascending; days with no model steps are absent. */
  activity: UsageActivityDay[]
  /** Sorted by total tokens, largest first. */
  models: UsageModel[]
  coverage?: UsageCoverage
  sources?: UsageSourceState[]
}

interface UsageStatsQuery {
  from?: number
  to?: number
  /** OpenCode project id; omit for every project. */
  projectID?: string
  timezone: string
}

const toTokens = (tokens: SessionStatsInfo["tokens"]): UsageTokens => ({
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
  cacheRead: tokens.cache.read,
  cacheWrite: tokens.cache.write,
  total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
})

const toTools = (tools: SessionStatsInfo["tools"]): UsageTools => {
  if (tools.mode === "none") return { mode: "none" }
  const totals = {
    calls: tools.totals.calls,
    succeeded: tools.totals.succeeded,
    failed: tools.totals.failed,
    unfinished: tools.totals.unfinished,
  }
  if (tools.mode === "summary") return { mode: "summary", totals }
  return {
    mode: "detail",
    totals,
    usage: tools.usage.map((tool) => ({
      name: tool.name,
      calls: tool.calls,
      succeeded: tool.succeeded,
      failed: tool.failed,
      unfinished: tool.unfinished,
      durationP50: tool.durationP50 ?? null,
    })),
  }
}

const toUsageStats = (info: SessionStatsInfo): UsageStats => ({
  range: { from: info.range.from, to: info.range.to },
  sessions: info.sessions,
  subagents: info.subagents,
  prompts: info.prompts,
  steps: info.steps,
  tokens: toTokens(info.tokens),
  cost: info.cost,
  tools: toTools(info.tools),
  activeDays: info.activeDays,
  streak: info.streak,
  activity: info.activity.map((day) => ({ date: day.date, steps: day.steps, tokens: null, tokensComplete: false })),
  models: info.models.map((entry) => ({
    providerID: entry.model.providerID,
    modelID: entry.model.id,
    variant: entry.model.variant ?? null,
    steps: entry.steps,
    tokens: toTokens(entry.tokens),
    cost: entry.cost,
  })),
})

const requestStats = async (query: UsageStatsQuery, tools: "none" | "detail", signal?: AbortSignal): Promise<SessionStatsInfo> => {
  try {
    signal?.throwIfAborted()
    return await opencodeClient.getSdkClient().session.stats(
      { from: query.from, to: query.to, project: query.projectID, timezone: query.timezone, tools },
      { signal },
    )
  } catch (error) {
    throw normalizeOpencodeError("session.stats", error)
  }
}

type DailyTokenRead = {
  signal: AbortSignal
  read: () => Promise<number>
  complete: (tokens: number | null) => void
}

// Shared across report requests so rapidly changing filters cannot multiply
// the four concurrent reads. Queued reads are removed on cancellation.
const waitingDailyReads = new Set<DailyTokenRead>()
let activeDailyReads = 0
const drainDailyReads = () => {
  while (activeDailyReads < 4) {
    const next = waitingDailyReads.values().next().value
    if (!next) return
    waitingDailyReads.delete(next)
    if (next.signal.aborted) { next.complete(null); continue }
    activeDailyReads += 1
    void Promise.resolve().then(next.read).then(next.complete, () => next.complete(null)).finally(() => {
      activeDailyReads -= 1
      drainDailyReads()
    })
  }
}

const readDailyTokens = (read: () => Promise<number>, signal: AbortSignal): Promise<number | null> => {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const abort = () => task.complete(null)
    const task: DailyTokenRead = {
      signal, read,
      complete: (tokens) => {
        waitingDailyReads.delete(task)
        signal.removeEventListener('abort', abort)
        resolve(tokens)
      },
    }
    signal.addEventListener('abort', abort, { once: true })
    waitingDailyReads.add(task)
    drainDailyReads()
  })
}

const dailyWindow = (date: string, timezone: string, range: UsageStats['range']): UsageStats['range'] => {
  // Advance the calendar date in UTC, then interpret both midnights in the
  // requested zone. A local day can contain 23 or 25 hours.
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return {
    from: Math.max(range.from, new CronDate(`${date}T00:00:00`, timezone).getTime()),
    to: Math.min(range.to, new CronDate(`${next.toISOString().slice(0, 10)}T00:00:00`, timezone).getTime()),
  }
}

/**
 * The report without tool calls: `tools: "none"` keeps OpenCode from scanning
 * every tool call in the range, a cost that grows with history. The server
 * defaults to `summary`, so the mode is always sent.
 */
export async function fetchUsageStats(query: UsageStatsQuery, signal?: AbortSignal): Promise<UsageStats> {
  const report = toUsageStats(await requestStats(query, "none", signal))
  if (!report.activity.length) return report
  const dailySignal = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])])
  let nextDay = 0
  const worker = async () => {
    while (nextDay < report.activity.length && !dailySignal.aborted) {
      const index = nextDay++
      const day = report.activity[index]
      const tokens = await readDailyTokens(async () => {
        const window = dailyWindow(day.date, query.timezone, report.range)
        if (window.from >= window.to) throw new Error('Activity date is outside the report window')
        return toTokens((await requestStats({ ...query, ...window }, "none", dailySignal)).tokens).total
      }, dailySignal)
      report.activity[index] = { ...day, tokens, tokensComplete: tokens !== null }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, report.activity.length) }, worker))
  signal?.throwIfAborted()
  return report
}

/**
 * Tool calls for a report, on request. There is no tools-only mode: the route
 * recomputes the whole report and only `tools` is kept. Pass the loaded
 * report's `range` so the numbers cover the same window as the page.
 */
export async function fetchUsageTools(query: UsageStatsQuery, signal?: AbortSignal): Promise<UsageTools> {
  return toTools((await requestStats(query, "detail", signal)).tools)
}

/** The OpenCode project id a directory belongs to, for the `project` filter. */
export async function resolveUsageProjectID(directory: string): Promise<string> {
  const project = await opencodeClient.getCurrentProject(directory)
  return project.id
}
