import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  getDirectoryOwnedSessionIds,
  getGlobalSessionStatusRevision,
  resetGlobalSessionStatuses,
  resolveSessionStatusType,
  setGlobalSessionStatus,
  useGlobalSessionStatusStore,
  replaceGlobalSessionStatusById,
} from "./global-session-status"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"
import { resetSessionActivityTiming, useSessionActivityTimingStore } from "./session-activity-timing"

const statusEvent = (sessionID: string, type: "busy" | "retry" | "idle"): Event => ({
  id: `evt-${sessionID}-${type}`,
  type: "session.status",
  properties: { sessionID, status: { type } },
} as Event)

beforeEach(() => {
  resetGlobalSessionStatuses()
  resetSessionOrdering()
  resetSessionActivityTiming()
})

describe("global session status index", () => {
  const activeSessionIds = (): ReadonlySet<string> => useGlobalSessionStatusStore.getState().activeSessionIds

  test("a parent directory snapshot cannot settle a worktree session merely contained in its list", () => {
    const sessions = ["/repo", "/tree"].map((directory) => ({
      id: directory, slug: directory, directory, projectID: "project", title: "Session", version: "1",
      time: { created: 1, updated: 1 },
    }))
    applyGlobalSessionStatusSnapshot("/tree", { "/tree": { type: "busy" } })
    const ownedIds = getDirectoryOwnedSessionIds("/repo", sessions)
    expect(ownedIds).toEqual(["/repo"])
    applyGlobalSessionStatusSnapshot("/repo", {}, ownedIds)
    expect(activeSessionIds().has("/tree")).toBe(true)
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

  test("marks authoritative status snapshots without treating monotonic polls as idle proof", () => {
    applyGlobalSessionStatusSnapshot("/project", {}, ["ses-1"])
    expect(useGlobalSessionStatusStore.getState().statusSnapshotAtByDirectory.has("/project")).toBe(true)

    const timestamp = useGlobalSessionStatusStore.getState().statusSnapshotAtByDirectory.get("/project")
    applyGlobalSessionStatusSnapshot("/project", {}, ["ses-1"], Number.POSITIVE_INFINITY, "monotonic")
    expect(useGlobalSessionStatusStore.getState().statusSnapshotAtByDirectory.get("/project")).toBe(timestamp)
  })

  test("resolves global status before child status and falls back deterministically", () => {
    expect(resolveSessionStatusType("busy", undefined)).toBe("busy")
    expect(resolveSessionStatusType("retry", "idle")).toBe("retry")
    expect(resolveSessionStatusType("idle", "busy")).toBe("idle")
    expect(resolveSessionStatusType(undefined, "busy")).toBe("busy")
    expect(resolveSessionStatusType(undefined, undefined)).toBe("idle")
  })

  test("keeps active membership stable across active status detail and directory updates", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const before = activeSessionIds()

    applyGlobalSessionStatusEvent("/other-repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "retry", attempt: 2, message: "waiting" } },
    } as Event)

    expect(activeSessionIds()).toBe(before)
  })

  test("replaces active membership only when a session becomes idle or active", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const active = activeSessionIds()

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as Event)
    const idle = activeSessionIds()
    expect(idle).not.toBe(active)
    expect(idle?.has("session-a")).toBe(false)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(activeSessionIds()).not.toBe(idle)
    expect(activeSessionIds()?.has("session-a")).toBe(true)
  })

  test("removes deleted sessions from active membership", () => {
    // SAFETY: This fixture matches the SDK event shape consumed by the status event reducer.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const active = activeSessionIds()

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "session-a" },
    } as Event)

    expect(activeSessionIds()).not.toBe(active)
    expect(activeSessionIds().has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
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
    expect(resetState.statusSnapshotAtByDirectory.size).toBe(0)
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

  test("keeps active membership stable for snapshots with the same active IDs", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    const before = activeSessionIds()

    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "retry" },
    }, ["session-a"])

    expect(activeSessionIds()).toBe(before)
  })

  test("updates active membership when a snapshot adds and removes IDs", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    const before = activeSessionIds()

    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "busy" },
      "session-b": { type: "busy" },
    }, ["session-a", "session-b"])
    const added = activeSessionIds()
    expect(added).not.toBe(before)
    expect(added?.has("session-a")).toBe(true)
    expect(added?.has("session-b")).toBe(true)

    applyGlobalSessionStatusSnapshot("/repo", { "session-b": { type: "busy" } }, ["session-a", "session-b"])
    const removed = activeSessionIds()
    expect(removed).not.toBe(added)
    expect(removed?.has("session-a")).toBe(false)
    expect(removed?.has("session-b")).toBe(true)
  })

  test("clears active membership when a runtime reset replaces status state", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)

    replaceGlobalSessionStatusById(new Map())

    expect(activeSessionIds()?.size).toBe(0)
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

  test("publishes status, ordering, and timing once for a large event batch", () => {
    let statusPublications = 0
    let orderingPublications = 0
    let timingPublications = 0
    const unsubscribeStatus = useGlobalSessionStatusStore.subscribe(() => { statusPublications += 1 })
    const unsubscribeOrdering = useSessionOrderingStore.subscribe(() => { orderingPublications += 1 })
    const unsubscribeTiming = useSessionActivityTimingStore.subscribe(() => { timingPublications += 1 })
    const events = Array.from({ length: 1_000 }, (_, index) => ({
      type: "session.status",
      properties: { sessionID: `session-${index}`, status: { type: "busy" } },
    } as Event))

    applyGlobalSessionStatusEvents("/repo", events)

    unsubscribeStatus()
    unsubscribeOrdering()
    unsubscribeTiming()
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.size).toBe(1_000)
    expect(statusPublications).toBe(1)
    expect(orderingPublications).toBe(1)
    expect(timingPublications).toBe(1)
  })

  test("keeps lifecycle event order inside a batch", () => {
    applyGlobalSessionStatusEvents("/repo", [
      {
        type: "session.status",
        properties: { sessionID: "session-a", status: { type: "busy" } },
      } as Event,
      {
        type: "session.deleted",
        properties: { sessionID: "session-a" },
      } as Event,
    ])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useSessionOrderingStore.getState().rankById.has("session-a")).toBe(false)
    expect(useSessionActivityTimingStore.getState().startedAt.has("session-a")).toBe(false)
  })
})
