import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chooseModel, classifyFailure, createModelHealth, FALLBACK_WINDOW_MS, isChildFailure, isChildQuotaFailure, parseModel, planRetriedResult, planRetryDecision, resultText, type ParsedModel } from "../src/shared/fallback";

function model(id: string): ParsedModel {
  const parsed = parseModel(id);
  if (parsed === undefined) throw new Error(`fixture "${id}" must parse`);
  return parsed;
}

const OBSERVED_QUOTA = "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go";
const OBSERVED_FATAL = 'only "auto" is supported for "tool_choice". "none", "required", and named function choices are not currently supported';

describe("parseModel", () => {
  test("accepts provider/model", () => {
    assert.deepEqual(parseModel("anthropic/claude-sonnet-4"), {
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      key: "anthropic/claude-sonnet-4",
    });
  });

  test("splits provider/model#variant and keeps the variant out of key", () => {
    const parsed = parseModel("openai/gpt-5#high");
    assert.deepEqual(parsed, { providerID: "openai", modelID: "gpt-5", variant: "high", key: "openai/gpt-5" });
    assert.equal(parsed?.key, "openai/gpt-5");
    assert.ok(!parsed?.key.includes("#"));
  });

  test("rejects an empty string", () => {
    assert.equal(parseModel(""), undefined);
  });

  test("rejects any whitespace anywhere in the value", () => {
    assert.equal(parseModel(" anthropic/claude"), undefined);
    assert.equal(parseModel("anthropic/claude "), undefined);
    assert.equal(parseModel("anthropic/claude sonnet"), undefined);
    assert.equal(parseModel("anthropic/claude\n"), undefined);
    assert.equal(parseModel("anthropic/claude\t#high"), undefined);
  });

  test("rejects more than one #", () => {
    assert.equal(parseModel("openai/gpt-5#high#low"), undefined);
  });

  test("rejects an empty variant", () => {
    assert.equal(parseModel("openai/gpt-5#"), undefined);
  });

  test("rejects a leading or trailing slash", () => {
    assert.equal(parseModel("/claude"), undefined);
    assert.equal(parseModel("anthropic/"), undefined);
    assert.equal(parseModel("/"), undefined);
  });

  test("rejects a value with no slash", () => {
    assert.equal(parseModel("claude-sonnet-4"), undefined);
  });

  test("rejects non-string input", () => {
    assert.equal(parseModel(undefined), undefined);
    assert.equal(parseModel(null), undefined);
    assert.equal(parseModel(42), undefined);
    assert.equal(parseModel({ providerID: "a", modelID: "b" }), undefined);
  });
});

describe("classifyFailure", () => {
  test("the observed free-usage message is quota", () => {
    assert.equal(classifyFailure({ message: OBSERVED_QUOTA }), "quota");
  });

  test("the observed tool_choice message is fatal", () => {
    assert.equal(classifyFailure({ message: OBSERVED_FATAL }), "fatal");
  });

  test("matches every quota phrase", () => {
    const phrases = [
      "free usage limit reached",
      "free usage exceeded for today",
      "usage limit exceeded",
      "usage exceeded for the key",
      "subscribe to OpenCode Go to continue",
      "quota exceeded",
      "insufficient quota for this request",
      "insufficient_quota",
      "insufficient credit balance",
      "insufficient balance remaining",
      "payment required to continue",
      "billing issue on the account",
      "out of credits",
      "monthly limit reached",
      "free tier limit reached",
      "free plan limit reached",
    ];
    for (const message of phrases) {
      assert.equal(classifyFailure({ message }), "quota", message);
    }
  });

  test("status 402 is quota even with an unrelated message", () => {
    assert.equal(classifyFailure({ status: 402 }), "quota");
    assert.equal(classifyFailure({ status: 402, message: "boom" }), "quota");
  });

  test("a quota message wins over a non-quota status", () => {
    assert.equal(classifyFailure({ status: 429, message: "Free usage limit reached" }), "quota");
    assert.equal(classifyFailure({ status: 400, message: "monthly limit reached" }), "quota");
    assert.equal(classifyFailure({ status: 500, message: "insufficient_quota" }), "quota");
  });

  test("a quota status wins over a fatal message", () => {
    assert.equal(classifyFailure({ status: 402, message: "invalid request" }), "quota");
  });

  test("a fatal type wins without any status", () => {
    assert.equal(classifyFailure({ type: "InvalidRequest", message: "boom" }), "fatal");
    assert.equal(classifyFailure({ type: "BadRequest" }), "fatal");
    assert.equal(classifyFailure({ type: "bad_request" }), "fatal");
    assert.equal(classifyFailure({ type: "unsupported" }), "fatal");
  });

  test("the 400 InvalidRequest case is fatal", () => {
    assert.equal(classifyFailure({ type: "InvalidRequest", status: 400, message: "bad input" }), "fatal");
    assert.equal(classifyFailure({ status: 400, message: "invalid request body" }), "fatal");
  });

  test("a fatal message wins without any status", () => {
    assert.equal(classifyFailure({ message: "this model is not supported" }), "fatal");
    assert.equal(classifyFailure({ message: "unsupported parameter" }), "fatal");
  });

  test("client statuses other than 408 and 429 are fatal", () => {
    for (const status of [400, 401, 403, 404, 418, 499]) {
      assert.equal(classifyFailure({ status, message: "boom" }), "fatal", `status ${status}`);
    }
  });

  test("408, 429, and 5xx are retryable", () => {
    for (const status of [408, 429, 500, 502, 503]) {
      assert.equal(classifyFailure({ status, message: "boom" }), "retryable", `status ${status}`);
    }
  });

  test("a 429 rate-limit message is retryable, not quota", () => {
    assert.equal(classifyFailure({ status: 429, message: "You have hit the rate limit for this model" }), "retryable");
  });

  test("matches every retryable phrase", () => {
    const phrases = [
      "rate limit exceeded",
      "too many requests",
      "request timed out",
      "connection timeout",
      "econnreset by peer",
      "econnrefused",
      "socket hang up",
      "fetch failed",
      "network error",
      "server overloaded, try again",
      "temporarily unavailable",
    ];
    for (const message of phrases) {
      assert.equal(classifyFailure({ message }), "retryable", message);
    }
  });

  test("missing or unknown input is retryable", () => {
    assert.equal(classifyFailure(undefined), "retryable");
    assert.equal(classifyFailure(null as unknown as undefined), "retryable");
    assert.equal(classifyFailure({}), "retryable");
    assert.equal(classifyFailure({ message: "" }), "retryable");
    assert.equal(classifyFailure({ message: "model not found" }), "retryable");
  });

  test("an unknown message with a fatal status is still fatal", () => {
    assert.equal(classifyFailure({ status: 418, message: "model not found" }), "fatal");
  });
});

describe("planRetryDecision", () => {
  test("no fallback means surface for every class", () => {
    assert.deepEqual(planRetryDecision({ error: { message: "usage limit" }, attempt: 1, degraded: false, hasFallback: false }), { kind: "surface" });
    assert.deepEqual(planRetryDecision({ error: { status: 500 }, attempt: 3, degraded: true, hasFallback: false }), { kind: "surface" });
    assert.deepEqual(planRetryDecision({ error: { status: 400 }, attempt: 1, degraded: false, hasFallback: false }), { kind: "surface" });
  });

  test("quota falls back with the quota mark", () => {
    assert.deepEqual(planRetryDecision({ error: { message: OBSERVED_QUOTA }, attempt: 1, degraded: false, hasFallback: true }), { kind: "fallback", mark: "quota" });
    assert.deepEqual(planRetryDecision({ error: { status: 402 }, attempt: 1, degraded: false, hasFallback: true }), { kind: "fallback", mark: "quota" });
  });

  test("a quota error falls back even when degraded and late", () => {
    assert.deepEqual(planRetryDecision({ error: { message: "usage limit" }, attempt: 5, degraded: true, hasFallback: true }), { kind: "fallback", mark: "quota" });
  });

  test("fatal surfaces", () => {
    assert.deepEqual(planRetryDecision({ error: { message: OBSERVED_FATAL }, attempt: 1, degraded: false, hasFallback: true }), { kind: "surface" });
    assert.deepEqual(planRetryDecision({ error: { status: 400 }, attempt: 2, degraded: true, hasFallback: true }), { kind: "surface" });
  });

  test("a degraded retryable error falls back with the retries mark", () => {
    assert.deepEqual(planRetryDecision({ error: { status: 500 }, attempt: 1, degraded: true, hasFallback: true }), { kind: "fallback", mark: "retries" });
    assert.deepEqual(planRetryDecision({ error: { message: "rate limit" }, attempt: 2, degraded: true, hasFallback: true }), { kind: "fallback", mark: "retries" });
  });

  test("the third attempt falls back with the retries mark", () => {
    assert.deepEqual(planRetryDecision({ error: { status: 500 }, attempt: 3, degraded: false, hasFallback: true }), { kind: "fallback", mark: "retries" });
    assert.deepEqual(planRetryDecision({ error: { status: 500 }, attempt: 4, degraded: false, hasFallback: true }), { kind: "fallback", mark: "retries" });
  });

  test("early retryable attempts retry with a growing delay and degrade", () => {
    assert.deepEqual(planRetryDecision({ error: { status: 500 }, attempt: 1, degraded: false, hasFallback: true }), { kind: "retry", delayMs: 1000, degrade: true });
    assert.deepEqual(planRetryDecision({ error: { status: 500 }, attempt: 2, degraded: false, hasFallback: true }), { kind: "retry", delayMs: 2000, degrade: true });
  });

  test("a retryAfterMs hint wins and is clamped to 0..15000", () => {
    assert.deepEqual(planRetryDecision({ error: { status: 503, retryAfterMs: 500 }, attempt: 1, degraded: false, hasFallback: true }), { kind: "retry", delayMs: 500, degrade: true });
    assert.deepEqual(planRetryDecision({ error: { status: 503, retryAfterMs: 99999 }, attempt: 1, degraded: false, hasFallback: true }), { kind: "retry", delayMs: 15000, degrade: true });
    assert.deepEqual(planRetryDecision({ error: { status: 503, retryAfterMs: -5 }, attempt: 1, degraded: false, hasFallback: true }), { kind: "retry", delayMs: 0, degrade: true });
  });
});

describe("createModelHealth", () => {
  const WINDOW = 300_000;

  function harness() {
    let clock = 0;
    const health = createModelHealth({ windowMs: WINDOW, now: () => clock });
    return {
      health,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test("exposes the fixed fallback window", () => {
    assert.equal(FALLBACK_WINDOW_MS, 300_000);
  });

  test("an unknown model is up with no reason and no wait", () => {
    const { health } = harness();
    const target = model("p/a");
    assert.equal(health.down(target), false);
    assert.equal(health.waitMs(target), 0);
    assert.equal(health.reason(target), undefined);
    assert.equal(health.degraded(target), false);
    assert.deepEqual(health.snapshot(), []);
  });

  test("a failure downs the model for exactly the window", () => {
    const { health, advance } = harness();
    const target = model("p/a");
    health.fail(target, "quota");
    assert.equal(health.down(target), true);
    assert.equal(health.waitMs(target), WINDOW);
    assert.equal(health.reason(target), "quota");
    assert.deepEqual(health.snapshot(), [{ model: "p/a", reason: "quota", waitMs: WINDOW, degraded: false }]);
    advance(WINDOW - 1);
    assert.equal(health.down(target), true);
    advance(1);
    assert.equal(health.down(target), false);
    assert.equal(health.waitMs(target), 0);
    assert.equal(health.reason(target), undefined);
    assert.deepEqual(health.snapshot(), []);
  });

  test("a failure inside the open window re-arms from the new failure time", () => {
    const { health, advance } = harness();
    const target = model("p/a");
    health.fail(target, "quota");
    advance(1_000);
    health.fail(target, "retries");
    assert.equal(health.waitMs(target), WINDOW);
    assert.equal(health.reason(target), "retries");
    assert.deepEqual(health.snapshot(), [{ model: "p/a", reason: "retries", waitMs: WINDOW, degraded: false }]);
  });

  test("a failure clears the degraded flag and records the new reason", () => {
    const { health } = harness();
    const target = model("p/a");
    health.degrade(target);
    assert.equal(health.degraded(target), true);
    health.fail(target, "retries");
    assert.equal(health.degraded(target), false);
    assert.equal(health.reason(target), "retries");
  });

  test("degrade marks the model without taking it down", () => {
    const { health } = harness();
    const target = model("p/a");
    health.degrade(target);
    assert.equal(health.degraded(target), true);
    assert.equal(health.down(target), false);
    assert.equal(health.waitMs(target), 0);
    assert.deepEqual(health.snapshot(), []);
  });

  test("succeed with a since older than the degraded mark keeps it", () => {
    const { health, advance } = harness();
    const target = model("p/a");
    advance(1_000);
    health.degrade(target);
    health.succeed(target, 500);
    assert.equal(health.degraded(target), true);
  });

  test("succeed with a newer since clears the degraded mark", () => {
    const { health, advance } = harness();
    const target = model("p/a");
    advance(1_000);
    health.degrade(target);
    health.succeed(target, 1_500);
    assert.equal(health.degraded(target), false);
  });

  test("succeed without a since clears the degraded mark", () => {
    const { health } = harness();
    const target = model("p/a");
    health.degrade(target);
    health.succeed(target);
    assert.equal(health.degraded(target), false);
  });

  test("succeed never lifts a down entry", () => {
    const { health } = harness();
    const target = model("p/a");
    health.fail(target, "quota");
    health.succeed(target);
    assert.equal(health.down(target), true);
  });

  test("reset lifts only the given models", () => {
    const { health } = harness();
    const first = model("p/a");
    const second = model("p/b");
    health.fail(first, "quota");
    health.fail(second, "retries");
    health.reset([first]);
    assert.equal(health.down(first), false);
    assert.equal(health.down(second), true);
    assert.deepEqual(health.snapshot(), [{ model: "p/b", reason: "retries", waitMs: WINDOW, degraded: false }]);
  });

  test("tracks models by key, so variants share one entry", () => {
    const { health } = harness();
    health.fail(model("p/a#high"), "quota");
    assert.equal(health.down(model("p/a#low")), true);
    assert.equal(health.reason(model("p/a")), "quota");
    assert.deepEqual(health.snapshot(), [{ model: "p/a", reason: "quota", waitMs: WINDOW, degraded: false }]);
  });

  test("waitMs never goes negative", () => {
    const { health, advance } = harness();
    const target = model("p/a");
    health.fail(target, "quota");
    advance(WINDOW * 5);
    assert.equal(health.waitMs(target), 0);
  });
});

describe("chooseModel", () => {
  const primary = model("p/primary");
  const first = model("p/first");
  const second = model("p/second");

  test("an available primary wins", () => {
    assert.deepEqual(
      chooseModel({ primary, alternates: [first], available: () => true }),
      { model: primary, primary, fellBack: false },
    );
  });

  test("an unavailable primary picks the first available alternate and reports the fallback", () => {
    const selection = chooseModel({
      primary,
      alternates: [first, second],
      available: (candidate) => candidate.key !== "p/primary",
    });
    assert.deepEqual(selection, { model: first, primary, fellBack: true });
  });

  test("skips unavailable alternates in order", () => {
    const selection = chooseModel({
      primary,
      alternates: [first, second],
      available: (candidate) => candidate.key === "p/second",
    });
    assert.deepEqual(selection, { model: second, primary, fellBack: true });
  });

  test("returns the last alternate when every model is exhausted", () => {
    const selection = chooseModel({ primary, alternates: [first, second], available: () => false });
    assert.deepEqual(selection, { model: second, primary, fellBack: true });
  });

  test("returns the unavailable primary unchanged when there are no alternates", () => {
    assert.deepEqual(
      chooseModel({ primary, alternates: [], available: () => false }),
      { model: primary, primary, fellBack: false },
    );
  });

  test("returns nothing when there is no primary", () => {
    assert.deepEqual(
      chooseModel({ primary: undefined, alternates: [first], available: () => true }),
      { model: undefined, primary: undefined, fellBack: false },
    );
  });
});

describe("resultText", () => {
  test("returns a string content itself", () => {
    assert.equal(resultText({ content: "hello" }), "hello");
  });

  test("concatenates text-part array entries", () => {
    assert.equal(
      resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
      "ab",
    );
  });

  test("skips mixed parts without text", () => {
    assert.equal(
      resultText({ content: [{ type: "text", text: "a" }, { type: "image", text: "b" }, { type: "text", text: 42 }] }),
      "a",
    );
  });

  test("returns empty for invalid shapes", () => {
    assert.equal(resultText(undefined), "");
    assert.equal(resultText(null), "");
    assert.equal(resultText({}), "");
    assert.equal(resultText({ content: 42 }), "");
    assert.equal(resultText({ content: [{ type: "text" }] }), "");
  });
});

describe("isChildFailure", () => {
  test("error state is true", () => {
    assert.equal(isChildFailure({ content: "done", metadata: { state: "error" } }), true);
  });

  test("failed state is true", () => {
    assert.equal(isChildFailure({ content: "done", metadata: { state: "failed" } }), true);
  });

  test("absent state with the subagent error tag is true", () => {
    assert.equal(isChildFailure({ content: '<subagent agent="explore" state="error">boom</subagent>' }), true);
  });

  test("absent state with the subagent failed tag is true", () => {
    assert.equal(isChildFailure({ content: '<subagent agent="explore" state="failed">boom</subagent>' }), true);
  });

  test("absent state without a tag is false", () => {
    assert.equal(isChildFailure({ content: "done" }), false);
  });

  test("completed state is false", () => {
    assert.equal(isChildFailure({ content: "done", metadata: { state: "completed" } }), false);
  });

  test("non-object input is false", () => {
    assert.equal(isChildFailure(undefined), false);
    assert.equal(isChildFailure(null), false);
  });
});

describe("isChildQuotaFailure", () => {
  test("quota text with error state is true", () => {
    assert.equal(isChildQuotaFailure({ content: "usage limit exceeded", metadata: { state: "error" } }), true);
  });

  test("the same text without metadata is false", () => {
    assert.equal(isChildQuotaFailure({ content: "usage limit exceeded" }), false);
  });

  test("quota text with completed state is false", () => {
    assert.equal(isChildQuotaFailure({ content: "usage limit exceeded", metadata: { state: "completed" } }), false);
  });

  test("a non-quota error state is false", () => {
    assert.equal(isChildQuotaFailure({ content: "model not found", metadata: { state: "error" } }), false);
  });

  test("a retryable rate-limit error state is false", () => {
    assert.equal(isChildQuotaFailure({ content: "rate limit exceeded", metadata: { state: "error" } }), false);
  });

  test("the exact observed quota message is true", () => {
    assert.equal(isChildQuotaFailure({ content: OBSERVED_QUOTA, metadata: { state: "error" } }), true);
  });

  test("the exact observed fatal message is false", () => {
    assert.equal(isChildQuotaFailure({ content: OBSERVED_FATAL, metadata: { state: "error" } }), false);
  });

  test("quota text with failed state is true", () => {
    assert.equal(isChildQuotaFailure({ content: "usage limit exceeded", metadata: { state: "failed" } }), true);
  });

  test("absent state with the subagent error tag is true", () => {
    assert.equal(
      isChildQuotaFailure({ content: '<subagent agent="explore" state="error">usage limit exceeded</subagent>' }),
      true,
    );
  });

  test("absent state without the tag is false", () => {
    assert.equal(isChildQuotaFailure({ content: "usage limit exceeded" }), false);
  });

  test("a quota phrase with succeeded state is false", () => {
    assert.equal(isChildQuotaFailure({ content: "usage limit exceeded", metadata: { state: "succeeded" } }), false);
  });
});

describe("planRetriedResult", () => {
  test("alternate also returns quota yields fail and no credit", () => {
    const alternate = model("p/alt");
    const settled = planRetriedResult({
      result: { content: "usage limit exceeded", metadata: { state: "error" } },
      alternate,
    });
    assert.deepEqual(settled, { fail: alternate });
  });

  test("alternate succeeds yields credit", () => {
    const alternate = model("p/alt");
    const settled = planRetriedResult({
      result: { content: "done", metadata: { state: "completed" } },
      alternate,
    });
    assert.deepEqual(settled, { credit: alternate });
  });
});
