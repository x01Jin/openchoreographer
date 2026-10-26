import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { clampSteps, defaultSettings, mergeSettings, normalizeSettings, normalizeSnapshot } from "../src/shared/settings"

describe("normalizeSettings", () => {
  test("defaults for undefined and null", () => {
    assert.deepEqual(normalizeSettings(undefined), { animations: { todo: true, running: true }, ui: { todos: true, roster: true }, steps: {}, models: { primary: {}, fallback: {} }, disabled: [], maxParallel: 4 })
    assert.deepEqual(normalizeSettings(null), { animations: { todo: true, running: true }, ui: { todos: true, roster: true }, steps: {}, models: { primary: {}, fallback: {} }, disabled: [], maxParallel: 4 })
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
    assert.deepEqual(normalizeSettings({ steps: { a: 0, b: 2001, c: 12.4, "": 10, d: Number.NaN, e: null } }).steps, {
      a: 1,
      b: 2000,
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
  test("clamps and rounds to the 1..2000 range", () => {
    assert.equal(clampSteps(0), 1)
    assert.equal(clampSteps(201), 201)
    assert.equal(clampSteps(2001), 2000)
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
    assert.equal(mergeSettings(defaultSettings(), { steps: { backend: 2001 } }, ["backend"]).steps.backend, 2000)
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
        models: { primary: {}, fallback: {} },
        configured: {},
        subagents: ["explore", "backend", "frontend", "database", "devops", "tester", "designer", "writer", "reviewer", "reviewer-security", "reviewer-plan", "reviewer-execution", "reviewer-scope"],
        disabled: [],
        maxParallel: 4,
        routing: {},
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
      models: { primary: {}, fallback: {} },
      configured: {},
      subagents: ["explore", "backend", "frontend", "database", "devops", "tester", "designer", "writer", "reviewer", "reviewer-security", "reviewer-plan", "reviewer-execution", "reviewer-scope"],
      disabled: [],
      maxParallel: 4,
      routing: {},
    })
  })

  test("defaults missing models, configured, and subagents instead of returning undefined", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
    })
    assert.deepEqual(snap?.models, { primary: {}, fallback: {} })
    assert.deepEqual(snap?.configured, {})
    assert.deepEqual(snap?.subagents, ["explore", "backend", "frontend", "database", "devops", "tester", "designer", "writer", "reviewer", "reviewer-security", "reviewer-plan", "reviewer-execution", "reviewer-scope"])
  })

  test("keeps stored model overrides on the snapshot", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: ["backend"],
      models: { primary: { backend: "anthropic/claude-sonnet-4" }, fallback: { backend: ["openai/gpt-5"] } },
      configured: { backend: "anthropic/claude-sonnet-4" },
      subagents: ["backend"],
    })
    assert.deepEqual(snap?.models, { primary: { backend: "anthropic/claude-sonnet-4" }, fallback: { backend: ["openai/gpt-5"] } })
    assert.deepEqual(snap?.configured, { backend: "anthropic/claude-sonnet-4" })
    assert.deepEqual(snap?.subagents, ["backend"])
  })

  test("drops a stored orchestrator model while keeping the 13 subagents", () => {
    const subagents = ["explore", "backend", "frontend", "database", "devops", "tester", "designer", "writer", "reviewer", "reviewer-security", "reviewer-plan", "reviewer-execution", "reviewer-scope"]
    const primary: Record<string, string> = { orchestrator: "a/b" }
    const fallback: Record<string, string[]> = { orchestrator: ["a/b"] }
    const configured: Record<string, string> = { orchestrator: "a/b" }
    for (const id of subagents) {
      primary[id] = "a/b"
      fallback[id] = ["a/b"]
      configured[id] = "a/b"
    }
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: ["orchestrator", ...subagents],
      models: { primary, fallback },
      configured,
    })
    assert.equal(snap?.models.primary.orchestrator, undefined)
    assert.equal(snap?.models.fallback.orchestrator, undefined)
    assert.equal(snap?.configured.orchestrator, undefined)
    assert.equal(Object.keys(snap?.models.primary ?? {}).length, 13)
    assert.equal(Object.keys(snap?.models.fallback ?? {}).length, 13)
    assert.equal(Object.keys(snap?.configured ?? {}).length, 13)
    for (const id of subagents) {
      assert.equal(snap?.models.primary[id], "a/b")
      assert.deepEqual(snap?.models.fallback[id], ["a/b"])
      assert.equal(snap?.configured[id], "a/b")
    }
  })
})

describe("defaultSettings models", () => {
  test("ships empty primary and fallback maps", () => {
    assert.deepEqual(defaultSettings().models, { primary: {}, fallback: {} })
  })
})

describe("normalizeSettings models", () => {
  test("fills models for a legacy payload without them", () => {
    assert.deepEqual(normalizeSettings({ steps: { backend: 30 } }).models, { primary: {}, fallback: {} })
    assert.deepEqual(normalizeSettings({}, ["backend"]).models, { primary: {}, fallback: {} })
  })

  test("keeps valid refs including variants", () => {
    const normalized = normalizeSettings({
      models: {
        primary: { backend: "anthropic/claude-sonnet-4", frontend: "openai/gpt-5#high" },
        fallback: { backend: ["openai/gpt-5", "anthropic/claude-sonnet-4#high"] },
      },
    })
    assert.deepEqual(normalized.models, {
      primary: { backend: "anthropic/claude-sonnet-4", frontend: "openai/gpt-5#high" },
      fallback: { backend: ["openai/gpt-5", "anthropic/claude-sonnet-4#high"] },
    })
  })

  test("drops unknown and non-subagent ids from model maps", () => {
    const normalized = normalizeSettings({
      models: {
        primary: { backend: "anthropic/claude-sonnet-4", bogus: "anthropic/claude-sonnet-4" },
        fallback: { backend: ["openai/gpt-5"], bogus: ["openai/gpt-5"] },
      },
    })
    assert.deepEqual(normalized.models, {
      primary: { backend: "anthropic/claude-sonnet-4" },
      fallback: { backend: ["openai/gpt-5"] },
    })
  })

  test("drops __proto__, constructor, and prototype model entries", () => {
    const parsed = JSON.parse('{"models":{"primary":{"__proto__":"a/b","constructor":"a/b","prototype":"a/b","backend":"a/b"},"fallback":{"__proto__":["a/b"],"constructor":["a/b"],"prototype":["a/b"],"backend":["a/b"]}}}')
    assert.deepEqual(normalizeSettings(parsed).models, { primary: { backend: "a/b" }, fallback: { backend: ["a/b"] } })
  })

  test("drops malformed refs and overlong strings", () => {
    const long = "p/" + "x".repeat(200)
    const normalized = normalizeSettings({
      models: {
        primary: { explore: "bad", backend: "", frontend: "a/b c", database: "a/b#", devops: "/x", tester: "a/", designer: long, writer: "a/b" },
        fallback: { explore: ["bad", "a/b"], backend: "a/b", frontend: [42, "a/b"], database: [long] },
      },
    })
    assert.deepEqual(normalized.models.primary, { writer: "a/b" })
    assert.deepEqual(normalized.models.fallback, { explore: ["a/b"], frontend: ["a/b"] })
  })

  test("caps agents at 32 and fallbacks at 8", () => {
    const primary: Record<string, string> = {}
    for (const id of ["explore", "backend", "frontend", "database", "devops", "tester", "designer", "writer", "reviewer", "reviewer-security", "reviewer-plan", "reviewer-execution", "reviewer-scope"]) primary[id] = "a/b"
    for (let i = 0; i < 30; i += 1) primary[`id${i}`] = "a/b"
    assert.equal(Object.keys(normalizeSettings({ models: { primary } }).models.primary).length, 13)
    const refs = Array.from({ length: 12 }, (_, i) => `p/m${i}`)
    assert.equal(normalizeSettings({ models: { fallback: { backend: refs } } }).models.fallback.backend.length, 8)
  })

  test("keeps an explicit empty fallback list", () => {
    assert.deepEqual(normalizeSettings({ models: { fallback: { backend: [] } } }).models.fallback, { backend: [] })
  })

  test("drops orchestrator overrides while keeping a subagent entry", () => {
    const normalized = normalizeSettings({
      models: {
        primary: { orchestrator: "a/b", backend: "c/d" },
        fallback: { orchestrator: ["a/b"], backend: ["c/d"] },
      },
    }, ["orchestrator", "backend"])
    assert.deepEqual(normalized.models, { primary: { backend: "c/d" }, fallback: { backend: ["c/d"] } })
  })
})

describe("mergeSettings models", () => {
  test("sets a primary override", () => {
    const merged = mergeSettings(defaultSettings(), { models: { primary: { backend: "anthropic/claude-sonnet-4" } } }, ["backend"])
    assert.deepEqual(merged.models.primary, { backend: "anthropic/claude-sonnet-4" })
  })

  test("null deletes a primary override", () => {
    const current = mergeSettings(defaultSettings(), { models: { primary: { backend: "a/b" } } }, ["backend"])
    assert.deepEqual(mergeSettings(current, { models: { primary: { backend: null } } }, ["backend"]).models.primary, {})
  })

  test("an invalid primary string leaves the current value untouched", () => {
    const current = mergeSettings(defaultSettings(), { models: { primary: { backend: "a/b" } } }, ["backend"])
    assert.deepEqual(mergeSettings(current, { models: { primary: { backend: "bad" } } }, ["backend"]).models.primary, { backend: "a/b" })
  })

  test("replaces a fallback list and allows an empty list", () => {
    const current = mergeSettings(defaultSettings(), { models: { fallback: { backend: ["a/b"] } } }, ["backend"])
    assert.deepEqual(
      mergeSettings(current, { models: { fallback: { backend: ["c/d", "e/f"] } } }, ["backend"]).models.fallback,
      { backend: ["c/d", "e/f"] },
    )
    assert.deepEqual(
      mergeSettings(current, { models: { fallback: { backend: [] } } }, ["backend"]).models.fallback,
      { backend: [] },
    )
  })

  test("null clears a fallback override", () => {
    const current = mergeSettings(defaultSettings(), { models: { fallback: { backend: ["a/b"] } } }, ["backend"])
    assert.deepEqual(mergeSettings(current, { models: { fallback: { backend: null } } }, ["backend"]).models.fallback, {})
  })

  test("ignores ids outside the managed set", () => {
    const merged = mergeSettings(defaultSettings(), { models: { primary: { bogus: "a/b" }, fallback: { bogus: ["a/b"] } } }, ["backend"])
    assert.deepEqual(merged.models, { primary: {}, fallback: {} })
  })

  test("does not mutate the current models", () => {
    const current = mergeSettings(defaultSettings(), { models: { primary: { backend: "a/b" }, fallback: { backend: ["a/b"] } } }, ["backend"])
    const before = JSON.parse(JSON.stringify(current.models))
    mergeSettings(current, { models: { primary: { backend: "c/d" }, fallback: { backend: ["c/d"] } } }, ["backend"])
    assert.deepEqual(current.models, before)
  })

  test("drops orchestrator overrides from a patch while keeping a subagent entry", () => {
    const merged = mergeSettings(
      defaultSettings(),
      { models: { primary: { orchestrator: "a/b", backend: "c/d" }, fallback: { orchestrator: ["a/b"], backend: ["c/d"] } } },
      ["orchestrator", "backend"],
    )
    assert.deepEqual(merged.models, { primary: { backend: "c/d" }, fallback: { backend: ["c/d"] } })
  })

  test("drops a stored orchestrator entry that predates the fix", () => {
    const current = { ...defaultSettings(), models: { primary: { orchestrator: "a/b", backend: "c/d" }, fallback: { orchestrator: ["a/b"], backend: ["c/d"] } } }
    const merged = mergeSettings(current, {}, ["orchestrator", "backend"])
    assert.deepEqual(merged.models, { primary: { backend: "c/d" }, fallback: { backend: ["c/d"] } })
  })
})

describe("normalizeSettings disabled", () => {
  test("fills disabled for a legacy payload without it", () => {
    assert.deepEqual(normalizeSettings({ steps: { backend: 30 } }).disabled, [])
    assert.deepEqual(normalizeSettings({}).disabled, [])
  })

  test("filters orchestrator, general, bogus, non-string, and duplicate entries", () => {
    assert.deepEqual(normalizeSettings({ disabled: ["backend", "orchestrator", "general", "bogus", "backend", 42, null] }).disabled, ["backend"])
  })

  test("accepts every subagent id once with duplicates collapsed in input order", () => {
    const ids = ["explore", "backend", "frontend", "database", "devops", "tester", "designer", "writer", "reviewer", "reviewer-security", "reviewer-plan", "reviewer-execution", "reviewer-scope"]
    const reversed = [...ids].reverse()
    const disabled = normalizeSettings({ disabled: [...reversed, reversed[0], reversed[1]] }).disabled
    assert.deepEqual(disabled, reversed)
  })

  test("bounds the scan for a huge invalid list", () => {
    const invalid = Array.from({ length: 100 }, (_, i) => `bogus${i}`)
    assert.deepEqual(normalizeSettings({ disabled: invalid }).disabled, [])
  })
})

describe("mergeSettings disabled", () => {
  test("an array patch replaces the current list", () => {
    const current = mergeSettings(defaultSettings(), { disabled: ["backend"] }, [])
    assert.deepEqual(mergeSettings(current, { disabled: ["frontend", "tester"] }, []).disabled, ["frontend", "tester"])
  })

  test("a non-array patch leaves the current list untouched", () => {
    const current = mergeSettings(defaultSettings(), { disabled: ["backend"] }, [])
    assert.deepEqual(mergeSettings(current, { disabled: "frontend" }, []).disabled, ["backend"])
    assert.deepEqual(mergeSettings(current, {}, []).disabled, ["backend"])
  })

  test("orchestrator, bogus, and duplicate patch entries are filtered", () => {
    assert.deepEqual(mergeSettings(defaultSettings(), { disabled: ["backend", "orchestrator", "bogus", "backend"] }, []).disabled, ["backend"])
  })
})

describe("normalizeSnapshot disabled", () => {
  test("defaults a missing disabled to []", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
    })
    assert.deepEqual(snap?.disabled, [])
  })

  test("a stored list is preserved", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
      disabled: ["backend", "frontend"],
    })
    assert.deepEqual(snap?.disabled, ["backend", "frontend"])
  })
})

describe("normalizeSettings maxParallel", () => {
  test("floors fractions and clamps to 1..8", () => {
    assert.equal(normalizeSettings({ maxParallel: 3.7 }).maxParallel, 3)
    assert.equal(normalizeSettings({ maxParallel: 0 }).maxParallel, 1)
    assert.equal(normalizeSettings({ maxParallel: 9 }).maxParallel, 8)
  })

  test("absent, non-number, and non-finite values fall back to 4", () => {
    assert.equal(normalizeSettings({}).maxParallel, 4)
    assert.equal(normalizeSettings({ maxParallel: "4" }).maxParallel, 4)
    assert.equal(normalizeSettings({ maxParallel: null }).maxParallel, 4)
    assert.equal(normalizeSettings({ maxParallel: Number.NaN }).maxParallel, 4)
    assert.equal(normalizeSettings({ maxParallel: Number.POSITIVE_INFINITY }).maxParallel, 4)
  })
})

describe("mergeSettings maxParallel", () => {
  test("sets a finite number", () => {
    assert.equal(mergeSettings(defaultSettings(), { maxParallel: 2 }, []).maxParallel, 2)
  })

  test("null resets to 4", () => {
    const current = mergeSettings(defaultSettings(), { maxParallel: 2 }, [])
    assert.equal(mergeSettings(current, { maxParallel: null }, []).maxParallel, 4)
  })

  test("floors and clamps", () => {
    assert.equal(mergeSettings(defaultSettings(), { maxParallel: 3.7 }, []).maxParallel, 3)
    assert.equal(mergeSettings(defaultSettings(), { maxParallel: 0 }, []).maxParallel, 1)
    assert.equal(mergeSettings(defaultSettings(), { maxParallel: 9 }, []).maxParallel, 8)
  })

  test("a single patch with disabled and maxParallel keeps both", () => {
    const merged = mergeSettings(defaultSettings(), { disabled: ["writer"], maxParallel: 2 }, [])
    assert.deepEqual(merged.disabled, ["writer"])
    assert.equal(merged.maxParallel, 2)
  })
})

describe("normalizeSnapshot maxParallel", () => {
  test("defaults to 4 when missing", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
    })
    assert.equal(snap?.maxParallel, 4)
  })

  test("keeps a stored override", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
      maxParallel: 2,
    })
    assert.equal(snap?.maxParallel, 2)
  })

  test("clamps a stored override and resets invalid values to 4", () => {
    const clamped = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
      maxParallel: 9,
    })
    assert.equal(clamped?.maxParallel, 8)
    for (const invalid of [null, "4", Number.NaN]) {
      const snap = normalizeSnapshot({
        animations: { todo: true, running: true },
        steps: {},
        defaults: {},
        managed: [],
        maxParallel: invalid,
      })
      assert.equal(snap?.maxParallel, 4)
    }
  })
})

describe("normalizeSnapshot routing", () => {
  function base(routing: unknown) {
    return {
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
      routing,
    };
  }

  test("defaults a missing routing to {}", () => {
    const snap = normalizeSnapshot({
      animations: { todo: true, running: true },
      steps: {},
      defaults: {},
      managed: [],
    });
    assert.deepEqual(snap?.routing, {});
  });

  test("keeps valid entries including variants", () => {
    const snap = normalizeSnapshot(base({
      backend: { model: "anthropic/claude-sonnet-4", fallback: true },
      frontend: { model: "openai/gpt-5#high", fallback: false },
    }));
    assert.deepEqual(snap?.routing, {
      backend: { model: "anthropic/claude-sonnet-4", fallback: true },
      frontend: { model: "openai/gpt-5#high", fallback: false },
    });
  });

  test("drops malformed entries and keeps the valid ones", () => {
    const snap = normalizeSnapshot(base({
      backend: { model: "a/b", fallback: true },
      orchestrator: { model: "a/b", fallback: false },
      bogus: { model: "a/b", fallback: false },
      explore: { model: "bad", fallback: true },
      frontend: { model: "a/b", fallback: "yes" },
      database: { model: "a/b" },
      devops: "a/b",
      tester: null,
      writer: { model: "", fallback: false },
    }));
    assert.deepEqual(snap?.routing, {
      backend: { model: "a/b", fallback: true },
    });
  });

  test("drops __proto__, constructor, and prototype routing entries", () => {
    const parsed = JSON.parse('{"animations":{"todo":true,"running":true},"steps":{},"defaults":{},"managed":[],"routing":{"__proto__":{"model":"a/b","fallback":true},"constructor":{"model":"a/b","fallback":true},"prototype":{"model":"a/b","fallback":true},"backend":{"model":"a/b","fallback":false}}}');
    assert.deepEqual(normalizeSnapshot(parsed)?.routing, {
      backend: { model: "a/b", fallback: false },
    });
  });

  test("a non-object routing resets to {}", () => {
    for (const invalid of [null, 42, "a/b", [{ model: "a/b", fallback: true }]]) {
      assert.deepEqual(normalizeSnapshot(base(invalid))?.routing, {}, JSON.stringify(invalid));
    }
  });
})
