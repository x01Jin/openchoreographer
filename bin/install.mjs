#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR_NAME = "openchoreographer";
const GITHUB_REPO = "x01Jin/openchoreographer";
const PLUGIN_FILES = ["index.ts", "tui.tsx", "package.json", "README.md", "LICENSE"];

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return err instanceof Error ? err.message || String(err) : String(err);
}

/** @param {unknown} err @param {string} code @returns {boolean} */
function isErrnoCode(err, code) {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function printUsage() {
  console.log(`Usage: node bin/install.mjs [init] [options]

Install the bundled agent definitions and optionally the plugin files.

Options:
  --local      Copy plugin files into the global plugins dir, then install agents globally
  --project    Install into the current working directory (.opencode/); implies local plugin copy
  --force      Overwrite existing agent files and plugin files
  --dry-run    Print planned paths and actions; write nothing
  --no-agents  Skip agent installation
  -h, --help   Show this help

Examples:
  node bin/install.mjs
  node bin/install.mjs init
  node bin/install.mjs --local
  node bin/install.mjs --project --force`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { local: false, project: false, force: false, dryRun: false, noAgents: false, help: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "init") continue;
    else if (arg === "--local") opts.local = true;
    else if (arg === "--project") opts.project = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-agents") opts.noAgents = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--")) unknown.push(arg);
    else unknown.push(arg);
  }
  return { opts, unknown };
}

function main() {
  const { opts, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(", ")}`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    printUsage();
    return;
  }
  if (opts.local && opts.project) {
    console.error("--local and --project are mutually exclusive.");
    process.exitCode = 1;
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(scriptDir, "..");
  const bundledAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

  const isProject = opts.project;
  const copyPlugin = opts.local || opts.project;

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

  const projectRoot = process.cwd();
  const agentsTarget = isProject
    ? path.join(projectRoot, ".opencode", "agents")
    : path.join(globalConfigDir, "agents");
  const pluginTarget = isProject
    ? path.join(projectRoot, ".opencode", "plugins", PLUGIN_DIR_NAME)
    : path.join(globalConfigDir, "plugins", PLUGIN_DIR_NAME);

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
    for (const name of agentSources) {
      let st;
      try {
        st = fs.lstatSync(path.join(bundledAgentsDir, name));
      } catch (err) {
        console.error(`Failed to inspect bundled agent: ${name}\n${errorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        console.error(`Unexpected entry in agents/: ${name}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  let installedAgents = 0;
  let skippedAgents = 0;
  let installedPlugin = 0;
  let skippedPlugin = 0;

  /** @param {string} dest */
  function refuseIfSymlink(dest) {
    let st;
    try {
      st = fs.lstatSync(dest);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return false;
      console.error(`Failed to inspect destination: ${dest}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return true;
    }
    if (st.isSymbolicLink()) {
      console.error(`Refusing to overwrite symlink: ${dest}`);
      process.exitCode = 1;
      return true;
    }
    return false;
  }

  /** @param {string} file */
  function isRegularFile(file) {
    try {
      const st = fs.lstatSync(file);
      return st.isFile() && !st.isSymbolicLink();
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return false;
      console.error(`Failed to inspect destination: ${file}\n${errorMessage(err)}`);
      process.exitCode = 1;
      return false;
    }
  }

  // Agent installation
  if (!opts.noAgents) {
    if (!opts.dryRun) {
      try {
        fs.mkdirSync(agentsTarget, { recursive: true });
      } catch (err) {
        console.error(`Failed to create agents directory: ${agentsTarget}\n${errorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    } else {
      console.log(`[dry-run] mkdir -p ${agentsTarget}`);
    }
    for (const file of agentSources) {
      const src = path.join(bundledAgentsDir, file);
      const dest = path.join(agentsTarget, file);
      if (refuseIfSymlink(dest)) return;
      const exists = fs.existsSync(dest);
      if (exists && !opts.force) {
        if (!isRegularFile(dest)) {
          console.error(`Destination is not a regular file: ${dest}`);
          process.exitCode = 1;
          return;
        }
        skippedAgents++;
        console.log(`${opts.dryRun ? "[dry-run] " : ""}skip (exists): ${dest}`);
        continue;
      }
      if (opts.dryRun) {
        installedAgents++;
        console.log(`[dry-run] ${exists ? "overwrite" : "install"}: ${src} -> ${dest}`);
        continue;
      }
      try {
        if (!exists) {
          fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        } else {
          fs.copyFileSync(src, dest);
        }
        installedAgents++;
        console.log(`${exists ? "overwrote" : "installed"}: ${dest}`);
      } catch (err) {
        console.error(`Failed to copy ${src} -> ${dest}\n${errorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    }
  } else {
    console.log("Skipping agent installation (--no-agents).");
  }

  // Plugin file copy
  if (copyPlugin) {
    const pluginAgentsDir = path.join(pluginTarget, "agents");
    const pluginBinDir = path.join(pluginTarget, "bin");
    if (!opts.dryRun) {
      try {
        fs.mkdirSync(pluginTarget, { recursive: true });
        if (!opts.noAgents) {
          fs.mkdirSync(pluginAgentsDir, { recursive: true });
        }
        fs.mkdirSync(pluginBinDir, { recursive: true });
      } catch (err) {
        console.error(`Failed to create plugin directory: ${pluginTarget}\n${errorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    } else {
      console.log(`[dry-run] mkdir -p ${pluginTarget}`);
      if (!opts.noAgents) {
        console.log(`[dry-run] mkdir -p ${pluginAgentsDir}`);
      }
      console.log(`[dry-run] mkdir -p ${pluginBinDir}`);
    }
    for (const file of PLUGIN_FILES) {
      const src = path.join(packageRoot, file);
      const dest = path.join(pluginTarget, file);
      if (!fs.existsSync(src)) {
        console.error(`Package file missing: ${src}`);
        process.exitCode = 1;
        return;
      }
      if (refuseIfSymlink(dest)) return;
      const exists = fs.existsSync(dest);
      if (exists && !opts.force) {
        if (!isRegularFile(dest)) {
          console.error(`Destination is not a regular file: ${dest}`);
          process.exitCode = 1;
          return;
        }
        skippedPlugin++;
        console.log(`${opts.dryRun ? "[dry-run] " : ""}skip (exists): ${dest}`);
        continue;
      }
      if (opts.dryRun) {
        installedPlugin++;
        console.log(`[dry-run] ${exists ? "overwrite" : "install"}: ${src} -> ${dest}`);
        continue;
      }
      try {
        if (!exists) {
          fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        } else {
          fs.copyFileSync(src, dest);
        }
        installedPlugin++;
        console.log(`${exists ? "overwrote" : "installed"}: ${dest}`);
      } catch (err) {
        console.error(`Failed to copy ${src} -> ${dest}\n${errorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    }
    // Install script copy so the copied package.json bin pointer stays valid
    {
      const src = path.join(packageRoot, "bin", "install.mjs");
      const dest = path.join(pluginBinDir, "install.mjs");
      if (!fs.existsSync(src)) {
        console.error(`Package file missing: ${src}`);
        process.exitCode = 1;
        return;
      }
      if (refuseIfSymlink(dest)) return;
      const exists = fs.existsSync(dest);
      if (exists && !opts.force) {
        if (!isRegularFile(dest)) {
          console.error(`Destination is not a regular file: ${dest}`);
          process.exitCode = 1;
          return;
        }
        skippedPlugin++;
        console.log(`${opts.dryRun ? "[dry-run] " : ""}skip (exists): ${dest}`);
      } else if (opts.dryRun) {
        installedPlugin++;
        console.log(`[dry-run] ${exists ? "overwrite" : "install"}: ${src} -> ${dest}`);
      } else {
        try {
          if (!exists) {
            fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
          } else {
            fs.copyFileSync(src, dest);
          }
          installedPlugin++;
          console.log(`${exists ? "overwrote" : "installed"}: ${dest}`);
        } catch (err) {
          console.error(`Failed to copy ${src} -> ${dest}\n${errorMessage(err)}`);
          process.exitCode = 1;
          return;
        }
      }
    }
    // Bundled agents into plugin dir
    if (!opts.noAgents) {
      for (const file of agentSources) {
        const src = path.join(bundledAgentsDir, file);
        const dest = path.join(pluginAgentsDir, file);
        if (refuseIfSymlink(dest)) return;
        const exists = fs.existsSync(dest);
        if (exists && !opts.force) {
          if (!isRegularFile(dest)) {
            console.error(`Destination is not a regular file: ${dest}`);
            process.exitCode = 1;
            return;
          }
          skippedPlugin++;
          console.log(`${opts.dryRun ? "[dry-run] " : ""}skip (exists): ${dest}`);
          continue;
        }
        if (opts.dryRun) {
          installedPlugin++;
          console.log(`[dry-run] ${exists ? "overwrite" : "install"}: ${src} -> ${dest}`);
          continue;
        }
        try {
          if (!exists) {
            fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
          } else {
            fs.copyFileSync(src, dest);
          }
          installedPlugin++;
          console.log(`${exists ? "overwrote" : "installed"}: ${dest}`);
        } catch (err) {
          console.error(`Failed to copy ${src} -> ${dest}\n${errorMessage(err)}`);
          process.exitCode = 1;
          return;
        }
      }
    }
  }

  console.log("");
  if (!opts.noAgents) {
    if (opts.dryRun) {
      console.log(`[dry-run] Agents: ${installedAgents} would install, ${skippedAgents} would skip -> ${agentsTarget}`);
    } else {
      console.log(`Agents: ${installedAgents} installed, ${skippedAgents} skipped -> ${agentsTarget}`);
    }
  }
  if (copyPlugin) {
    if (opts.dryRun) {
      console.log(`[dry-run] Plugin: ${installedPlugin} would install, ${skippedPlugin} would skip -> ${pluginTarget}`);
    } else {
      console.log(`Plugin: ${installedPlugin} installed, ${skippedPlugin} skipped -> ${pluginTarget}`);
    }
  } else {
    console.log("Plugin: not copied (use --local or --project to copy it).");
  }

  console.log("");
  console.log("Next:");
  if (copyPlugin) {
    console.log("  1. Restart OpenCode; the local plugin is already in place.");
  } else {
    console.log(`  1. Install the plugin: opencode plugin add github:${GITHUB_REPO}`);
  }
  console.log("  2. Restart OpenCode (or run: opencode service restart)");
  console.log("  3. Run /orchestrate in a session");
  console.log('Optional: add "default_agent": "orchestrator" to opencode.jsonc to make the orchestrator the default.');
  console.log('Optional: assign models per agent under "agents" in opencode.jsonc.');
}

try {
  main();
} catch (err) {
  console.error(`Install failed: ${errorMessage(err)}`);
  process.exitCode = 1;
}
