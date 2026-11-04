import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import { contextHook } from "../src/server/context";
import { ORCHESTRATOR_ID } from "../src/shared/agents";
import type { Options } from "../src/shared/options";

const options: Options = { agent: ORCHESTRATOR_ID, maxReviewers: 1 };

function makeEvent(agent: string): any {
  return {
    agent,
    system: [],
    tools: { todowrite: {}, todoread: {}, edit: {}, write: {}, patch: {}, shell: {}, subagent: {}, question: {}, diff: {} },
    messages: [],
  };
}

function captureHook(todosEnabled: () => boolean): (event: any) => void {
  let captured: ((event: any) => void) | undefined;
  const ctx = {
    session: {
      hook: (_name: string, callback: (event: any) => void) => {
        captured = callback;
        return { dispose: async () => {} };
      },
    },
  };
  contextHook(ctx as unknown as Plugin.Context, options, () => 4, todosEnabled);
  assert.ok(captured, "hook callback was captured");
  return captured!;
}

function hasDiscipline(event: any): boolean {
  return event.system.some((entry: any) => typeof entry.text === "string" && entry.text.includes("TODO discipline"));
}

describe("context todos gate", () => {
  test("todos enabled, orchestrator keeps todo tools and discipline text", () => {
    const invoke = captureHook(() => true);
    const event = makeEvent(ORCHESTRATOR_ID);
    invoke(event);
    assert.ok("todowrite" in event.tools, "todowrite still present");
    assert.ok("todoread" in event.tools, "todoread still present");
    assert.ok(hasDiscipline(event), "TODO discipline text was pushed");
  });

  test("todos disabled, orchestrator loses todo tools and discipline text", () => {
    const invoke = captureHook(() => false);
    const event = makeEvent(ORCHESTRATOR_ID);
    invoke(event);
    assert.ok(!("todowrite" in event.tools), "todowrite removed");
    assert.ok(!("todoread" in event.tools), "todoread removed");
    assert.ok(!hasDiscipline(event), "no TODO discipline text");
    assert.ok(!("edit" in event.tools), "edit still removed");
    assert.ok(!("write" in event.tools), "write still removed");
    assert.ok(!("patch" in event.tools), "patch still removed");
    assert.ok(!("shell" in event.tools), "shell still removed");
  });

  test("todos disabled, worker loses todo tools", () => {
    const invoke = captureHook(() => false);
    const event = makeEvent("backend");
    invoke(event);
    assert.ok(!("todowrite" in event.tools), "todowrite removed for worker");
    assert.ok(!("todoread" in event.tools), "todoread removed for worker");
  });

  test("getter is read per call, toggle takes effect without reload", () => {
    let enabled = false;
    const invoke = captureHook(() => enabled);
    const first = makeEvent(ORCHESTRATOR_ID);
    invoke(first);
    assert.ok(!("todowrite" in first.tools), "todowrite removed while disabled");
    assert.ok(!hasDiscipline(first), "no discipline while disabled");
    enabled = true;
    const second = makeEvent(ORCHESTRATOR_ID);
    invoke(second);
    assert.ok("todowrite" in second.tools, "todowrite back after toggle");
    assert.ok("todoread" in second.tools, "todoread back after toggle");
    assert.ok(hasDiscipline(second), "discipline pushed after toggle");
  });
});
