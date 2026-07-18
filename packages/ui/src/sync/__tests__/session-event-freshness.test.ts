import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"

import {
  getSessionRemovalRevision,
  recordSessionRemoval,
  resetSessionRemovalHistory,
  shouldSkipStaleSessionEvent,
  wasSessionRemovedSince,
} from "../session-event-freshness"

const buildSession = (title: string, time: Partial<NonNullable<Session["time"]>>): Session => ({
  id: "ses_1",
  title,
  time: time as Session["time"],
} as Session)

describe("shouldSkipStaleSessionEvent", () => {
  test("skips a stale SSE session update after a newer local rename", () => {
    const current = buildSession("New Title", { created: 1, updated: 20 })
    const incoming = buildSession("Old Title", { created: 1, updated: 10 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })

  test("allows a fresher SSE update to apply", () => {
    const current = buildSession("Old Title", { created: 1, updated: 10 })
    const incoming = buildSession("New Title", { created: 1, updated: 20 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(false)
  })

  test("falls back to created timestamp when updated is missing", () => {
    const current = buildSession("Current", { created: 20 })
    const incoming = buildSession("Incoming", { created: 10 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })
})

describe("session removal revisions", () => {
  test("records a removal even when no local session row exists", () => {
    resetSessionRemovalHistory()
    const baseline = getSessionRemovalRevision()

    recordSessionRemoval("ses_missing")

    expect(wasSessionRemovedSince("ses_missing", baseline)).toBe(true)
    expect(wasSessionRemovedSince("ses_other", baseline)).toBe(false)
  })
})
