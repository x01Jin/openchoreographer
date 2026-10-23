import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  AGENT_IDS,
  LENSES,
  MAX_RESULT_CHARS,
  STEP_DEFAULTS,
  buildDelegationText,
  buildReviewBrief,
  clipResult,
  normalizeOptions,
  validateDiffInput,
  type Options,
} from "../shared"
import { STEPS_MAX, STEPS_MIN } from "../settings"

function options(overrides: Partial<Options> = {}): Options {
  return { agent: "orchestrator", maxParallel: 4, maxReviewers: 2, fallback: {}, ...overrides }
}

// normalizeOptions reports bad input on console.warn; these tests assert returned values only.
function muted<T>(run: () => T): T {
  const original = console.warn
  console.warn = () => {}
  try {
    return run()
  } finally {
    console.warn = original
  }
}

const DROP_MARKER = /\n… (\d+) chars dropped \(result over (\d+)\); read the diff and files for evidence\n/

function loneSurrogates(text: string): string[] {
  const found: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) found.push(`high@${index}`)
      else index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      found.push(`low@${index}`)
    }
  }
  return found
}

function longReport(): string {
  const middle = Array.from({ length: 600 }, (_, index) => `middle line ${index} ${"x".repeat(20)}`)
  return ["TASK: keep the head", "FILES: a.ts added 1", ...middle, "BLOCKED: nothing", "RISK: keep the tail"].join("\n")
}

describe("clipResult", () => {
  test("returns text at or under the limit unchanged", () => {
    assert.equal(clipResult("hello"), "hello")
    const exact = "a".repeat(MAX_RESULT_CHARS)
    assert.equal(clipResult(exact), exact)
    assert.equal(clipResult("🙂🙂"), "🙂🙂")
  })

  test("clips one character over the limit and never exceeds the limit", () => {
    const text = "a".repeat(MAX_RESULT_CHARS + 1)
    const out = clipResult(text)
    assert.ok(out.length <= MAX_RESULT_CHARS, `got ${out.length}`)
    assert.notEqual(out, text)
    assert.match(out, DROP_MARKER)
  })

  test("honours a custom limit", () => {
    const out = clipResult("b".repeat(5_000), 500)
    assert.ok(out.length <= 500, `got ${out.length}`)
  })

  test("keeps the first line at the head and the last line at the tail", () => {
    const text = longReport()
    assert.ok(text.length > MAX_RESULT_CHARS, `fixture is only ${text.length} chars`)
    const out = clipResult(text)
    assert.ok(out.length <= MAX_RESULT_CHARS)
    assert.ok(out.startsWith("TASK: keep the head\n"), "head lost the TASK line")
    assert.ok(out.endsWith("\nRISK: keep the tail"), "tail lost the RISK line")
    assert.ok(!out.includes("middle line 300"), "middle should be dropped")
  })

  test("the marker reports the exact number of dropped characters", () => {
    const text = longReport()
    const out = clipResult(text)
    const matched = out.match(DROP_MARKER)
    assert.ok(matched !== null, "missing drop marker")
    const kept = out.length - matched[0].length
    assert.equal(Number(matched[1]), text.length - kept)
    assert.equal(Number(matched[2]), MAX_RESULT_CHARS)
  })

  test("never splits a surrogate pair into a lone surrogate", () => {
    const text = "🙂".repeat(3_000)
    assert.ok(text.length > MAX_RESULT_CHARS)
    for (const limit of [80, 81, 100, 101, 121, 122, 200, 201, 303, 404, 999, 1_000, 1_001, 3_999, MAX_RESULT_CHARS]) {
      const out = clipResult(text, limit)
      assert.ok(out.length <= limit, `limit ${limit}: got ${out.length}`)
      assert.deepEqual(loneSurrogates(out), [], `limit ${limit}`)
      const matched = out.match(DROP_MARKER)
      if (matched !== null) {
        // Every char in the fixture is a two-unit pair, so a split would leave an odd kept count.
        assert.equal((out.length - matched[0].length) % 2, 0, `limit ${limit}: cut landed inside a pair`)
      }
    }
  })

  test("never splits a pair when the head budget collapses", () => {
    const text = "🙂".repeat(2_500)
    for (const limit of [0, 1, 2, 3, 5, 10, 40, 80]) {
      const out = clipResult(text, limit)
      assert.ok(out.length <= limit, `limit ${limit}: got ${out.length}`)
      assert.deepEqual(loneSurrogates(out), [], `limit ${limit}`)
    }
  })

  test("a limit too small for the marker still returns within the limit", () => {
    for (const limit of [0, 1, 2, 5, 10, 40, 70]) {
      const out = clipResult("x".repeat(5_000), limit)
      assert.ok(out.length <= limit, `limit ${limit}: got ${out.length}`)
      // At these limits the marker cannot fit, so only plain head characters survive.
      assert.equal(out, "x".repeat(out.length))
    }
  })

  test("a limit that fits only the marker still keeps head and tail inside the limit", () => {
    const out = clipResult("x".repeat(5_000), 80)
    assert.ok(out.length <= 80, `got ${out.length}`)
    assert.match(out, DROP_MARKER)
  })
})

describe("validateDiffInput", () => {
  test("defaults mode to working and context to 3", () => {
    assert.deepEqual(validateDiffInput({}), { mode: "working", base: undefined, context: 3, path: undefined })
    assert.deepEqual(validateDiffInput(undefined), { mode: "working", base: undefined, context: 3, path: undefined })
  })

  test("keeps valid modes and rejects unknown ones", () => {
    assert.equal(validateDiffInput({ mode: "branch" }).mode, "branch")
    assert.equal(validateDiffInput({ mode: "committed" }).mode, "committed")
    assert.equal(validateDiffInput({ mode: "staged" }).mode, "working")
    assert.equal(validateDiffInput({ mode: 7 }).mode, "working")
  })

  test("clamps context to 0..10 and floors fractions", () => {
    assert.equal(validateDiffInput({ context: 3.9 }).context, 3)
    assert.equal(validateDiffInput({ context: -5 }).context, 0)
    assert.equal(validateDiffInput({ context: 99 }).context, 10)
    assert.equal(validateDiffInput({ context: 0 }).context, 0)
    assert.equal(validateDiffInput({ context: 10 }).context, 10)
  })

  test("falls back to the default context for non-numbers", () => {
    assert.equal(validateDiffInput({ context: "4" }).context, 3)
    assert.equal(validateDiffInput({ context: Number.NaN }).context, 3)
    assert.equal(validateDiffInput({ context: Number.POSITIVE_INFINITY }).context, 3)
    assert.equal(validateDiffInput({ context: null }).context, 3)
  })

  test("accepts an explicit base and trims it", () => {
    assert.equal(validateDiffInput({ base: "  main  " }).base, "main")
  })

  test("rejects a base starting with -", () => {
    assert.throws(() => validateDiffInput({ base: "-x" }), TypeError)
    assert.throws(() => validateDiffInput({ base: "--output" }), TypeError)
  })

  test("rejects a base containing whitespace or control characters", () => {
    assert.throws(() => validateDiffInput({ base: "a b" }), TypeError)
    assert.throws(() => validateDiffInput({ base: "a\tb" }), TypeError)
    assert.throws(() => validateDiffInput({ base: "a\u0000b" }), TypeError)
    assert.throws(() => validateDiffInput({ base: "a\u001fb" }), TypeError)
  })

  test("treats an empty or whitespace-only base and path as undefined", () => {
    assert.equal(validateDiffInput({ base: "" }).base, undefined)
    assert.equal(validateDiffInput({ base: "   " }).base, undefined)
    assert.equal(validateDiffInput({ base: 42 }).base, undefined)
    assert.equal(validateDiffInput({ path: "" }).path, undefined)
    assert.equal(validateDiffInput({ path: "   " }).path, undefined)
  })

  test("returns a trimmed path", () => {
    assert.equal(validateDiffInput({ path: "  src/index.ts  " }).path, "src/index.ts")
  })
})

describe("normalizeOptions", () => {
  test("defaults to orchestrator / 4 / 2 / {}", () => {
    const expected = { agent: "orchestrator", maxParallel: 4, maxReviewers: 2, fallback: {} }
    assert.deepEqual(normalizeOptions(undefined), expected)
    assert.deepEqual(normalizeOptions({}), expected)
  })

  test("clamps maxParallel to 1..8 and floors fractions", () => {
    assert.equal(normalizeOptions({ maxParallel: 0 }).maxParallel, 1)
    assert.equal(normalizeOptions({ maxParallel: -3 }).maxParallel, 1)
    assert.equal(normalizeOptions({ maxParallel: 1 }).maxParallel, 1)
    assert.equal(normalizeOptions({ maxParallel: 3.7 }).maxParallel, 3)
    assert.equal(normalizeOptions({ maxParallel: 8 }).maxParallel, 8)
    assert.equal(normalizeOptions({ maxParallel: 9 }).maxParallel, 8)
  })

  test("clamps maxReviewers to 1..4 and floors fractions", () => {
    assert.equal(normalizeOptions({ maxReviewers: 0 }).maxReviewers, 1)
    assert.equal(normalizeOptions({ maxReviewers: -1 }).maxReviewers, 1)
    assert.equal(normalizeOptions({ maxReviewers: 2.9 }).maxReviewers, 2)
    assert.equal(normalizeOptions({ maxReviewers: 4 }).maxReviewers, 4)
    assert.equal(normalizeOptions({ maxReviewers: 5 }).maxReviewers, 4)
  })

  test("non-numeric values fall back to the defaults", () => {
    muted(() => {
      assert.equal(normalizeOptions({ maxParallel: "5" }).maxParallel, 4)
      assert.equal(normalizeOptions({ maxParallel: Number.NaN }).maxParallel, 4)
      assert.equal(normalizeOptions({ maxParallel: null }).maxParallel, 4)
      assert.equal(normalizeOptions({ maxReviewers: "3" }).maxReviewers, 2)
      assert.equal(normalizeOptions({ maxReviewers: Number.NEGATIVE_INFINITY }).maxReviewers, 2)
    })
  })

  test("falls back to the orchestrator agent for blank or non-string values", () => {
    assert.equal(normalizeOptions({ agent: "  worker  " }).agent, "worker")
    assert.equal(normalizeOptions({ agent: "" }).agent, "orchestrator")
    assert.equal(normalizeOptions({ agent: "   " }).agent, "orchestrator")
    muted(() => {
      assert.equal(normalizeOptions({ agent: 12 }).agent, "orchestrator")
    })
  })

  test("parses configured fallback models", () => {
    const normalized = muted(() => normalizeOptions({ fallback: { backend: "anthropic/claude-sonnet-4" } }))
    assert.deepEqual(normalized.fallback, {
      backend: [{ providerID: "anthropic", modelID: "claude-sonnet-4", key: "anthropic/claude-sonnet-4" }],
    })
  })
})

describe("buildReviewBrief", () => {
  test("with one reviewer it asks for the correctness lens only", () => {
    const brief = buildReviewBrief(options({ maxReviewers: 1 }))
    assert.match(
      brief,
      /Always run `reviewer` once with the `correctness` lens only\. No further lens calls are allowed\./,
    )
    assert.doesNotMatch(brief, /further lens calls from the table/)
    assert.doesNotMatch(brief, /at most \d+ further lens calls/)
  })

  test("with three reviewers it asks for at most two further lens calls", () => {
    const brief = buildReviewBrief(options({ maxReviewers: 3 }))
    assert.match(brief, /Then pick at most 2 further lens calls from the table below/)
    assert.doesNotMatch(brief, /No further lens calls are allowed/)
  })

  test("with four reviewers it asks for at most three further lens calls", () => {
    const brief = buildReviewBrief(options({ maxReviewers: 4 }))
    assert.match(brief, /Then pick at most 3 further lens calls from the table below/)
  })

  test("always routes reviewer-security on its triggers", () => {
    for (const maxReviewers of [1, 3]) {
      const brief = buildReviewBrief(options({ maxReviewers }))
      assert.match(
        brief,
        /Route `reviewer-security` as well when the change touches auth, input handling, secrets, deserialization, SSRF, paths, HTML output, or SQL\/shell construction\./,
        `maxReviewers ${maxReviewers}`,
      )
    }
  })

  test("lists every lens id and label", () => {
    for (const maxReviewers of [1, 3]) {
      const brief = buildReviewBrief(options({ maxReviewers }))
      for (const lens of LENSES) {
        assert.ok(brief.includes(lens.id), `maxReviewers ${maxReviewers}: missing lens id ${lens.id}`)
        assert.match(brief, new RegExp(`^${lens.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — ${lens.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ${lens.focus[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))
      }
    }
  })
})

describe("buildDelegationText", () => {
  test("states the configured maxParallel number", () => {
    assert.match(buildDelegationText(options({ maxParallel: 6 })), /keeping at most 6 background subagents at once/)
    assert.match(buildDelegationText(options({ maxParallel: 1 })), /keeping at most 1 background subagents at once/)
  })
})

describe("STEP_DEFAULTS", () => {
  test("covers every managed agent with an integer inside the settings range", () => {
    for (const id of AGENT_IDS) {
      const budget = STEP_DEFAULTS[id]
      assert.equal(typeof budget, "number", `missing default for ${id}`)
      assert.ok(Number.isInteger(budget), `non-integer default for ${id}`)
      assert.ok(budget >= STEPS_MIN && budget <= STEPS_MAX, `default for ${id} outside ${STEPS_MIN}..${STEPS_MAX}`)
    }
  })
})
