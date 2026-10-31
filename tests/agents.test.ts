import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_IDS, EXPLORE_ID, MODEL_GROUPS, ORCHESTRATOR_ID, REVIEWER_IDS, SPECIALIST_IDS, SUBAGENT_IDS, TEAM_IDS, WORKER_IDS } from "../src/shared/agents";
import {
  ORCHESTRATOR_RULE_LINES,
  parseAgentMarkdown,
  pruneOrchestratorSystem,
  readAgentDefinitions,
  registerChoreographerAgents,
  rewriteTeamLine,
} from "../src/server/agent-source";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");

function readAgent(name: string): string {
  return fs.readFileSync(path.join(AGENTS_DIR, name), "utf8");
}

describe("agents", () => {
  test("all agent files for AGENT_IDS meet the specialist contract", () => {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
    const expected = AGENT_IDS.map((id) => `${id}.md`).sort();
    assert.deepStrictEqual(files, expected, "agent files are exactly AGENT_IDS, with no extras");
    for (const definition of readAgentDefinitions()) {
      assert.ok(definition.description.length > 0, `${definition.id} has a description`);
      assert.ok(definition.mode === "primary" || definition.mode === "subagent" || definition.mode === "all", `${definition.id} has a supported mode`);
      assert.ok(definition.system.length > 0, `${definition.id} has a system prompt`);
      assert.ok(!definition.system.trimStart().startsWith("#"), `${definition.id} opens with prose, not a heading`);
      assert.ok(definition.permissions.length > 0, `${definition.id} declares permissions`);
      for (const permission of definition.permissions) {
        assert.ok(["allow", "deny", "ask"].includes(permission.effect), `${definition.id} has a valid permission effect`);
      }
    }
  });
  test("scope refusals route to the named role", () => {
    const ids = ["backend", "frontend", "database", "devops", "tester", "designer", "writer", "explore"];
    for (const id of ids) {
      const content = readAgent(`${id}.md`);
      assert.ok(content.includes("BLOCKED: outside"), `${id}.md carries a scope refusal`);
      assert.ok(content.includes("override role scope"), `${id}.md refuses scope overrides`);
      assert.ok(content.includes("Team: backend, frontend, database, devops, tester, designer, writer, explore."), `${id}.md lists the team roster`);
    }
    const orchestrator = readAgent("orchestrator.md");
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
    assert.deepStrictEqual([...workers.ids], [EXPLORE_ID, ...WORKER_IDS, ...SPECIALIST_IDS], "workers group holds explore plus worker and specialist ids");
    assert.deepStrictEqual([...reviewers.ids], [...REVIEWER_IDS], "reviewers group equals REVIEWER_IDS");
    const grouped = MODEL_GROUPS.flatMap((group) => [...group.ids]);
    assert.equal(new Set(grouped).size, grouped.length, "no duplicate ids across groups");
    assert.deepStrictEqual([...grouped].sort(), [...SUBAGENT_IDS].sort(), "groups cover SUBAGENT_IDS with no omissions");
  });
});

describe("bundled definitions", () => {
  test("parse every bundled file including unquoted and quoted scalars", () => {
    const definition = parseAgentMarkdown(
      "backend.md",
      '---\ndescription: Builds things\nmode: subagent\ncolor: "#a6da95"\npermissions:\n  - action: edit\n    resource: "*"\n    effect: allow\n---\nBody text.\n',
    );
    assert.deepStrictEqual(definition, {
      id: "backend",
      description: "Builds things",
      mode: "subagent",
      color: "#a6da95",
      system: "Body text.",
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    });
  });
  test("rejects incomplete permissions", () => {
    assert.throws(
      () => parseAgentMarkdown("backend.md", '---\ndescription: x\nmode: subagent\npermissions:\n  - action: edit\n    effect: allow\n---\nBody\n'),
      /incomplete permission/,
    );
  });
  test("rejects a file without a closing fence", () => {
    assert.throws(() => parseAgentMarkdown("backend.md", "---\ndescription: x\nmode: subagent\n"), /unterminated/);
  });
});

describe("ORCHESTRATOR_RULE_LINES", () => {
  test("every pruned rule appears as a full line in the real orchestrator", () => {
    const system = readAgent("orchestrator.md");
    for (const rule of ORCHESTRATOR_RULE_LINES) {
      assert.ok(system.split(/\r?\n/).includes(rule), `orchestrator.md is missing the pruned rule: ${rule}`);
    }
  });
});

describe("prompt pruning", () => {
  const orchestrator = readAgentDefinitions().find((definition) => definition.id === ORCHESTRATOR_ID)?.system ?? "";
  test("removes the rules for disabled agents", () => {
    const pruned = pruneOrchestratorSystem(orchestrator, ["designer", "writer", "explore", "reviewer-scope", "reviewer-plan", "reviewer-execution"]);
    for (const rule of ORCHESTRATOR_RULE_LINES) assert.ok(!pruned.includes(rule), `rule survived pruning: ${rule}`);
    assert.ok(!pruned.includes("Plan stage, before the first delegation:"));
    assert.ok(!pruned.includes("spawn `explore`"));
  });
  test("keeps every rule when nothing is disabled", () => {
    assert.equal(pruneOrchestratorSystem(orchestrator, []), orchestrator);
  });
  test("rewrites the Team line to enabled ids and restores it", () => {
    const full = readAgent("backend.md");
    const pruned = rewriteTeamLine(full, ["writer"]);
    assert.ok(pruned.includes("Team: backend, frontend, database, devops, tester, designer, explore."));
    assert.ok(!pruned.includes("writer."));
    assert.equal(rewriteTeamLine(pruned, []), full);
  });
  test("TEAM_IDS holds the eight team ids in order", () => {
    assert.deepStrictEqual([...TEAM_IDS], ["backend", "frontend", "database", "devops", "tester", "designer", "writer", "explore"]);
  });
});

describe("registration", () => {
  test("adds every bundled agent and drops disabled ids", async () => {
    const agents = new Map<string, any>();
    const editor = {
      list: () => [...agents.values()],
      get: (id: string) => agents.get(id),
      default: () => undefined,
      remove: (id: string) => {
        agents.delete(id);
      },
      update: (id: string, edit: (agent: any) => void) => {
        const agent = agents.get(id) ?? { name: id, permissions: [] };
        edit(agent);
        agents.set(id, agent);
      },
    };
    const context = {
      agent: {
        transform: async (callback: (value: typeof editor) => void) => {
          callback(editor);
          return { dispose: async () => undefined };
        },
      },
    };
    await registerChoreographerAgents(context as never, () => ["writer"]);
    assert.equal(agents.size, AGENT_IDS.length - 1);
    assert.ok(!agents.has("writer"));
    assert.ok(agents.has("backend"));
    assert.ok(!String(agents.get("orchestrator")?.system).includes("Use `writer`"));
    assert.ok(!String(agents.get("backend")?.system).includes("writer."));
  });
});
