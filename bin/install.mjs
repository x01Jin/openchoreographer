#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PLUGIN_DIR_NAME = "openchoreographer";
const PLUGIN_FILES = ["index.ts", "tui.tsx", "shared.ts", "fallback.ts", "rpc.ts", "settings.ts", "package.json", "README.md", "LICENSE"];
const RETIRED_AGENT_FILES = [
  "reviewer-general.md",
  "reviewer-oop.md",
  "reviewer-functional.md",
  "reviewer-procedural.md",
  "reviewer-concurrent.md",
  "reviewer-distributed.md",
  "reviewer-data.md",
  "reviewer-api.md",
  "reviewer-frontend.md",
  "reviewer-performance.md",
  "reviewer-testing.md",
];
const DEP_ARGS = ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"];
const NPM_CLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return err instanceof Error ? err.message || String(err) : String(err);
}

/** @param {unknown} err @param {string} code @returns {boolean} */
function isErrnoCode(err, code) {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

/**
 * @typedef {{ local: boolean, project: boolean, force: boolean, dryRun: boolean, noAgents: boolean, noDeps: boolean, noPlugin: boolean, prune: boolean, help: boolean, version: boolean }} InstallOpts
 * @typedef {"installed" | "overwrote" | "same" | "stale" | "skipped"} CopyStatus
 * @typedef {{ force: boolean, dryRun: boolean }} CopyOptions
 * @typedef {{ installed: number, overwrote: number, same: number, stale: number, skipped: number }} CopyCounts
 * @typedef {{ src: string, dest: string, group: "agents" | "plugin" }} CopyPlan
 */

/** @returns {CopyCounts} */
function emptyCounts() {
  return { installed: 0, overwrote: 0, same: 0, stale: 0, skipped: 0 };
}

function printUsage() {
  console.log(`Usage: node bin/install.mjs [init] [options]

Install the bundled agent definitions and optionally the plugin files.

Options:
  --local      Copy plugin files into the global plugins dir, then install agents globally
  --project    Install into the current working directory (.opencode/); implies local plugin copy
  --force      Overwrite existing files that differ
  --prune      Delete retired agent files in the target directory (requires --force)
  --dry-run    Print planned paths and actions; write nothing
  --no-agents  Skip agent installation
  --no-deps    Skip npm install in the copied plugin directory
  --no-plugin  Install only the agent definitions; skip copying plugin files
  --version    Print the installer version
  -h, --help   Show this help

Exit codes:
  0  everything installed or already current
  2  at least one file differs and needs --force (nothing written for it)
  1  error

Examples:
  node bin/install.mjs
  node bin/install.mjs --no-plugin
  node bin/install.mjs init
  node bin/install.mjs --local
  node bin/install.mjs --project --force`);
}

/**
 * @param {string[]} argv
 * @returns {{ opts: InstallOpts, unknown: string[] }}
 */
function parseArgs(argv) {
  /** @type {InstallOpts} */
  const opts = { local: false, project: false, force: false, dryRun: false, noAgents: false, noDeps: false, noPlugin: false, prune: false, help: false, version: false };
  /** @type {string[]} */
  const unknown = [];
  let args = argv;
  if (args.length > 0 && args[0] === "init") {
    args = args.slice(1);
  }
  for (const arg of args) {
    if (arg === "--local") opts.local = true;
    else if (arg === "--project") opts.project = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-agents") opts.noAgents = true;
    else if (arg === "--no-deps") opts.noDeps = true;
    else if (arg === "--no-plugin") opts.noPlugin = true;
    else if (arg === "--prune") opts.prune = true;
    else if (arg === "--version") opts.version = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else unknown.push(arg);
  }
  return { opts, unknown };
}

/**
 * @param {string} packageRoot
 * @returns {string}
 */
function readVersion(packageRoot) {
  try {
    const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
      return parsed.version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Walk a destination path and its existing ancestors for symlinks.
 * @param {string} dest
 * @returns {string | null} the offending path, or null when clean
 */
function findSymlinkInPath(dest) {
  let current = path.resolve(dest);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return current;
      }
      if (process.platform === "win32" && fs.statSync(current).isSymbolicLink()) {
        return current;
      }
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) {
        throw err;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Print one file action line, path last.
 * @param {boolean} dryRun
 * @param {CopyStatus} status
 * @param {string} dest
 * @returns {void}
 */
function printAction(dryRun, status, dest) {
  const prefix = dryRun ? "[dry-run] " : "";
  const tag = `${status}:`.padEnd(10);
  const suffix = status === "stale" ? " (use --force)" : "";
  console.log(`${prefix}${tag} ${dest}${suffix}`);
}

/**
 * Copy one file using content comparison. Never writes on dry-run or stale.
 * @param {string} src source file path
 * @param {string} dest destination file path
 * @param {CopyOptions} opts copy options
 * @returns {CopyStatus} the action taken, or planned when dry-run
 */
function copyOne(src, dest, opts) {
  const badLink = findSymlinkInPath(dest);
  if (badLink !== null) {
    throw new Error(`Refusing to write through symlink: ${badLink}`);
  }
  /** @type {Buffer} */
  const srcBuf = fs.readFileSync(src);
  let destSize = -1;
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${dest}`);
    }
    if (!destStat.isFile()) {
      throw new Error(`Destination is not a regular file: ${dest}`);
    }
    destSize = destStat.size;
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) {
      throw err;
    }
  }
  if (destSize < 0) {
    printAction(opts.dryRun, "installed", dest);
    if (!opts.dryRun) {
      fs.copyFileSync(src, dest);
    }
    return "installed";
  }
  if (destSize === srcBuf.length) {
    const destBuf = fs.readFileSync(dest);
    if (srcBuf.equals(destBuf)) {
      printAction(opts.dryRun, "same", dest);
      return "same";
    }
  }
  if (opts.force) {
    printAction(opts.dryRun, "overwrote", dest);
    if (!opts.dryRun) {
      fs.copyFileSync(src, dest);
    }
    return "overwrote";
  }
  printAction(opts.dryRun, "stale", dest);
  return "stale";
}

/**
 * @param {CopyCounts} counts
 * @param {CopyStatus} status
 * @returns {void}
 */
function tally(counts, status) {
  counts[status] += 1;
}

/**
 * @param {string} label
 * @param {string} target
 * @param {CopyCounts} counts
 * @param {boolean} dryRun
 * @param {number} [pruned] pruned count; appended when pruning ran for this target
 * @returns {void}
 */
function printSummary(label, target, counts, dryRun, pruned) {
  const prefix = dryRun ? "[dry-run] " : "";
  const prunedSuffix = pruned === undefined ? "" : `, ${pruned} pruned`;
  console.log(`${prefix}${label} -> ${target}: installed=${counts.installed} overwrote=${counts.overwrote} same=${counts.same} stale=${counts.stale} skipped=${counts.skipped}${prunedSuffix}`);
}

/**
 * Unlink retired agent files from one directory. Only names in
 * RETIRED_AGENT_FILES are ever considered; anything else is left alone.
 * Missing files are skipped silently. Symlinks and non-regular files are
 * refused without unlinking. Never touches directories.
 * @param {string} dir target directory holding agent files
 * @param {boolean} dryRun print instead of unlinking
 * @returns {{ pruned: number, errors: number }} per-file outcome counts
 */
function pruneRetiredFiles(dir, dryRun) {
  let pruned = 0;
  let errors = 0;
  for (const file of RETIRED_AGENT_FILES) {
    const full = path.join(dir, file);
    /** @type {import("node:fs").Stats | null} */
    let st = null;
    try {
      st = fs.lstatSync(full);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) {
        continue;
      }
      console.error(`Failed to inspect prune target: ${full}\n${errorMessage(err)}`);
      errors += 1;
      continue;
    }
    if (st === null || st.isSymbolicLink() || !st.isFile()) {
      console.error(`refusing to prune symlink: ${full}`);
      errors += 1;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] prune: ${full}`);
      pruned += 1;
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch (err) {
      console.error(`Failed to prune ${full}\n${errorMessage(err)}`);
      errors += 1;
      continue;
    }
    console.log(`pruned: ${full}`);
    pruned += 1;
  }
  return { pruned, errors };
}

function main() {
  const { opts, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(", ")}`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(scriptDir, "..");
  const bundledAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));
  if (opts.help) {
    printUsage();
    return;
  }
  if (opts.version) {
    console.log(readVersion(packageRoot));
    return;
  }
  if (opts.local && opts.project) {
    console.error("--local and --project are mutually exclusive.");
    process.exitCode = 1;
    return;
  }
  if (opts.prune && !opts.force) {
    console.error("--prune requires --force");
    process.exitCode = 1;
    return;
  }

  const isProject = opts.project;
  const copyPlugin = (opts.local || opts.project) && !opts.noPlugin;

  let globalConfigDir = "";
  if (!isProject) {
    const rawConfigDir = process.env.OPENCODE_CONFIG_DIR;
    if (rawConfigDir) {
      if (!path.isAbsolute(rawConfigDir)) {
        console.error(`OPENCODE_CONFIG_DIR must be an absolute path: ${rawConfigDir}`);
        process.exitCode = 1;
        return;
      }
      globalConfigDir = path.resolve(rawConfigDir);
    } else {
      globalConfigDir = path.join(os.homedir(), ".config", "opencode");
    }
  }

  const projectRoot = path.resolve(process.cwd());
  if (isProject && !opts.force) {
    const fsRoot = path.parse(projectRoot).root;
    if (projectRoot === os.homedir() || projectRoot === fsRoot) {
      console.error(`Refusing --project in ${projectRoot}: that would write .opencode/ into your home directory or filesystem root. Run from a project directory, or pass --force to proceed anyway.`);
      process.exitCode = 1;
      return;
    }
  }

  const agentsTarget = isProject
    ? path.join(projectRoot, ".opencode", "agents")
    : path.join(globalConfigDir, "agents");
  const pluginTarget = isProject
    ? path.join(projectRoot, ".opencode", "plugins", PLUGIN_DIR_NAME)
    : path.join(globalConfigDir, "plugins", PLUGIN_DIR_NAME);
  const pluginAgentsDir = path.join(pluginTarget, "agents");
  const pluginBinDir = path.join(pluginTarget, "bin");

  if (isProject) {
    console.log(`Project root: ${projectRoot}`);
  }

  /** @type {string[]} */
  let agentSources = [];
  if (!opts.noAgents) {
    try {
      agentSources = fs.readdirSync(bundledAgentsDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch (err) {
      console.error(`Failed to read bundled agents directory: ${bundledAgentsDir}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
    if (agentSources.length === 0) {
      console.error(`No .md files found in bundled agents directory: ${bundledAgentsDir}`);
      process.exitCode = 1;
      return;
    }
  }

  // Phase 1: build the full plan and validate every source before any write.
  /** @type {CopyPlan[]} */
  const plan = [];
  if (!opts.noAgents) {
    for (const file of agentSources) {
      plan.push({ src: path.join(bundledAgentsDir, file), dest: path.join(agentsTarget, file), group: "agents" });
    }
  }
  if (copyPlugin) {
    for (const file of PLUGIN_FILES) {
      plan.push({ src: path.join(packageRoot, file), dest: path.join(pluginTarget, file), group: "plugin" });
    }
    plan.push({ src: path.join(packageRoot, "bin", "install.mjs"), dest: path.join(pluginBinDir, "install.mjs"), group: "plugin" });
    if (!opts.noAgents) {
      for (const file of agentSources) {
        plan.push({ src: path.join(bundledAgentsDir, file), dest: path.join(pluginAgentsDir, file), group: "plugin" });
      }
    }
  }
  for (const entry of plan) {
    let srcStat;
    try {
      srcStat = fs.lstatSync(entry.src);
    } catch (err) {
      console.error(`Package file missing: ${entry.src}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
    if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
      console.error(`Unexpected source entry: ${entry.src}`);
      process.exitCode = 1;
      return;
    }
    let badLink = null;
    try {
      badLink = findSymlinkInPath(entry.dest);
    } catch (err) {
      console.error(`Failed to inspect destination: ${entry.dest}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
    if (badLink !== null) {
      console.error(`Refusing to write through symlink: ${badLink}`);
      process.exitCode = 1;
      return;
    }
    try {
      const destStat = fs.lstatSync(entry.dest);
      if (!destStat.isSymbolicLink() && !destStat.isFile()) {
        console.error(`Destination is not a regular file: ${entry.dest}`);
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) {
        console.error(`Failed to inspect destination: ${entry.dest}\n${errorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // Phase 2: create target directories.
  /** @type {string[]} */
  const dirsToMake = [];
  if (!opts.noAgents) {
    dirsToMake.push(agentsTarget);
  }
  if (copyPlugin) {
    dirsToMake.push(pluginTarget, pluginBinDir);
    if (!opts.noAgents) {
      dirsToMake.push(pluginAgentsDir);
    }
  }
  for (const dir of dirsToMake) {
    if (opts.dryRun) {
      console.log(`[dry-run] mkdir -p ${dir}`);
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create directory: ${dir}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  // Phases 3-6: copy in plan order (agents, plugin files, installer, plugin agents).
  const agentCounts = emptyCounts();
  const pluginCounts = emptyCounts();
  /** @type {CopyOptions} */
  const copyOpts = { force: opts.force, dryRun: opts.dryRun };
  for (const entry of plan) {
    /** @type {CopyStatus} */
    let status;
    try {
      status = copyOne(entry.src, entry.dest, copyOpts);
    } catch (err) {
      console.error(`Failed to copy ${entry.src} -> ${entry.dest}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
    tally(entry.group === "agents" ? agentCounts : pluginCounts, status);
  }
  if (opts.noAgents) {
    console.log("Skipping agent installation (--no-agents).");
  }

  // Dependency step for copied plugin dirs: the TUI imports need node_modules.
  let depsInstalled = false;
  if (copyPlugin) {
    const depCommand = `npm ${DEP_ARGS.join(" ")}`;
    if (opts.dryRun) {
      console.log(`[dry-run] ${depCommand} (cwd: ${pluginTarget})`);
    } else if (opts.noDeps) {
      console.log("Skipping npm install (--no-deps).");
    } else {
      const result = fs.existsSync(NPM_CLI)
        ? spawnSync(process.execPath, [NPM_CLI, ...DEP_ARGS], { cwd: pluginTarget, stdio: "inherit" })
        : spawnSync("npm", DEP_ARGS, { cwd: pluginTarget, stdio: "inherit", shell: process.platform === "win32" });
      if (result.error || result.status !== 0) {
        console.error(`Dependency install failed: ${depCommand} (cwd: ${pluginTarget}). The install is incomplete; fix npm and re-run.`);
        process.exitCode = 1;
        return;
      }
      depsInstalled = true;
    }
  }

  console.log("");
  /** @type {number | undefined} */
  let agentsPruned = undefined;
  /** @type {number | undefined} */
  let pluginPruned = undefined;
  if (opts.prune && !opts.noAgents) {
    const agentsResult = pruneRetiredFiles(agentsTarget, opts.dryRun);
    agentsPruned = agentsResult.pruned;
    let pruneErrors = agentsResult.errors;
    if (copyPlugin) {
      const pluginResult = pruneRetiredFiles(pluginAgentsDir, opts.dryRun);
      pluginPruned = pluginResult.pruned;
      pruneErrors += pluginResult.errors;
    }
    if (pruneErrors > 0) {
      process.exitCode = 1;
    }
  }
  if (opts.noAgents) {
    console.log("Agents: skipped (--no-agents).");
  } else {
    printSummary("Agents", agentsTarget, agentCounts, opts.dryRun, agentsPruned);
  }
  if (copyPlugin) {
    printSummary("Plugin", pluginTarget, pluginCounts, opts.dryRun, pluginPruned);
  } else if (opts.noPlugin) {
    console.log("Plugin: not copied (--no-plugin); the npm or GitHub package supplies it.");
  } else {
    console.log("Plugin: not copied (use --local or --project to copy it).");
  }

  console.log("");
  console.log("Next: Restart OpenCode to load the new agent definitions.");
  if (copyPlugin && !depsInstalled) {
    console.log(`Warning: dependencies not installed; the TUI half needs node_modules in ${pluginTarget} (run npm install there).`);
  }

  if (agentCounts.stale > 0 || pluginCounts.stale > 0) {
    if (process.exitCode !== 1) {
      process.exitCode = 2;
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`Install failed: ${errorMessage(err)}`);
  process.exitCode = 1;
}
