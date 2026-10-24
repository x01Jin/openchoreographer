import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function bundledSteps(): string {
  const match = bundledContent().match(STEPS_RE);
  assert.ok(match, "bundled backend.md has a steps line");
  return match[1];
}

function installedBackend(configDir: string): string {
  return path.join(configDir, "agents", "backend.md");
}

function installedPluginBackend(configDir: string): string {
  return path.join(configDir, "plugins", "openchoreographer", "agents", "backend.md");
}

function withSteps(content: string, value: number): string {
  assert.ok(STEPS_RE.test(content), "source has a steps line to replace");
  return content.replace(/^steps:[ \t]*["']?-?\d+.*/m, `steps: ${value}`);
}

function readSteps(file: string): string | null {
  const match = fs.readFileSync(file, "utf8").match(STEPS_RE);
  return match ? match[1] : null;
}

describe("installer step-budget preservation", () => {
  test("force upgrade keeps a tuned steps budget and refreshes the body", () => {
    const configDir = makeConfigDir();
    const first = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(first.status, 0, first.stderr);
    const dest = installedBackend(configDir);
    const pluginDest = installedPluginBackend(configDir);
    const seeded = `${withSteps(bundledContent(), 85)}\nTUNED-MARKER-LINE\n`;
    fs.writeFileSync(dest, seeded);
    fs.writeFileSync(pluginDest, `${withSteps(bundledContent(), 85)}\nTUNED-MARKER-PLUGIN\n`);
    const upgrade = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    const result = fs.readFileSync(dest, "utf8");
    assert.ok(result.includes("steps: 85"), "tuned budget survives the upgrade");
    assert.ok(!result.includes("TUNED-MARKER-LINE"), "body is refreshed to the bundled content");
    assert.equal(result, withSteps(bundledContent(), 85));
    assert.ok(upgrade.stdout.includes("(steps kept)"), "upgrade reports the kept budget");
    assert.equal(readSteps(pluginDest), "85", "plugin copy keeps the tuned budget");
    assert.equal(fs.readFileSync(pluginDest, "utf8"), withSteps(bundledContent(), 85));
  });

  test("--reset-steps restores the bundled step budget", () => {
    const configDir = makeConfigDir();
    const first = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(first.status, 0, first.stderr);
    const dest = installedBackend(configDir);
    const pluginDest = installedPluginBackend(configDir);
    fs.writeFileSync(dest, withSteps(bundledContent(), 85));
    fs.writeFileSync(pluginDest, withSteps(bundledContent(), 85));
    const reset = runInstaller(["--local", "--force", "--no-deps", "--reset-steps"], configDir);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(readSteps(dest), bundledSteps());
    assert.equal(fs.readFileSync(dest, "utf8"), bundledContent());
    assert.equal(readSteps(pluginDest), bundledSteps());
    assert.equal(fs.readFileSync(pluginDest, "utf8"), bundledContent());
  });

  test("dry run reports (steps kept) when only the budget differs", () => {
    const configDir = makeConfigDir();
    const first = runInstaller(["--force", "--no-deps"], configDir);
    assert.equal(first.status, 0, first.stderr);
    const dest = installedBackend(configDir);
    fs.writeFileSync(dest, withSteps(bundledContent(), 85));
    const before = fs.readFileSync(dest);
    const dry = runInstaller(["--force", "--no-deps", "--dry-run"], configDir);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok((dry.stdout + dry.stderr).includes("(steps kept)"), "dry run reports the kept budget");
    assert.ok(fs.readFileSync(dest).equals(before), "dry run writes nothing");
  });

  test("--reset-steps without --force exits 1", () => {
    const configDir = makeConfigDir();
    const result = runInstaller(["--reset-steps"], configDir);
    assert.equal(result.status, 1);
    assert.ok((result.stdout + result.stderr).includes("--reset-steps requires --force"));
  });

  test("a destination without a steps line is overwritten as before", () => {
    const configDir = makeConfigDir();
    const first = runInstaller(["--force", "--no-deps"], configDir);
    assert.equal(first.status, 0, first.stderr);
    const dest = installedBackend(configDir);
    const stripped = bundledContent().replace(/^steps:[ \t]*["']?-?\d+.*\r?\n/m, "");
    assert.ok(!STEPS_RE.test(stripped), "seed has no steps line");
    fs.writeFileSync(dest, stripped);
    const upgrade = runInstaller(["--force", "--no-deps"], configDir);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.equal(fs.readFileSync(dest, "utf8"), bundledContent());
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

  test("local install ships all eleven agent files to both destinations", () => {
    const configDir = makeConfigDir();
    const result = runInstaller(["--local", "--force", "--no-deps"], configDir);
    assert.equal(result.status, 0, result.stderr);
    for (const base of [
      path.join(configDir, "agents"),
      path.join(configDir, "plugins", "openchoreographer", "agents"),
    ]) {
      const files = fs.readdirSync(base).filter((f) => f.endsWith(".md")).sort();
      assert.equal(files.length, 11, `expected 11 agent files in ${base}`);
      assert.ok(files.includes("designer.md"), "designer.md is installed");
      assert.ok(files.includes("writer.md"), "writer.md is installed");
    }
  });
});
