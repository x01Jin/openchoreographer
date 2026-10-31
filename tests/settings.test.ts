import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { defaultSettings, mergeSettings, normalizeSettings, normalizeSnapshot } from "../src/shared/settings"

const DEFAULTS = {
  animations: { todo: true, running: true },
  ui: { todos: true, roster: true },
  models: { primary: {}, fallback: {} },
  disabled: [],
  maxParallel: 4,
}

describe("normalizeSettings", () => {
  test("defaults for undefined and null", () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULTS)
    assert.deepEqual(normalizeSettings(null), DEFAULTS)
  })

  test("keeps booleans and replaces non-booleans with the default", () => {
    assert.deepEqual(normalizeSettings({ animations: { todo: false, running: true } }).animations, { todo: false, running: true })
    assert.deepEqual(normalizeSettings({ animations: { todo: "yes", running: 1 } }).animations, { todo: true, running: true })
  })

  test("normalizes primary and fallback model references", () => {
    const settings = normalizeSettings({
      models: {
        primary: { backend: "opencode/big", frontend: "bad", "": "x", __proto__: "x" },
        fallback: { backend: ["opencode/small", "bad"], reviewer: [] },
      },
    })
    assert.deepEqual(settings.models.primary, { backend: "opencode/big" })
    assert.deepEqual(settings.models.fallback, { backend: ["opencode/small"], reviewer: [] })
  })

  test("keeps only known subagent ids in disabled", () => {
    assert.deepEqual(normalizeSettings({ disabled: ["writer", "writer", "orchestrator", "nope", 3] }).disabled, ["writer"])
  })

  test("clamps maxParallel", () => {
    assert.equal(normalizeSettings({ maxParallel: 0 }).maxParallel, 1)
    assert.equal(normalizeSettings({ maxParallel: 99 }).maxParallel, 8)
    assert.equal(normalizeSettings({ maxParallel: 3.7 }).maxParallel, 3)
    assert.equal(normalizeSettings({ maxParallel: "4" }).maxParallel, 4)
  })

  test("ignores legacy steps keys", () => {
    assert.deepEqual(normalizeSettings({ steps: { backend: 30 } }), DEFAULTS)
  })
})

describe("normalizeSnapshot", () => {
  const base = {
    animations: { todo: true, running: true },
    ui: { todos: true, roster: true },
    managed: ["orchestrator", "backend"],
    models: { primary: { backend: "opencode/big" }, fallback: {} },
    configured: { backend: "opencode/big" },
    subagents: ["backend"],
    disabled: ["writer"],
    maxParallel: 2,
    routing: { backend: { model: "opencode/big", fallback: false } },
  }

  test("accepts a complete snapshot", () => {
    const snapshot = normalizeSnapshot(base)
    assert.deepEqual(snapshot, {
      animations: base.animations,
      ui: base.ui,
      managed: base.managed,
      models: { primary: { backend: "opencode/big" }, fallback: {} },
      configured: { backend: "opencode/big" },
      subagents: ["backend"],
      disabled: ["writer"],
      maxParallel: 2,
      routing: { backend: { model: "opencode/big", fallback: false } },
    })
  })

  test("rejects a snapshot without animations or managed", () => {
    assert.equal(normalizeSnapshot({ ...base, animations: null }), undefined)
    assert.equal(normalizeSnapshot({ ...base, managed: undefined }), undefined)
  })

  test("ignores legacy steps and defaults fields", () => {
    const snapshot = normalizeSnapshot({ ...base, steps: { backend: 30 }, defaults: { backend: 30 } })
    assert.ok(snapshot !== undefined)
    assert.ok(!("steps" in snapshot))
    assert.ok(!("defaults" in snapshot))
  })

  test("sanitizes prototype keys in routing and configured", () => {
    const parsed = JSON.parse('{"animations":{"todo":true,"running":true},"ui":{"todos":true,"roster":true},"managed":[],"routing":{"__proto__":{"model":"a/b","fallback":true},"backend":{"model":"a/b","fallback":false}},"configured":{"__proto__":"a/b","backend":"a/b"}}')
    const snapshot = normalizeSnapshot(parsed)
    assert.ok(snapshot !== undefined)
    assert.deepEqual(Object.keys(snapshot.routing), ["backend"])
    assert.deepEqual(Object.keys(snapshot.configured), ["backend"])
  })
})

describe("mergeSettings", () => {
  test("patches known fields and leaves the input untouched", () => {
    const current = defaultSettings()
    const patch = { animations: { todo: false }, ui: { roster: false }, maxParallel: 6, disabled: ["writer"] }
    const merged = mergeSettings(current, patch)
    assert.deepEqual(merged, {
      animations: { todo: false, running: true },
      ui: { todos: true, roster: false },
      models: { primary: {}, fallback: {} },
      disabled: ["writer"],
      maxParallel: 6,
    })
    assert.deepEqual(patch, { animations: { todo: false }, ui: { roster: false }, maxParallel: 6, disabled: ["writer"] })
  })

  test("null clears a model override and a maxParallel override", () => {
    const current = { ...defaultSettings(), maxParallel: 6, models: { primary: { backend: "a/b" }, fallback: { backend: ["a/b"] } } }
    const merged = mergeSettings(current, { models: { primary: { backend: null }, fallback: { backend: null } }, maxParallel: null })
    assert.deepEqual(merged.models, { primary: {}, fallback: {} })
    assert.equal(merged.maxParallel, 4)
  })

  test("ignores unknown model keys and invalid refs", () => {
    const merged = mergeSettings(defaultSettings(), { models: { primary: { nope: "a/b", backend: "bad" }, fallback: { nope: ["a/b"] } } })
    assert.deepEqual(merged.models, { primary: {}, fallback: {} })
  })

  test("ignores a legacy steps patch", () => {
    const merged = mergeSettings(defaultSettings(), { steps: { backend: 40 } })
    assert.ok(!("steps" in merged))
  })

  test("ignores prototype pollution", () => {
    const patch = JSON.parse('{"models":{"primary":{"__proto__":"a/b","constructor":"a/b"}},"disabled":["__proto__"]}')
    const merged = mergeSettings(defaultSettings(), patch)
    assert.deepEqual(merged.models.primary, {})
    assert.deepEqual(merged.disabled, [])
  })
})
