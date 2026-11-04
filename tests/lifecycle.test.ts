import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRegistrationScope, type Registration } from "../src/server/lifecycle";

function fake(id: string, calls: string[]): Registration {
  return { dispose: async () => { calls.push(id); } };
}

describe("lifecycle", () => {
  test("setup for location B does not dispose location A's registrations", async () => {
    const scope = createRegistrationScope();
    const calls: string[] = [];
    const handleA = await scope.take({ directory: "/a" });
    const a1 = fake("a1", calls);
    assert.equal(scope.install(handleA, [a1]), true);
    const handleB = await scope.take({ directory: "/b" });
    assert.equal(scope.install(handleB, [fake("b1", calls)]), true);
    assert.deepStrictEqual(calls, []);
  });

  test("reload of the same location disposes the previous registrations exactly once", async () => {
    const scope = createRegistrationScope();
    const calls: string[] = [];
    const first = await scope.take({ directory: "/a" });
    assert.equal(scope.install(first, [fake("a1", calls), fake("a2", calls)]), true);
    await scope.take({ directory: "/a" });
    assert.deepStrictEqual(calls, ["a1", "a2"]);
  });

  test("a superseded handle cannot install", async () => {
    const scope = createRegistrationScope();
    const h1 = await scope.take({ directory: "/a" });
    const h2 = await scope.take({ directory: "/a" });
    assert.equal(scope.install(h1, [fake("stale", [])]), false);
    assert.equal(scope.install(h2, [fake("live", [])]), true);
  });

  test("forget clears only the matching array", async () => {
    const scope = createRegistrationScope();
    const calls: string[] = [];
    const handle = await scope.take({ directory: "/a" });
    const live = [fake("a1", calls)];
    assert.equal(scope.install(handle, live), true);
    scope.forget(handle, live);
    await scope.take({ directory: "/a" });
    assert.deepStrictEqual(calls, []);
  });

  test("forget with a different array reference leaves the entry intact", async () => {
    const scope = createRegistrationScope();
    const calls: string[] = [];
    const handle = await scope.take({ directory: "/a" });
    const live = [fake("a1", calls)];
    assert.equal(scope.install(handle, live), true);
    scope.forget(handle, [fake("other", calls)]);
    await scope.take({ directory: "/a" });
    assert.deepStrictEqual(calls, ["a1"]);
  });

  test("trailing slash resolves to the same key on win32", async (t) => {
    if (process.platform !== "win32") t.skip("win32-only normalization");
    const scope = createRegistrationScope();
    const calls: string[] = [];
    const first = await scope.take({ directory: "C:\\Users\\Alex" });
    assert.equal(scope.install(first, [fake("a1", calls)]), true);
    await scope.take({ directory: "C:\\Users\\Alex\\" });
    assert.deepStrictEqual(calls, ["a1"]);
  });
});
