import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusSnapshot,
  getGlobalSessionStatusRevision,
  resetGlobalSessionStatuses,
  resolveSessionStatusType,
  setGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from "./global-session-status"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"

const statusEvent = (sessionID: string, type: "busy" | "retry" | "idle"): Event => ({
  id: `evt-${sessionID}-${type}`,
  type: "session.status",
  properties: { sessionID, status: { type } },
} as Event)

describe("global session status index", () => {
  beforeEach(() => {
    resetGlobalSessionStatuses()
    resetSessionOrdering()
  })

  test("preserves full retry status details from live events", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: {
        sessionID: "session-a",
        status: { type: "retry", attempt: 2, message: "waiting" },
      },
    } as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status).toEqual({
      type: "retry",
      attempt: 2,
      message: "waiting",
    })
  })

  test("seeds running state from events and clears it with an authoritative empty snapshot", () => {
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-1", "busy"))
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses-1")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get("ses-1")).toBe("busy")

    applyGlobalSessionStatusSnapshot("/project", {}, ["ses-1"])
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses-1")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get("ses-1")).toBe("idle")
  })

  test("resolves global status before child status and falls back deterministically", () => {
    expect(resolveSessionStatusType("busy", undefined)).toBe("busy")
    expect(resolveSessionStatusType("retry", "idle")).toBe("retry")
    expect(resolveSessionStatusType("idle", "busy")).toBe("idle")
    expect(resolveSessionStatusType(undefined, "busy")).toBe("busy")
    expect(resolveSessionStatusType(undefined, undefined)).toBe("idle")
  })

  test("promotes on active and settled lifecycle edges only", () => {
    applyGlobalSessionStatusEvent("/repo", statusEvent("session-a", "busy"))
    const busyRank = useSessionOrderingStore.getState().rankById.get("session-a")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "retry", attempt: 1, message: "wait", next: 1 } },
    } as Event)
    expect(useSessionOrderingStore.getState().rankById.get("session-a")).toBe(busyRank)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as Event)
    const idleRank = useSessionOrderingStore.getState().rankById.get("session-a")
    expect(idleRank).toBeGreaterThan(busyRank ?? 0)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.error",
      properties: { sessionID: "session-a" },
    } as Event)
    expect(useSessionOrderingStore.getState().rankById.get("session-a")).toBe(idleRank)
  })

  test("clears status and ordering when a session is archived", () => {
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-1", "retry"))
    applyGlobalSessionStatusEvent("/project", {
      id: "evt-archive",
      type: "session.updated",
      properties: {
        sessionID: "ses-1",
        info: { id: "ses-1", time: { created: 1, updated: 2, archived: 3 } },
      },
    } as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.has("ses-1")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.has("ses-1")).toBe(false)
    expect(useSessionOrderingStore.getState().rankById.has("ses-1")).toBe(false)
  })

  test("does not let a delayed empty snapshot erase a newer busy event", () => {
    const baselineRevision = getGlobalSessionStatusRevision()
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-1", "busy"))

    applyGlobalSessionStatusSnapshot("/project", {}, ["ses-1"], baselineRevision)

    expect(useGlobalSessionStatusStore.getState().statusById.get("ses-1")?.status.type).toBe("busy")
  })

  test("does not let a delayed busy snapshot resurrect a newer idle event", () => {
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-1", "busy"))
    const baselineRevision = getGlobalSessionStatusRevision()
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-1", "idle"))

    applyGlobalSessionStatusSnapshot("/project", { "ses-1": { type: "busy" } }, ["ses-1"], baselineRevision)

    expect(useGlobalSessionStatusStore.getState().statusById.has("ses-1")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get("ses-1")).toBe("idle")
  })

  test("does not let a snapshot from a previous runtime repopulate reset state", () => {
    setGlobalSessionStatus("ses-retained-active", "/old-project", "busy")
    setGlobalSessionStatus("ses-retained-idle", "/old-project", "idle")
    const baselineRevision = getGlobalSessionStatusRevision()
    resetGlobalSessionStatuses()

    const resetState = useGlobalSessionStatusStore.getState()
    expect(resetState.statusById.size).toBe(0)
    expect(resetState.resolvedStatusById.size).toBe(0)
    expect(resetState.revisionById.size).toBe(0)

    applyGlobalSessionStatusSnapshot(
      "/project",
      { "ses-old-runtime": { type: "busy" } },
      ["ses-old-runtime"],
      baselineRevision,
    )

    expect(useGlobalSessionStatusStore.getState().statusById.has("ses-old-runtime")).toBe(false)
  })

  test("applies monotonic active snapshots without clearing known or explicit idle sessions", () => {
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-existing", "busy"))
    applyGlobalSessionStatusEvent("/project", statusEvent("ses-idle", "busy"))

    applyGlobalSessionStatusSnapshot(
      "/project",
      {
        "ses-new": { type: "retry" },
        "ses-idle": { type: "idle" },
      },
      ["ses-existing", "ses-idle", "ses-new"],
      getGlobalSessionStatusRevision(),
      "monotonic",
    )

    const state = useGlobalSessionStatusStore.getState()
    expect(state.statusById.get("ses-existing")?.status.type).toBe("busy")
    expect(state.statusById.get("ses-idle")?.status.type).toBe("busy")
    expect(state.statusById.get("ses-new")?.status.type).toBe("retry")
    expect(state.resolvedStatusById.get("ses-new")).toBe("retry")
  })

  test("clears an explicitly idle known session when directory aliases differ", () => {
    applyGlobalSessionStatusSnapshot("/canonical/repo", { "session-a": { type: "busy" } }, ["session-a"])
    applyGlobalSessionStatusSnapshot("/alias/repo", { "session-a": { type: "idle" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
  })

  test("protects optimistic busy state from an overtaking idle snapshot for a bounded grace period", () => {
    const originalNow = Date.now
    try {
      Date.now = () => 1_000
      setGlobalSessionStatus("ses-optimistic", "/project", "busy", { optimistic: true })
      const baselineRevision = getGlobalSessionStatusRevision()

      applyGlobalSessionStatusSnapshot("/project", {}, ["ses-optimistic"], baselineRevision)
      expect(useGlobalSessionStatusStore.getState().statusById.get("ses-optimistic")?.status.type).toBe("busy")

      Date.now = () => 11_001
      applyGlobalSessionStatusSnapshot("/project", {}, ["ses-optimistic"], baselineRevision)
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses-optimistic")).toBe(false)
      expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get("ses-optimistic")).toBe("idle")
    } finally {
      Date.now = originalNow
    }
  })

  test("bounds terminal history without evicting live activity", () => {
    const activeIds = Array.from({ length: 25 }, (_, index) => `ses-active-${index}`)
    for (const sessionId of activeIds) {
      setGlobalSessionStatus(sessionId, "/project", "busy")
    }
    for (let index = 0; index < 2_100; index += 1) {
      setGlobalSessionStatus(`ses-inactive-${index}`, "/project", "idle")
    }

    const compacted = useGlobalSessionStatusStore.getState()
    expect(compacted.resolvedStatusById.size <= 2_000 + compacted.statusById.size).toBe(true)
    expect(compacted.revisionById.size <= 2_000 + compacted.statusById.size).toBe(true)
    expect(compacted.revisionFloor).toBeGreaterThan(0)
    expect(compacted.resolvedStatusById.has("ses-inactive-0")).toBe(false)
    for (const sessionId of activeIds) {
      expect(compacted.statusById.get(sessionId)?.status.type).toBe("busy")
      expect(compacted.resolvedStatusById.get(sessionId)).toBe("busy")
      expect(compacted.revisionById.has(sessionId)).toBe(true)
    }

    setGlobalSessionStatus(activeIds[0], "/project", "idle")
    const state = useGlobalSessionStatusStore.getState()
    expect(state.statusById.has(activeIds[0])).toBe(false)
    expect(state.resolvedStatusById.get(activeIds[0])).toBe("idle")
    expect(resolveSessionStatusType(state.resolvedStatusById.get(activeIds[0]), "busy")).toBe("idle")
  })
})
