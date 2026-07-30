import { expect, mock, test } from "bun:test"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

const {
  assertProviderCircuitClosed,
  captureProviderTrackerLane,
  recordProviderError,
  recordProviderSuccess,
} = await import("./provider-tracker")

test("isolates provider circuit state by runtime", () => {
  const runtimeALane = captureProviderTrackerLane()
  for (let attempt = 0; attempt < 3; attempt += 1) recordProviderError(runtimeALane, "provider", 503)
  expect(() => assertProviderCircuitClosed(runtimeALane, "provider")).toThrow()

  runtimeKey = "runtime-b"
  const runtimeBLane = captureProviderTrackerLane()
  assertProviderCircuitClosed(runtimeBLane, "provider")

  runtimeKey = "runtime-a"
  recordProviderSuccess(runtimeALane, "provider")
  assertProviderCircuitClosed(runtimeALane, "provider")
})

test("keeps a captured lane bound to its originating runtime", () => {
  const runtimeALane = captureProviderTrackerLane()
  runtimeKey = "runtime-b"
  const runtimeBLane = captureProviderTrackerLane()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    recordProviderError(runtimeALane, "late-provider", 503)
  }

  expect(() => assertProviderCircuitClosed(runtimeALane, "late-provider")).toThrow()
  assertProviderCircuitClosed(runtimeBLane, "late-provider")
})
