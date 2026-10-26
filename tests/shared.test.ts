import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { AGENT_IDS, REVIEWER_IDS } from "../src/shared/agents"
import { LENSES, buildDelegationText, buildReviewBrief } from "../src/shared/review"
import { MAX_RESULT_CHARS, clipResultStats } from "../src/shared/results"
import { displayWidth } from "../src/shared/text"
import { isSidebarStatusEvent, shouldRefreshSidebar } from "../src/shared/events"
import { normalizeOptions, type Options } from "../src/shared/options"
import { validateDiffInput } from "../src/shared/diff"

function options(overrides: Partial<Options> = {}): Options {
  return { agent: "orchestrator", maxReviewers: 2, ...overrides }
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

describe("clipResultStats", () => {
  test("returns text at or under the limit unchanged", () => {
    assert.equal(clipResultStats("hello").text, "hello")
    const exact = "a".repeat(MAX_RESULT_CHARS)
    assert.equal(clipResultStats(exact).text, exact)
    assert.equal(clipResultStats("🙂🙂").text, "🙂🙂")
  })

  test("clips one character over the limit and never exceeds the limit", () => {
    const text = "a".repeat(MAX_RESULT_CHARS + 1)
    const out = clipResultStats(text).text
    assert.ok(out.length <= MAX_RESULT_CHARS, `got ${out.length}`)
    assert.notEqual(out, text)
    assert.match(out, DROP_MARKER)
  })

  test("honours a custom limit", () => {
    const out = clipResultStats("b".repeat(5_000), 500).text
    assert.ok(out.length <= 500, `got ${out.length}`)
  })

  test("keeps the first line at the head and the last line at the tail", () => {
    const text = longReport()
    assert.ok(text.length > MAX_RESULT_CHARS, `fixture is only ${text.length} chars`)
    const out = clipResultStats(text).text
    assert.ok(out.length <= MAX_RESULT_CHARS)
    assert.ok(out.startsWith("TASK: keep the head\n"), "head lost the TASK line")
    assert.ok(out.endsWith("\nRISK: keep the tail"), "tail lost the RISK line")
    assert.ok(!out.includes("middle line 300"), "middle should be dropped")
  })

  test("the marker reports the exact number of dropped characters", () => {
    const text = longReport()
    const out = clipResultStats(text).text
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
      const out = clipResultStats(text, limit).text
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
      const out = clipResultStats(text, limit).text
      assert.ok(out.length <= limit, `limit ${limit}: got ${out.length}`)
      assert.deepEqual(loneSurrogates(out), [], `limit ${limit}`)
    }
  })

  test("a limit too small for the marker still returns within the limit", () => {
    for (const limit of [0, 1, 2, 5, 10, 40, 70]) {
      const out = clipResultStats("x".repeat(5_000), limit).text
      assert.ok(out.length <= limit, `limit ${limit}: got ${out.length}`)
      // At these limits the marker cannot fit, so only plain head characters survive.
      assert.equal(out, "x".repeat(out.length))
    }
  })

  test("a limit that fits only the marker still keeps head and tail inside the limit", () => {
    const out = clipResultStats("x".repeat(5_000), 80).text
    assert.ok(out.length <= 80, `got ${out.length}`)
    assert.match(out, DROP_MARKER)
  })
})

describe("validateDiffInput", () => {
  test("defaults mode to working and context to 3", () => {
    assert.deepEqual(validateDiffInput({}), { mode: "working", base: undefined, context: 3, path: undefined, stat: false })
    assert.deepEqual(validateDiffInput(undefined), { mode: "working", base: undefined, context: 3, path: undefined, stat: false })
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
  test("defaults to orchestrator / 2", () => {
    const expected = { agent: "orchestrator", maxReviewers: 2 }
    assert.deepEqual(normalizeOptions(undefined), expected)
    assert.deepEqual(normalizeOptions({}), expected)
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

  test("ignores a maxParallel plugin option", () => {
    assert.equal("maxParallel" in normalizeOptions({ maxParallel: 6 }), false)
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
    assert.doesNotMatch(brief, /at most \d+ further lens calls?/)
  })

  test("with two reviewers it says one further lens call, not calls", () => {
    const brief = buildReviewBrief(options({ maxReviewers: 2 }))
    assert.match(brief, /Then pick at most 1 further lens call from the table below/)
    assert.doesNotMatch(brief, /1 further lens calls/)
  })

  test("with three reviewers it caps the second lens at two and requires a domain match", () => {
    const brief = buildReviewBrief(options({ maxReviewers: 3 }))
    assert.match(brief, /Then pick at most 2 further lens calls from the table below/)
    assert.match(brief, /only when the diff directly touches that lens's domain/)
    assert.match(brief, /If none match, stop after correctness: the cap is a ceiling, not a target\./)
    assert.doesNotMatch(brief, /No further lens calls are allowed/)
  })

  test("with four reviewers it asks for at most three further lens calls", () => {
    const brief = buildReviewBrief(options({ maxReviewers: 4 }))
    assert.match(brief, /Then pick at most 3 further lens calls from the table below/)
  })

  test("adds a reflect step that never counts toward the lens cap and skips a clean verdict", () => {
    for (const maxReviewers of [1, 3]) {
      const brief = buildReviewBrief(options({ maxReviewers }))
      assert.match(brief, /run one `reviewer` call with the task prefixed `reflect` and `lens: correctness`/, `maxReviewers ${maxReviewers}`)
      assert.match(brief, /drops findings the diff disproves/, `maxReviewers ${maxReviewers}`)
      assert.match(brief, /moves findings the diff cannot decide to `Unverified:`/, `maxReviewers ${maxReviewers}`)
      assert.match(brief, /adds none/, `maxReviewers ${maxReviewers}`)
      assert.match(brief, /does not count toward the lens cap/, `maxReviewers ${maxReviewers}`)
      assert.match(brief, /Skip it when the verdict is clean\./, `maxReviewers ${maxReviewers}`)
    }
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

  test("a disabled reviewer returns the unavailable message", () => {
    const brief = buildReviewBrief(options(), ["reviewer"])
    assert.equal(brief, `The review panel is unavailable because the "reviewer" subagent is disabled in /choreographer. Enable it to run /review-panel.`)
  })

  test("a disabled reviewer-security omits its routing sentence", () => {
    const brief = buildReviewBrief(options(), ["reviewer-security"])
    assert.doesNotMatch(brief, /Route `reviewer-security` as well/)
    assert.match(brief, /Run a strict review panel on the current changes\./)
  })

  test("with no disabled subagents the current text is kept", () => {
    const brief = buildReviewBrief(options())
    assert.equal(brief, buildReviewBrief(options(), ["backend"]))
    assert.match(brief, /1\. Inspect/)
    assert.match(brief, /2\. Always run/)
    assert.match(brief, /3\. Route/)
    assert.match(brief, /4\. Route `reviewer-security`/)
    assert.match(brief, /5\. Launch/)
    assert.match(brief, /6\. When a reviewer returns findings/)
    assert.match(brief, /7\. If a reviewer/)
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
    assert.match(buildDelegationText(options(), [], 6), /keeping at most 6 background subagents at once/)
    assert.match(buildDelegationText(options(), [], 1), /keeping at most 1 background subagents at once/)
  })

  test("with a disabled list the line appears with the ids", () => {
    const text = buildDelegationText(options(), ["backend", "frontend"])
    assert.match(text, /Disabled subagents \(do not delegate; ignore their instructions\): backend, frontend\./)
  })

  test("with an empty list the disabled line is absent", () => {
    assert.doesNotMatch(buildDelegationText(options()), /Disabled subagents/)
  })
})

describe("shouldRefreshSidebar", () => {
  test("ignores streaming delta and progress events", () => {
    for (const type of [
      "session.text.delta",
      "session.reasoning.delta",
      "session.tool.input.delta",
      "session.tool.progress",
      "session.step.streamed",
      "session.compaction.delta",
      "session.usage.updated",
    ]) {
      assert.equal(shouldRefreshSidebar(type), false, type)
    }
  })

  test("refreshes on structural events", () => {
    for (const type of ["session.created", "session.metadata.updated", "agent.updated", "model.updated"]) {
      assert.equal(shouldRefreshSidebar(type), true, type)
    }
  })

  test("status events bump the view without fetching", () => {
    for (const type of ["session.status", "session.idle", "session.execution.started", "session.execution.succeeded"]) {
      assert.equal(shouldRefreshSidebar(type), false, type)
    }
  })

  test("an unknown type is false", () => {
    assert.equal(shouldRefreshSidebar("session.synthetic"), false)
    assert.equal(shouldRefreshSidebar("bogus.event"), false)
  })
})

describe("isSidebarStatusEvent", () => {
  test("excludes streaming deltas", () => {
    assert.equal(isSidebarStatusEvent("session.compaction.delta"), false)
    assert.equal(isSidebarStatusEvent("session.text.delta"), false)
  })

  test("includes explicit status events", () => {
    assert.equal(isSidebarStatusEvent("session.compaction.started"), true)
    assert.equal(isSidebarStatusEvent("session.execution.succeeded"), true)
    assert.equal(isSidebarStatusEvent("session.status"), true)
  })

  test("an unknown type is false", () => {
    assert.equal(isSidebarStatusEvent("session.synthetic"), false)
    assert.equal(isSidebarStatusEvent("bogus.event"), false)
  })
})

describe("specialist agent ids", () => {
  test("AGENT_IDS contains designer and writer", () => {
    assert.ok(AGENT_IDS.includes("designer"), "missing designer in AGENT_IDS")
    assert.ok(AGENT_IDS.includes("writer"), "missing writer in AGENT_IDS")
  })

  test("designer and writer are not reviewers", () => {
    assert.ok(!REVIEWER_IDS.includes("designer"), "designer must not be in REVIEWER_IDS")
    assert.ok(!REVIEWER_IDS.includes("writer"), "writer must not be in REVIEWER_IDS")
  })
})

describe("displayWidth", () => {
  test("ascii equals length", () => {
    assert.equal(displayWidth("hello"), 5)
    assert.equal(displayWidth(""), 0)
  })

  test("cjk counts two per character", () => {
    assert.equal(displayWidth("日本語"), 6)
  })

  test("mixed ascii and cjk adds up", () => {
    assert.equal(displayWidth("漢a"), 3)
    assert.equal(displayWidth("a漢b"), 4)
  })

  test("emoji counts two", () => {
    assert.equal(displayWidth("🙂"), 2)
  })

  test("combining mark does not add a cell", () => {
    assert.equal(displayWidth("é"), 1)
  })

  test("a string mixing ascii and cjk adds up", () => {
    assert.equal(displayWidth("hi日本"), 6)
  })
})
