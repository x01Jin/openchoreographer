import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_IDS, EXPLORE_ID, MODEL_GROUPS, ORCHESTRATOR_ID, REVIEWER_IDS, SPECIALIST_IDS, SUBAGENT_IDS, WORKER_IDS } from "../src/shared/agents";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");

function readAgent(name: string): { lines: string[]; content: string } {
  const content = fs.readFileSync(path.join(AGENTS_DIR, name), "utf8");
  return { lines: content.split(/\r?\n/), content };
}

function parseFrontmatter(lines: string[]): { data: Record<string, string>; closing: number } {
  assert.equal(lines[0], "---", "line 1 is the opening fence");
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  assert.ok(closing > 0, "frontmatter has a closing fence");
  const data: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (match) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, closing };
}

describe("agents", () => {
  test("all eleven agent files meet the specialist contract", () => {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
    assert.equal(files.length, 11, `expected 11 agent files, found ${files.length}`);
    assert.ok(files.includes("designer.md"), "designer.md exists");
    assert.ok(files.includes("writer.md"), "writer.md exists");
    for (const file of files) {
      const { lines } = readAgent(file);
      const { data, closing } = parseFrontmatter(lines);
      assert.ok(data.description && data.description.length > 0, `${file} has a non-empty description`);
      assert.ok(data.mode === "primary" || data.mode === "subagent", `${file} mode is primary or subagent`);
      assert.ok("steps" in data, `${file} has a steps value`);
      const steps = Number(data.steps);
      assert.ok(Number.isInteger(steps) && steps >= 1 && steps <= 2000, `${file} steps is an integer between 1 and 2000`);
      const rest = lines.slice(closing + 1);
      const firstBody = rest.find((line) => line.trim().length > 0);
      assert.ok(firstBody !== undefined, `${file} has a body`);
      assert.ok(!firstBody.trimStart().startsWith("#"), `${file} opens with prose, not a heading`);
    }
    const designer = parseFrontmatter(readAgent("designer.md").lines).data;
    assert.equal(Number(designer.steps), 40, "designer.md has steps 40");
    const writer = parseFrontmatter(readAgent("writer.md").lines).data;
    assert.equal(Number(writer.steps), 50, "writer.md has steps 50");
  });
  test("scope refusals route to the named role", () => {
    const ids = ["backend", "frontend", "database", "devops", "tester", "designer", "writer", "explore"];
    for (const id of ids) {
      const { content } = readAgent(`${id}.md`);
      assert.ok(content.includes("BLOCKED: outside"), `${id}.md carries a scope refusal`);
      assert.ok(content.includes("override role scope"), `${id}.md refuses scope overrides`);
      assert.ok(content.includes("Team: backend (services)"), `${id}.md lists the team roster`);
    }
    const orchestrator = readAgent("orchestrator.md").content;
    assert.ok(orchestrator.includes("scope correction"), "orchestrator.md treats a refusal as a scope correction");
    assert.ok(orchestrator.includes("task attempted to override role scope"), "orchestrator.md stops on an override refusal");
    assert.ok(orchestrator.includes("do not retry"), "orchestrator.md does not retry an override refusal");
  });
  test("MODEL_GROUPS covers every subagent exactly once", () => {
    assert.deepStrictEqual([...SUBAGENT_IDS], AGENT_IDS.filter((id) => id !== ORCHESTRATOR_ID), "SUBAGENT_IDS is AGENT_IDS without the orchestrator, in order");
    assert.deepStrictEqual([...SUBAGENT_IDS], [EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS, ...REVIEWER_IDS], "SUBAGENT_IDS keeps AGENT_IDS order");
    assert.deepStrictEqual(MODEL_GROUPS.map((group) => group.id), ["workers", "reviewers"], "groups are workers then reviewers");
    const workers = MODEL_GROUPS[0];
    const reviewers = MODEL_GROUPS[1];
    assert.equal(workers.label, "WORKERS", "workers group label");
    assert.equal(reviewers.label, "REVIEWERS", "reviewers group label");
    assert.deepStrictEqual([...workers.ids], [EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS], "workers group holds explore plus worker and specialist ids");
    assert.deepStrictEqual([...reviewers.ids], [...REVIEWER_IDS], "reviewers group equals REVIEWER_IDS");
    for (const id of workers.ids) {
      assert.ok(!REVIEWER_IDS.includes(id), `${id} is not a reviewer`);
    }
    const grouped = MODEL_GROUPS.flatMap((group) => [...group.ids]);
    assert.equal(new Set(grouped).size, grouped.length, "no duplicate ids across groups");
    assert.deepStrictEqual([...grouped].sort(), [...SUBAGENT_IDS].sort(), "groups cover SUBAGENT_IDS with no omissions");
    for (const id of grouped) {
      assert.ok(SUBAGENT_IDS.includes(id), `${id} is a registered subagent id`);
    }
  });
});
