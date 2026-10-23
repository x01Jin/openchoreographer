import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { chooseModel, createBreaker, isQuotaError, parseModel, type ParsedModel } from "../fallback"

function model(id: string): ParsedModel {
  const parsed = parseModel(id)
  if (parsed === undefined) throw new Error(`fixture "${id}" must parse`)
  return parsed
}

function asError(value: unknown): { status?: number; message?: string } {
  return value as unknown as { status?: number; message?: string }
}

describe("parseModel", () => {
  test("accepts provider/model", () => {
    assert.deepEqual(parseModel("anthropic/claude-sonnet-4"), {
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      key: "anthropic/claude-sonnet-4",
    })
  })

  test("splits provider/model#variant and keeps the variant out of key", () => {
    const parsed = parseModel("openai/gpt-5#high")
    assert.deepEqual(parsed, { providerID: "openai", modelID: "gpt-5", variant: "high", key: "openai/gpt-5" })
    assert.equal(parsed?.key, "openai/gpt-5")
    assert.ok(!parsed?.key.includes("#"))
  })

  test("rejects an empty string", () => {
    assert.equal(parseModel(""), undefined)
  })

  test("rejects any whitespace anywhere in the value", () => {
    assert.equal(parseModel(" anthropic/claude"), undefined)
    assert.equal(parseModel("anthropic/claude "), undefined)
    assert.equal(parseModel("anthropic/claude sonnet"), undefined)
    assert.equal(parseModel("anthropic/claude\n"), undefined)
    assert.equal(parseModel("anthropic/claude\t#high"), undefined)
  })

  test("rejects more than one #", () => {
    assert.equal(parseModel("openai/gpt-5#high#low"), undefined)
  })

  test("rejects an empty variant", () => {
    assert.equal(parseModel("openai/gpt-5#"), undefined)
  })

  test("rejects a leading or trailing slash", () => {
    assert.equal(parseModel("/claude"), undefined)
    assert.equal(parseModel("anthropic/"), undefined)
    assert.equal(parseModel("/"), undefined)
  })

  test("rejects a value with no slash", () => {
    assert.equal(parseModel("claude-sonnet-4"), undefined)
  })

  test("rejects non-string input", () => {
    assert.equal(parseModel(undefined), undefined)
    assert.equal(parseModel(null), undefined)
    assert.equal(parseModel(42), undefined)
    assert.equal(parseModel({ providerID: "a", modelID: "b" }), undefined)
  })
})

describe("isQuotaError", () => {
  test("treats status 429 and 402 as quota errors", () => {
    assert.equal(isQuotaError({ status: 429 }), true)
    assert.equal(isQuotaError({ status: 402 }), true)
    assert.equal(isQuotaError({ status: 429, message: "slow down" }), true)
  })

  test("treats an explicit non-quota status as authoritative over the message", () => {
    assert.equal(isQuotaError({ status: 500, message: "rate limit exceeded" }), false)
    assert.equal(isQuotaError({ status: 503, message: "insufficient_quota" }), false)
    assert.equal(isQuotaError({ status: 400, message: "monthly limit reached" }), false)
  })

  test("matches an underscore-shaped quota code in the message", () => {
    assert.equal(isQuotaError({ message: "insufficient_quota" }), true)
  })

  test("matches quota prose in the message", () => {
    assert.equal(isQuotaError({ message: "monthly limit reached" }), true)
    assert.equal(isQuotaError({ message: "You have hit the rate limit for this model" }), true)
  })

  test("rejects an unrelated message", () => {
    assert.equal(isQuotaError({ message: "model not found" }), false)
    assert.equal(isQuotaError({ message: "" }), false)
  })

  test("rejects missing input", () => {
    assert.equal(isQuotaError(asError(undefined)), false)
    assert.equal(isQuotaError(asError(null)), false)
    assert.equal(isQuotaError({}), false)
  })
})

describe("createBreaker", () => {
  const INITIAL = 300_000
  const MAX = 1_800_000

  function harness(options?: { initialMs?: number; maxMs?: number }) {
    let clock = 0
    const breaker = createBreaker({
      initialMs: options?.initialMs ?? INITIAL,
      maxMs: options?.maxMs ?? MAX,
      now: () => clock,
    })
    return {
      breaker,
      at: () => clock,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  test("first failure opens the initial window", () => {
    const { breaker, at } = harness()
    const target = model("p/a")
    assert.equal(breaker.fail(target), INITIAL)
    assert.equal(breaker.available(target), false)
    assert.equal(breaker.waitMs(target), INITIAL)
    assert.deepEqual(breaker.snapshot(), [{ model: "p/a", waitMs: INITIAL }])
    assert.equal(at(), 0)
  })

  test("a failure inside the open window re-arms from the new failure time", () => {
    const { breaker, advance } = harness()
    const target = model("p/a")
    breaker.fail(target)
    advance(1_000)
    assert.equal(breaker.fail(target), INITIAL)
    assert.equal(breaker.waitMs(target), INITIAL)
    assert.deepEqual(breaker.snapshot(), [{ model: "p/a", waitMs: INITIAL }])
    assert.equal(breaker.available(target), false)
  })

  test("a failure after the window elapses doubles the backoff", () => {
    const { breaker, advance } = harness()
    const target = model("p/a")
    breaker.fail(target)
    advance(INITIAL)
    assert.equal(breaker.available(target), true)
    assert.equal(breaker.fail(target), INITIAL * 2)
    assert.equal(breaker.waitMs(target), INITIAL * 2)
  })

  test("repeated failures never wait longer than maxMs", () => {
    const maxMs = 600_000
    const { breaker, advance } = harness({ initialMs: INITIAL, maxMs })
    const target = model("p/a")
    let wait = breaker.fail(target)
    assert.ok(wait <= maxMs)
    for (let i = 0; i < 5; i += 1) {
      advance(wait)
      wait = breaker.fail(target)
      assert.ok(wait <= maxMs, `wait ${wait} exceeded maxMs ${maxMs}`)
      assert.ok(breaker.waitMs(target) <= maxMs, `waitMs exceeded maxMs ${maxMs}`)
    }
    assert.equal(wait, maxMs)
  })

  test("a retryAfterMs hint above maxMs is clamped", () => {
    const maxMs = 60_000
    const { breaker } = harness({ initialMs: INITIAL, maxMs })
    const target = model("p/a")
    assert.equal(breaker.fail(target, { retryAfterMs: 10_000_000 }), maxMs)
    assert.equal(breaker.waitMs(target), maxMs)
  })

  test("available flips false then true once the clock passes until", () => {
    const { breaker, advance } = harness()
    const target = model("p/a")
    breaker.fail(target)
    advance(INITIAL - 1)
    assert.equal(breaker.available(target), false)
    advance(1)
    assert.equal(breaker.available(target), true)
  })

  test("succeed clears the entry", () => {
    const { breaker } = harness()
    const target = model("p/a")
    breaker.fail(target)
    breaker.succeed(target)
    assert.equal(breaker.available(target), true)
    assert.equal(breaker.waitMs(target), 0)
    assert.deepEqual(breaker.snapshot(), [])
  })

  test("succeed with a since older than the last failure does not clear the entry", () => {
    const { breaker, advance } = harness()
    const target = model("p/a")
    advance(1_000)
    breaker.fail(target)
    breaker.succeed(target, 500)
    assert.equal(breaker.available(target), false)
    assert.equal(breaker.waitMs(target), INITIAL)
  })

  test("waitMs never goes negative", () => {
    const { breaker, advance } = harness()
    const target = model("p/a")
    breaker.fail(target)
    advance(INITIAL * 5)
    assert.equal(breaker.waitMs(target), 0)
  })

  test("snapshot lists only entries still inside their window", () => {
    const { breaker, advance } = harness()
    const expired = model("p/a")
    const active = model("p/b")
    breaker.fail(expired)
    advance(INITIAL)
    breaker.fail(active)
    assert.deepEqual(breaker.snapshot(), [{ model: "p/b", waitMs: INITIAL }])
  })

  test("tracks models by key, so variants share one window", () => {
    const { breaker } = harness()
    breaker.fail(model("p/a#high"))
    assert.equal(breaker.available(model("p/a#low")), false)
    assert.deepEqual(breaker.snapshot(), [{ model: "p/a", waitMs: INITIAL }])
  })
})

describe("chooseModel", () => {
  const primary = model("p/primary")
  const first = model("p/first")
  const second = model("p/second")

  test("an available primary wins", () => {
    assert.deepEqual(
      chooseModel({ primary, alternates: [first], available: () => true }),
      { model: primary, primary, fellBack: false },
    )
  })

  test("an unavailable primary picks the first available alternate and reports the fallback", () => {
    const selection = chooseModel({
      primary,
      alternates: [first, second],
      available: (candidate) => candidate.key !== "p/primary",
    })
    assert.deepEqual(selection, { model: first, primary, fellBack: true })
  })

  test("skips unavailable alternates in order", () => {
    const selection = chooseModel({
      primary,
      alternates: [first, second],
      available: (candidate) => candidate.key === "p/second",
    })
    assert.deepEqual(selection, { model: second, primary, fellBack: true })
  })

  test("returns the last alternate when every model is exhausted", () => {
    const selection = chooseModel({ primary, alternates: [first, second], available: () => false })
    assert.deepEqual(selection, { model: second, primary, fellBack: true })
  })

  test("returns the unavailable primary unchanged when there are no alternates", () => {
    assert.deepEqual(
      chooseModel({ primary, alternates: [], available: () => false }),
      { model: primary, primary, fellBack: false },
    )
  })

  test("returns nothing when there is no primary", () => {
    assert.deepEqual(
      chooseModel({ primary: undefined, alternates: [first], available: () => true }),
      { model: undefined, primary: undefined, fellBack: false },
    )
  })
})
