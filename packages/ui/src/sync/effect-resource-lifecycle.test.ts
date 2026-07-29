import { describe, expect, test } from "bun:test"
import { retainEffectResourceThroughReplay } from "./effect-resource-lifecycle"

describe("retainEffectResourceThroughReplay", () => {
  test("preserves a resource across an immediate Strict Mode setup replay", async () => {
    const resource = {}
    const activeResources = new Set<object>()
    let disposals = 0

    const cleanup = retainEffectResourceThroughReplay(activeResources, resource, () => {
      disposals += 1
    })
    cleanup()
    const replayCleanup = retainEffectResourceThroughReplay(activeResources, resource, () => {
      disposals += 1
    })
    await Promise.resolve()

    expect(disposals).toBe(0)

    replayCleanup()
    await Promise.resolve()
    expect(disposals).toBe(1)
  })

  test("disposes a resource after a real unmount", async () => {
    const resource = {}
    const activeResources = new Set<object>()
    let disposed = false

    retainEffectResourceThroughReplay(activeResources, resource, () => {
      disposed = true
    })()
    await Promise.resolve()

    expect(disposed).toBe(true)
  })
})
