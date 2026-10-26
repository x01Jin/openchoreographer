import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_IDS } from "../src/shared/agents";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install.mjs");
const BUNDLED_BACKEND = path.join(REPO_ROOT, "agents", "backend.md");
const STEPS_RE = /^steps:[ \t]*["']?(-?\d+)/m;

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfigDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openchoreographer-installer-"));
  tempDirs.push(tmp);
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir, { recursive: true });
  return configDir;
}

function runInstaller(args: string[], configDir: string) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

function bundledContent(): string {
  return fs.readFileSync(BUNDLED_BACKEND, "utf8");
}

function installedBackend(configDir: string): string {
  return path.join(configDir, "agents", "backend.md");
}

describe("installer step-budget preservation", () => {
  test("--reset-steps is no longer a flag", () => {
    const configDir = makeConfigDir();
    const result = runInstaller(["--reset-steps"], configDir);
    assert.equal(result.status, 1);
    assert.ok((result.stdout + result.stderr).includes("Unknown argument(s)"));
  });

  test("a body steps line is never promoted to a budget", () => {
    const configDir = makeConfigDir();
    const first = runInstaller(["--force", "--no-deps"], configDir);
    assert.equal(first.status, 0, first.stderr);
    const dest = installedBackend(configDir);
    const stripped = bundledContent().replace(/^steps:[ \t]*["']?-?\d+.*\r?\n/m, "");
    assert.ok(!STEPS_RE.test(stripped), "seed has no frontmatter steps line");
    fs.writeFileSync(dest, `${stripped}steps: 3\n`);
    const upgrade = runInstaller(["--force", "--no-deps"], configDir);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    const result = fs.readFileSync(dest, "utf8");
    assert.equal(result, bundledContent());
    assert.ok(!result.includes("steps: 3"), "body prose is not promoted to a budget");
  });

  test("local install copies the nested source tree and reports stale without --force", () => {
    const configDir = makeConfigDir();
    const first = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(first.status, 0, first.stderr);
    const nestedAgents = path.join(configDir, "plugins", "openchoreographer", "src", "shared", "agents.ts");
    const nestedFallback = path.join(configDir, "plugins", "openchoreographer", "src", "server", "fallback.ts");
    const agentsContent = fs.readFileSync(nestedAgents, "utf8");
    const fallbackContent = fs.readFileSync(nestedFallback, "utf8");
    assert.ok(agentsContent.trim().length > 0, "nested agents.ts is non-empty");
    assert.ok(fallbackContent.trim().length > 0, "nested fallback.ts is non-empty");
    const second = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.includes("stale=0"), "re-run reports no stale");
    assert.ok(!second.stdout.includes("stale:"), "re-run reports no stale file line");
    const tampered = `${agentsContent}\n// TAMPER-NESTED-SRC\n`;
    fs.writeFileSync(nestedAgents, tampered);
    const third = runInstaller(["--local", "--no-deps"], configDir);
    assert.equal(third.status, 2, third.stderr);
    const output = `${third.stdout}${third.stderr}`;
    assert.ok(output.includes("stale:"), "tampered file is reported stale");
    assert.ok(output.includes(nestedAgents), "stale line names the tampered nested path");
    assert.equal(fs.readFileSync(nestedAgents, "utf8"), tampered, "tampered content survives without --force");
  });

  test("local install ships every AGENT_IDS agent file to both destinations", () => {
    const configDir = makeConfigDir();
    const result = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(result.status, 0, result.stderr);
    for (const base of [
      path.join(configDir, "agents"),
      path.join(configDir, "plugins", "openchoreographer", "agents"),
    ]) {
      const files = fs.readdirSync(base).filter((f) => f.endsWith(".md")).sort();
      assert.equal(files.length, AGENT_IDS.length, `expected ${AGENT_IDS.length} agent files in ${base}`);
      assert.ok(files.includes("designer.md"), "designer.md is installed");
      assert.ok(files.includes("writer.md"), "writer.md is installed");
    }
  });
});
