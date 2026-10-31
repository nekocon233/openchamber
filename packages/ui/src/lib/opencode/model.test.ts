import { describe, expect, test } from "bun:test"
import { findCatalogModel } from "./model"

// OpenCode derives a Fast entry from the base model: its own catalog `id`,
// the base model's provider API `modelID`.
const luna = { id: "gpt-6-luna", modelID: "gpt-6-luna" }
const lunaFast = { id: "gpt-6-luna-fast", modelID: "gpt-6-luna" }

describe("findCatalogModel", () => {
  test("finds a derived entry by its catalog id", () => {
    expect(findCatalogModel([luna, lunaFast], "gpt-6-luna-fast")).toBe(lunaFast)
  })

  test("prefers the exact id over a shared provider API name", () => {
    expect(findCatalogModel([lunaFast, luna], "gpt-6-luna")).toBe(luna)
  })

  test("falls back to the provider API name when no id matches", () => {
    const aliased = { id: "my-alias", modelID: "vendor-model-v3" }
    expect(findCatalogModel([aliased], "vendor-model-v3")).toBe(aliased)
  })

  test("returns undefined for a missing list or id", () => {
    expect(findCatalogModel(undefined, "gpt-6-luna")).toBeUndefined()
    expect(findCatalogModel([luna], "")).toBeUndefined()
  })

  test("resolves saved native effort slugs without adding picker rows or guessing suffixes", () => {
    const family = { id: 'gemini-test', modelID: 'gemini-test', nativeAliases: [{ id: 'gemini-test-low', variant: 'low' }] }
    const models = [family]
    expect(findCatalogModel(models, 'gemini-test-low')).toBe(family)
    expect(findCatalogModel(models, 'gemini-test-max')).toBeUndefined()
    const exact = { id: 'gemini-test-low', modelID: 'gemini-test-low' }
    expect(findCatalogModel([family, exact], exact.id)).toBe(exact)
    expect(models).toHaveLength(1)
  })
})
