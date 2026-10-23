import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { clampSteps, defaultSettings, mergeSettings, normalizeSettings, normalizeSnapshot, sameSteps } from "../settings"

describe("normalizeSettings", () => {
  test("defaults for undefined and null", () => {
    assert.deepEqual(normalizeSettings(undefined), { animations: { todo: true, running: true }, ui: { todos: true, roster: true }, steps: {} })
    assert.deepEqual(normalizeSettings(null), { animations: { todo: true, running: true }, ui: { todos: true, roster: true }, steps: {} })
  })

  test("keeps booleans and replaces non-booleans with the default", () => {
    assert.deepEqual(normalizeSettings({ animations: { todo: false, running: true } }).animations, {
      todo: false,
      running: true,
    })
    assert.deepEqual(normalizeSettings({ animations: { todo: "yes", running: 1 } }).animations, {
      todo: true,
      running: true,
    })
  })

  test("clamps steps and drops empty-string and non-finite entries", () => {
    assert.deepEqual(normalizeSettings({ steps: { a: 0, b: 999, c: 12.4, "": 10, d: Number.NaN, e: null } }).steps, {
      a: 1,
      b: 200,
      c: 12,
    })
  })

  test("drops __proto__, constructor, and prototype step entries", () => {
    const parsed = JSON.parse('{"steps":{"__proto__":10,"constructor":20,"prototype":30,"ok":40}}')
    assert.deepEqual(normalizeSettings(parsed).steps, { ok: 40 })
  })

  test("a managed list keeps only the managed ids", () => {
    assert.deepEqual(normalizeSettings({ steps: { backend: 30, legacy: 40 } }, ["backend"]).steps, { backend: 30 })
  })

  test("without a managed list both ids are kept", () => {
    assert.deepEqual(normalizeSettings({ steps: { backend: 30, legacy: 40 } }).steps, { backend: 30, legacy: 40 })
  })

  test("a 65-character key is dropped and 200 valid ids keep exactly 128", () => {
    const longKey = "k".repeat(65)
    assert.deepEqual(normalizeSettings({ steps: { [longKey]: 10, ok: 10 } }).steps, { ok: 10 })
    const steps: Record<string, number> = {}
    for (let i = 0; i < 200; i += 1) steps[`id${i}`] = 10
    assert.equal(Object.keys(normalizeSettings({ steps }).steps).length, 128)
  })

  test("defaults ui when it is absent", () => {
    assert.deepEqual(normalizeSettings({}).ui, { todos: true, roster: true })
    assert.deepEqual(normalizeSettings({ ui: null }).ui, { todos: true, roster: true })
  })

  test("a false ui value survives while a non-boolean falls back to true", () => {
    assert.deepEqual(normalizeSettings({ ui: { todos: false, roster: true } }).ui, { todos: false, roster: true })
    assert.deepEqual(normalizeSettings({ ui: { todos: "x", roster: 1 } }).ui, { todos: true, roster: true })
  })
})

describe("clampSteps", () => {
  test("clamps and rounds to the 1..200 range", () => {
    assert.equal(clampSteps(0), 1)
    assert.equal(clampSteps(201), 200)
    assert.equal(clampSteps(12.6), 13)
    assert.equal(clampSteps(Number.NaN), 1)
    assert.equal(clampSteps(Number.POSITIVE_INFINITY), 1)
  })
})

describe("mergeSettings", () => {
  test("toggles only the provided animation key", () => {
    const merged = mergeSettings(defaultSettings(), { animations: { todo: false } }, [])
    assert.deepEqual(merged.animations, { todo: false, running: true })
  })

  test("flips one ui key and leaves the other", () => {
    const merged = mergeSettings(defaultSettings(), { ui: { roster: false } }, [])
    assert.deepEqual(merged.ui, { todos: true, roster: false })
  })

  test("an unknown agent id is ignored", () => {
    const merged = mergeSettings(defaultSettings(), { steps: { bogus: 99 } }, ["backend"])
    assert.deepEqual(merged.steps, {})
  })

  test("null deletes an override, numbers clamp", () => {
    const current = mergeSettings(defaultSettings(), { steps: { backend: 40 } }, ["backend"])
    assert.equal(mergeSettings(current, { steps: { backend: null } }, ["backend"]).steps.backend, undefined)
    assert.equal(mergeSettings(defaultSettings(), { steps: { backend: 0 } }, ["backend"]).steps.backend, 1)
    assert.equal(mergeSettings(defaultSettings(), { steps: { backend: 999 } }, ["backend"]).steps.backend, 200)
    assert.equal(mergeSettings(defaultSettings(), { steps: { backend: 12.4 } }, ["backend"]).steps.backend, 12)
  })

  test("drops __proto__, constructor, and prototype step entries", () => {
    const patch = JSON.parse('{"steps":{"__proto__":10,"constructor":20,"prototype":30}}')
    assert.deepEqual(mergeSettings(defaultSettings(), patch, ["__proto__", "constructor", "prototype"]).steps, {})
  })

  test("neither input object is mutated", () => {
    const current = defaultSettings()
    const patch = { animations: { todo: false }, steps: { backend: 40 } }
    mergeSettings(current, patch, ["backend"])
    assert.deepEqual(current, defaultSettings())
    assert.deepEqual(patch, { animations: { todo: false }, steps: { backend: 40 } })
  })

  test("a non-object patch returns an equal copy", () => {
    const current = mergeSettings(defaultSettings(), { steps: { backend: 40 } }, ["backend"])
    const merged = mergeSettings(current, null, ["backend"])
    assert.deepEqual(merged, current)
    assert.notEqual(merged, current)
    assert.notEqual(merged.steps, current.steps)
  })
})

describe("normalizeSnapshot", () => {
  test("returns a normalized snapshot for a valid payload", () => {
    assert.deepEqual(
      normalizeSnapshot({
        animations: { todo: false, running: true },
        ui: { todos: true, roster: false },
        steps: { backend: 30 },
        defaults: { backend: 20, legacy: null },
        managed: ["backend"],
      }),
      {
        animations: { todo: false, running: true },
        ui: { todos: true, roster: false },
        steps: { backend: 30 },
        defaults: { backend: 20, legacy: null },
        managed: ["backend"],
      },
    )
  })

  test("rounds a fractional default through clampSteps", () => {
    assert.deepEqual(
      normalizeSnapshot({
        animations: { todo: true, running: true },
        steps: {},
        defaults: { backend: 12.6 },
        managed: [],
      })?.defaults,
      { backend: 13 },
    )
  })

  test("returns undefined for invalid payloads", () => {
    assert.equal(normalizeSnapshot(null), undefined)
    assert.equal(
      normalizeSnapshot({ animations: { todo: true, running: true }, steps: {}, defaults: {} }),
      undefined,
    )
    assert.equal(
      normalizeSnapshot({
        animations: { todo: true, running: true },
        steps: {},
        defaults: {},
        managed: "x",
      }),
      undefined,
    )
    assert.equal(
      normalizeSnapshot({ animations: null, steps: {}, defaults: {}, managed: [] }),
      undefined,
    )
  })

  test("caps managed at 32 entries", () => {
    const managed = Array.from({ length: 40 }, (_, i) => `id${i}`)
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      ui: { todos: true, roster: true },
      steps: {},
      defaults: {},
      managed,
    })
    assert.equal(snap?.managed.length, 32)
  })

  test("defaults ui when the field is missing", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
    })
    assert.deepEqual(snap?.ui, { todos: true, roster: true })
  })

  test("an existing valid snapshot without ui still returns a value", () => {
    const snap = normalizeSnapshot({
      animations: { todo: false, running: true },
      steps: { backend: 30 },
      defaults: { backend: 20, legacy: null },
      managed: ["backend"],
    })
    assert.deepEqual(snap, {
      animations: { todo: false, running: true },
      ui: { todos: true, roster: true },
      steps: { backend: 30 },
      defaults: { backend: 20, legacy: null },
      managed: ["backend"],
    })
  })
})

describe("sameSteps", () => {
  test("is true for the same entries in a different insertion order", () => {
    assert.equal(sameSteps({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  })

  test("is false for a different value and a different key set", () => {
    assert.equal(sameSteps({ a: 1 }, { a: 2 }), false)
    assert.equal(sameSteps({ a: 1 }, { b: 1 }), false)
  })
})
