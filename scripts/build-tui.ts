#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformFileAsync } from "@babel/core";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS = ["src/tui/tui.tsx", "src/tui/sidebar.tsx", "src/tui/settings-panel.tsx", "src/tui/flowing-label.tsx"];
const COMPILED = new Set(INPUTS.map((rel) => path.resolve(PACKAGE_ROOT, rel)));

function rewriteCompiledSpecifier(decl: any, state: any) {
  const source = decl?.node?.source;
  if (source == null) return;
  const specifier = source.value;
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
  const filename = state?.file?.opts?.filename;
  if (typeof filename !== "string") return;
  if (COMPILED.has(path.resolve(path.dirname(filename), specifier) + ".tsx")) source.value = specifier + ".js";
}

function relativeJsExtensionPlugin() {
  return {
    visitor: {
      ImportDeclaration(decl: any, state: any) {
        rewriteCompiledSpecifier(decl, state);
      },
      ExportNamedDeclaration(decl: any, state: any) {
        rewriteCompiledSpecifier(decl, state);
      },
    },
  };
}

export async function buildTui({ check = false } = {}) {
  const reported: string[] = [];
  for (const rel of INPUTS) {
    const input = path.resolve(PACKAGE_ROOT, rel);
    const output = input.replace(/\.tsx$/, ".js");
    const result = await transformFileAsync(input, {
      configFile: false,
      babelrc: false,
      filename: input,
      presets: [
        ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }],
        "@babel/preset-typescript",
      ],
      plugins: [relativeJsExtensionPlugin],
    });
    const code = result?.code;
    if (typeof code !== "string") throw new Error(`Babel produced no output for ${rel}`);
    const text = code.endsWith("\n") ? code : code + "\n";
    if (check) {
      let current: string | null = null;
      try {
        current = fs.readFileSync(output, "utf8");
      } catch {
        current = null;
      }
      if (current !== text) reported.push(path.relative(PACKAGE_ROOT, output));
    } else {
      fs.writeFileSync(output, text);
      reported.push(path.relative(PACKAGE_ROOT, output));
    }
  }
  return reported;
}

const invokedAsScript = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const check = process.argv.includes("--check");
  for (const file of await buildTui({ check })) console.log(`${check ? "drift" : "wrote"} ${file}`);
}