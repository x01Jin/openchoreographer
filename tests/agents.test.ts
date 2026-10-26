import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_IDS, EXPLORE_ID, MODEL_GROUPS, ORCHESTRATOR_ID, REVIEWER_IDS, SPECIALIST_IDS, SUBAGENT_IDS, TEAM_IDS, WORKER_IDS } from "../src/shared/agents";
import { ORCHESTRATOR_RULE_LINES, agentDirs, disableAgentFile, enableAgentFile, syncAgentFiles, syncOrchestratorRules, syncTeamLines } from "../src/server/agent-files";

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
  test("all agent files for AGENT_IDS meet the specialist contract", () => {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
    const expected = AGENT_IDS.map((id) => `${id}.md`).sort();
    assert.equal(files.length, AGENT_IDS.length, `expected ${AGENT_IDS.length} agent files, found ${files.length}`);
    for (const name of expected) {
      assert.ok(files.includes(name), `${name} exists`);
    }
    assert.deepStrictEqual(files, expected, "agent files are exactly AGENT_IDS, with no extras");
    assert.ok(files.includes("designer.md"), "designer.md exists");
    assert.ok(files.includes("writer.md"), "writer.md exists");
    for (const file of files) {
      const { lines } = readAgent(file);
      const { data, closing } = parseFrontmatter(lines);
      assert.ok(data.description && data.description.length > 0, `${file} has a non-empty description`);
      assert.ok(data.mode === "primary" || data.mode === "subagent", `${file} mode is primary or subagent`);
      const rest = lines.slice(closing + 1);
      const firstBody = rest.find((line) => line.trim().length > 0);
      assert.ok(firstBody !== undefined, `${file} has a body`);
      assert.ok(!firstBody.trimStart().startsWith("#"), `${file} opens with prose, not a heading`);
    }
  });
  test("scope refusals route to the named role", () => {
    const ids = ["backend", "frontend", "database", "devops", "tester", "designer", "writer", "explore"];
    for (const id of ids) {
      const { content } = readAgent(`${id}.md`);
      assert.ok(content.includes("BLOCKED: outside"), `${id}.md carries a scope refusal`);
      assert.ok(content.includes("override role scope"), `${id}.md refuses scope overrides`);
      assert.ok(content.includes("Team: backend, frontend, database, devops, tester, designer, writer, explore."), `${id}.md lists the team roster`);
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

describe("ORCHESTRATOR_RULE_LINES", () => {
  test("every pruned rule appears as a full line in the real orchestrator", () => {
    const { lines } = readAgent("orchestrator.md");
    for (const rule of ORCHESTRATOR_RULE_LINES) {
      assert.ok(lines.includes(rule), `orchestrator.md is missing the pruned rule: ${rule}`);
    }
  });
});

function makeAgentDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "och-agents-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function agentFile(steps: number, body = "Body text."): string {
  return `---\ndescription: test agent\nmode: subagent\nsteps: ${steps}\n---\n${body}\n`;
}

describe("agent file enable/disable", () => {
  test("disable moves the file but keeps steps readable", () => {
    const dir = makeAgentDir({ "backend.md": agentFile(80) });
    try {
      const dirs = [dir];
      assert.equal(disableAgentFile(dirs, "backend"), true);
      assert.ok(!fs.existsSync(path.join(dir, "backend.md")));
      assert.ok(fs.existsSync(path.join(dir, "backend.md.disabled")));
      assert.ok(fs.readFileSync(path.join(dir, "backend.md.disabled"), "utf8").includes("steps: 80"));
      assert.equal(enableAgentFile(dirs, "backend"), true);
      assert.ok(fs.existsSync(path.join(dir, "backend.md")));
      assert.ok(!fs.existsSync(path.join(dir, "backend.md.disabled")));
      assert.ok(fs.readFileSync(path.join(dir, "backend.md"), "utf8").includes("steps: 80"));
    } finally {
      removeDir(dir);
    }
  });
  test("disable twice is idempotent; enable with nothing disabled returns false", () => {
    const dir = makeAgentDir({ "backend.md": agentFile(80) });
    try {
      const dirs = [dir];
      assert.equal(disableAgentFile(dirs, "backend"), true);
      assert.equal(disableAgentFile(dirs, "backend"), false);
      assert.equal(enableAgentFile(dirs, "backend"), true);
      assert.equal(enableAgentFile(dirs, "backend"), false);
    } finally {
      removeDir(dir);
    }
  });
  test("disable with an existing disabled copy keeps the normal content and old steps, with no backup left", () => {
    const dir = makeAgentDir({ "backend.md": agentFile(80, "Normal body."), "backend.md.disabled": agentFile(55, "Old disabled body.") });
    try {
      const dirs = [dir];
      assert.equal(disableAgentFile(dirs, "backend"), true);
      assert.ok(!fs.existsSync(path.join(dir, "backend.md")));
      const content = fs.readFileSync(path.join(dir, "backend.md.disabled"), "utf8");
      assert.ok(content.includes("Normal body."), "new disabled file has the normal content");
      assert.ok(!content.includes("Old disabled body."), "old disabled content is displaced");
      assert.ok(content.includes("steps: 55"), "old disabled steps are preserved");
      assert.ok(!fs.existsSync(path.join(dir, "backend.md.disabled.bak")), "no .bak remains");
    } finally {
      removeDir(dir);
    }
  });
  test("disable with a normal file lacking frontmatter moves it without applying old steps", () => {
    const dir = makeAgentDir({ "backend.md": "no frontmatter here\n", "backend.md.disabled": agentFile(55) });
    try {
      const dirs = [dir];
      assert.equal(disableAgentFile(dirs, "backend"), true);
      assert.ok(!fs.existsSync(path.join(dir, "backend.md")));
      assert.equal(fs.readFileSync(path.join(dir, "backend.md.disabled"), "utf8"), "no frontmatter here\n");
      assert.ok(!fs.existsSync(path.join(dir, "backend.md.disabled.bak")), "no .bak remains");
    } finally {
      removeDir(dir);
    }
  });
  test("enable with both files keeps the normal file and copies steps", () => {
    const dir = makeAgentDir({ "backend.md": agentFile(80), "backend.md.disabled": agentFile(99) });
    try {
      const dirs = [dir];
      assert.equal(enableAgentFile(dirs, "backend"), true);
      assert.ok(fs.existsSync(path.join(dir, "backend.md")));
      assert.ok(!fs.existsSync(path.join(dir, "backend.md.disabled")));
      assert.ok(fs.readFileSync(path.join(dir, "backend.md"), "utf8").includes("steps: 99"));
    } finally {
      removeDir(dir);
    }
  });
  test("enable with a normal file lacking frontmatter throws and restores the disabled copy", () => {
    const normal = "no frontmatter here\n";
    const disabled = agentFile(77);
    const dir = makeAgentDir({ "backend.md": normal, "backend.md.disabled": disabled });
    try {
      const dirs = [dir];
      assert.throws(() => enableAgentFile(dirs, "backend"));
      assert.equal(fs.readFileSync(path.join(dir, "backend.md"), "utf8"), normal);
      assert.equal(fs.readFileSync(path.join(dir, "backend.md.disabled"), "utf8"), disabled);
      assert.ok(!fs.existsSync(path.join(dir, "backend.md.disabled.bak")), "no .bak remains");
    } finally {
      removeDir(dir);
    }
  });
  test("syncAgentFiles disables listed ids and restores the rest", () => {
    const dir = makeAgentDir({ "writer.md": agentFile(50), "backend.md.disabled": agentFile(80) });
    try {
      const dirs = [dir];
      assert.equal(syncAgentFiles(dirs, ["writer"]), true);
      assert.ok(fs.existsSync(path.join(dir, "writer.md.disabled")));
      assert.ok(!fs.existsSync(path.join(dir, "writer.md")));
      assert.ok(fs.existsSync(path.join(dir, "backend.md")));
      assert.ok(!fs.existsSync(path.join(dir, "backend.md.disabled")));
      assert.equal(syncAgentFiles(dirs, ["writer"]), false);
    } finally {
      removeDir(dir);
    }
  });
});

describe("syncOrchestratorRules", () => {
  const MINI_ORCHESTRATOR = [
    "---",
    "description: orch",
    "mode: primary",
    "steps: 90",
    "---",
    "You are the tech lead.",
    "",
    "- Use the smallest set of agents that can do the work well. Answer a request that needs no file change yourself with read, glob, and grep; spawn `explore` only when the sweep would flood your context with file bodies it can compress into a map.",
    "- When `explore` ran, paste its map verbatim into every child prompt so the child does not rediscover the tree.",
    "- Use `designer` before `frontend` when a task changes a flow, state, empty/error case, or user-facing copy; paste its `STATES` and `COPY` into the `frontend` prompt, and never run it alone because it cannot edit.",
    "- Use `writer` once behavior and interface have settled, for README, docs, changelog, and migration notes; expect `BLOCKED` when the docs need a code change.",
    "",
    "Route review work from the injected routing table in your system context. Tier 2 and Tier 3 include the correctness lens; Tier 1 skips reviewers and reads the diff itself. Add `reviewer-security` when the `Risk:` line from the `diff` tool reports a signal, and also when you judge the change touches input handling, deserialization, SSRF, or path handling, which the signals do not detect.",
    "",
    "Plan stage, before the first delegation:",
    "",
    "- Run `reviewer-scope` only when the value of the work is genuinely unclear: a rewrite, a new subsystem, or work that may already exist. It is advisory: report its verdict, never block on it.",
    "- Run `reviewer-plan` on the written plan before the first delegation, on Tier 3 work only. Fix blocker findings before delegating.",
    "- Run `reviewer-execution` on the revised plan when `reviewer-plan` found blockers, or when the plan cites files or symbols you have not verified. A `VERDICT: BLOCK` stops the task until the plan is corrected.",
    "- Skip plan review on Tier 1 and Tier 2 work.",
    "",
    "- Tier 3, over five files or any `Risk:` signal: workers, correctness lens plus `reviewer-security`, plus `tester` if behavior changed.",
    "",
  ].join("\n");
  const DESIGNER_LINE = "- Use `designer` before `frontend` when a task changes a flow, state, empty/error case, or user-facing copy; paste its `STATES` and `COPY` into the `frontend` prompt, and never run it alone because it cannot edit.";
  const WRITER_LINE = "- Use `writer` once behavior and interface have settled, for README, docs, changelog, and migration notes; expect `BLOCKED` when the docs need a code change.";
  const REVIEWER_SCOPE_LINE = "- Run `reviewer-scope` only when the value of the work is genuinely unclear: a rewrite, a new subsystem, or work that may already exist. It is advisory: report its verdict, never block on it.";
  const REVIEWER_PLAN_LINE = "- Run `reviewer-plan` on the written plan before the first delegation, on Tier 3 work only. Fix blocker findings before delegating.";
  const REVIEWER_TIER3 = "- Tier 3, over five files or any `Risk:` signal: workers, correctness lens, plus `tester` if behavior changed.";
  test("disabling designer removes only its line and saves the full copy", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      const live = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.ok(!live.includes(DESIGNER_LINE));
      assert.ok(live.includes(WRITER_LINE));
      assert.ok(live.includes("spawn `explore`"));
      assert.equal(fs.readFileSync(path.join(dir, "orchestrator.md.full"), "utf8"), MINI_ORCHESTRATOR);
    } finally {
      removeDir(dir);
    }
  });
  test("disabling designer again is idempotent", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      const once = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), false);
      assert.equal(fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8"), once);
      assert.equal(fs.readFileSync(path.join(dir, "orchestrator.md.full"), "utf8"), MINI_ORCHESTRATOR);
    } finally {
      removeDir(dir);
    }
  });
  test("enabling restores the exact body and drops the sidecar, keeping a changed steps value", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      const target = path.join(dir, "orchestrator.md");
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("steps: 90", "steps: 95"), "utf8");
      assert.equal(syncOrchestratorRules(dirs, []), true);
      assert.equal(fs.readFileSync(target, "utf8"), MINI_ORCHESTRATOR.replace("steps: 90", "steps: 95"));
      assert.ok(!fs.existsSync(path.join(dir, "orchestrator.md.full")));
      assert.equal(syncOrchestratorRules(dirs, []), false);
    } finally {
      removeDir(dir);
    }
  });
  test("disabling explore removes only its clause", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["explore"]), true);
      const live = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.ok(!live.includes("spawn `explore`"));
      assert.ok(live.includes("- Use the smallest set of agents that can do the work well. Answer a request that needs no file change yourself with read, glob, and grep."));
      assert.ok(!live.includes("- When `explore` ran, paste its map verbatim into every child prompt so the child does not rediscover the tree."));
      assert.ok(live.includes(DESIGNER_LINE));
    } finally {
      removeDir(dir);
    }
  });
  test("disabling reviewer-security removes its sentence and Tier 3 clause", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["reviewer-security"]), true);
      const live = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.ok(!live.includes("Add `reviewer-security` when the `Risk:` line"));
      assert.ok(live.includes(REVIEWER_TIER3));
    } finally {
      removeDir(dir);
    }
  });
  test("disabling one plan reviewer removes only its line", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["reviewer-plan"]), true);
      const live = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.ok(!live.includes(REVIEWER_PLAN_LINE));
      assert.ok(live.includes("Plan stage, before the first delegation:"));
      assert.ok(live.includes(REVIEWER_SCOPE_LINE));
      assert.ok(live.includes("- Skip plan review on Tier 1 and Tier 2 work."));
    } finally {
      removeDir(dir);
    }
  });
  test("disabling all three plan reviewers removes the whole plan-stage block", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["reviewer-scope", "reviewer-plan", "reviewer-execution"]), true);
      const live = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.ok(!live.includes("Plan stage, before the first delegation:"));
      assert.ok(!live.includes("`reviewer-scope`"));
      assert.ok(!live.includes("`reviewer-plan`"));
      assert.ok(!live.includes("`reviewer-execution`"));
      assert.ok(!live.includes("Skip plan review"));
      assert.ok(live.includes(DESIGNER_LINE));
      assert.ok(!/\n{3,}/.test(live));
    } finally {
      removeDir(dir);
    }
  });
  test("disabling reviewer-plan rewrites the execution bullet without naming it", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      assert.equal(syncOrchestratorRules(dirs, ["reviewer-plan"]), true);
      const live = fs.readFileSync(path.join(dir, "orchestrator.md"), "utf8");
      assert.ok(!live.includes(REVIEWER_PLAN_LINE));
      assert.ok(!live.includes("`reviewer-plan` found blockers"));
      assert.ok(live.includes("- Run `reviewer-execution` on the revised plan when the plan cites files or symbols you have not verified. A `VERDICT: BLOCK` stops the task until the plan is corrected."));
      assert.ok(live.includes("Plan stage, before the first delegation:"));
    } finally {
      removeDir(dir);
    }
  });
  test("incremental disables keep earlier rules in the sidecar until all are enabled", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      const target = path.join(dir, "orchestrator.md");
      const sidecar = path.join(dir, "orchestrator.md.full");
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      assert.equal(syncOrchestratorRules(dirs, ["designer", "writer"]), true);
      const sidecarText = fs.readFileSync(sidecar, "utf8");
      assert.ok(sidecarText.includes(DESIGNER_LINE));
      assert.ok(sidecarText.includes(WRITER_LINE));
      assert.equal(fs.readFileSync(path.join(dir, "orchestrator.md.full.json"), "utf8"), JSON.stringify({ disabled: ["designer", "writer"] }));
      let live = fs.readFileSync(target, "utf8");
      assert.ok(!live.includes(DESIGNER_LINE));
      assert.ok(!live.includes(WRITER_LINE));
      assert.equal(syncOrchestratorRules(dirs, ["writer"]), true);
      live = fs.readFileSync(target, "utf8");
      assert.ok(live.includes(DESIGNER_LINE));
      assert.ok(!live.includes(WRITER_LINE));
      assert.equal(syncOrchestratorRules(dirs, []), true);
      assert.equal(fs.readFileSync(target, "utf8"), MINI_ORCHESTRATOR);
      assert.ok(!fs.existsSync(sidecar));
      assert.ok(!fs.existsSync(path.join(dir, "orchestrator.md.full.json")));
      assert.equal(syncOrchestratorRules(dirs, []), false);
    } finally {
      removeDir(dir);
    }
  });
  test("a forced full rewrite while disabled updates the sidecar and stays pruned", () => {
    const dir = makeAgentDir({ "orchestrator.md": MINI_ORCHESTRATOR });
    try {
      const dirs = [dir];
      const target = path.join(dir, "orchestrator.md");
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      const forced = MINI_ORCHESTRATOR.replace("You are the tech lead.", "You are the tech lead. An extra forced sentence.");
      fs.writeFileSync(target, forced, "utf8");
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      assert.equal(fs.readFileSync(path.join(dir, "orchestrator.md.full"), "utf8"), forced);
      const live = fs.readFileSync(target, "utf8");
      assert.ok(live.includes("An extra forced sentence."));
      assert.ok(!live.includes(DESIGNER_LINE));
    } finally {
      removeDir(dir);
    }
  });
  test("CRLF line endings survive pruning and restore", () => {
    const crlf = MINI_ORCHESTRATOR.split("\n").join("\r\n");
    const dir = makeAgentDir({ "orchestrator.md": crlf });
    try {
      const dirs = [dir];
      const target = path.join(dir, "orchestrator.md");
      assert.equal(syncOrchestratorRules(dirs, ["designer"]), true);
      const live = fs.readFileSync(target, "utf8");
      assert.ok(live.includes("\r\n"));
      assert.ok(!live.replace(/\r\n/g, "").includes("\n"));
      assert.ok(!live.includes(DESIGNER_LINE));
      assert.equal(syncOrchestratorRules(dirs, []), true);
      assert.equal(fs.readFileSync(target, "utf8"), crlf);
    } finally {
      removeDir(dir);
    }
  });
});

describe("syncTeamLines", () => {
  const LONG_TEAM = "Team: backend (services), frontend (UI), database (schema), devops (pipeline), tester (tests), designer (flows), writer (docs), explore (recon).";
  const FULL_TEAM = "Team: backend, frontend, database, devops, tester, designer, writer, explore.";
  const PRUNED_TEAM = "Team: backend, frontend, database, devops, tester, designer, explore.";
  test("TEAM_IDS holds the eight team ids in order", () => {
    assert.deepStrictEqual([...TEAM_IDS], ["backend", "frontend", "database", "devops", "tester", "designer", "writer", "explore"]);
  });
  test("prunes disabled ids, is idempotent, and restores the full list", () => {
    const dir = makeAgentDir({
      "backend.md": agentFile(80, `Do work. ${LONG_TEAM} Done.`),
      "frontend.md": agentFile(80, `Do work. ${LONG_TEAM} Done.`),
      "reviewer.md": agentFile(40, "No team line here."),
      "writer.md.disabled": agentFile(50, `Do work. ${LONG_TEAM} Done.`),
    });
    try {
      const dirs = [dir];
      assert.equal(syncTeamLines(dirs, ["writer"]), true);
      for (const name of ["backend.md", "frontend.md"]) {
        const content = fs.readFileSync(path.join(dir, name), "utf8");
        assert.ok(content.includes(PRUNED_TEAM), `${name} prunes writer`);
        assert.ok(!content.includes("writer"), `${name} mentions no writer`);
        assert.ok(content.includes("steps: 80"), `${name} keeps frontmatter`);
      }
      assert.equal(syncTeamLines(dirs, ["writer"]), false);
      assert.equal(syncTeamLines(dirs, []), true);
      for (const name of ["backend.md", "frontend.md"]) {
        const content = fs.readFileSync(path.join(dir, name), "utf8");
        assert.ok(content.includes(FULL_TEAM), `${name} restores the full list`);
      }
      assert.equal(syncTeamLines(dirs, []), false);
      assert.equal(fs.readFileSync(path.join(dir, "reviewer.md"), "utf8"), agentFile(40, "No team line here."));
      assert.ok(!fs.existsSync(path.join(dir, "writer.md")), "moved-aside writer is not recreated");
      assert.ok(fs.existsSync(path.join(dir, "writer.md.disabled")), "moved-aside writer is not read");
    } finally {
      removeDir(dir);
    }
  });
});

describe("agentDirs config dir", () => {
  test("includes an absolute OPENCODE_CONFIG_DIR/agents before the XDG dir", () => {
    const previous = process.env.OPENCODE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "och-config-"));
    try {
      process.env.OPENCODE_CONFIG_DIR = configDir;
      const dirs = agentDirs({ directory: path.join(os.tmpdir(), "och-project") });
      const custom = path.join(configDir, "agents");
      const xdg = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "agents");
      assert.ok(dirs.includes(custom));
      assert.ok(dirs.indexOf(custom) < dirs.indexOf(xdg));
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previous;
      removeDir(configDir);
    }
  });
  test("ignores a relative OPENCODE_CONFIG_DIR", () => {
    const previous = process.env.OPENCODE_CONFIG_DIR;
    try {
      process.env.OPENCODE_CONFIG_DIR = path.join("relative", "config");
      const dirs = agentDirs({ directory: path.join(os.tmpdir(), "och-project") });
      assert.ok(dirs.every((dir) => !dir.includes("relative")));
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previous;
    }
  });
});
