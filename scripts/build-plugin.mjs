#!/usr/bin/env node
// Type-checks and bundles the plugin with this repository's own build tools
// and libraries (package.json, pnpm-lock.yaml, installed in node_modules).
// The bundle embeds buzz-app modules from the linked clone
// (scripts/link-toolchain), so it is only built from the exact buzz-app
// revision the plugin names (BUZZ_APP_REV in src/constants.ts) with no local
// edits: the harness code in dist/plugin.js is then the code of that app
// release. The clone gives source only: the type check and the bundle read
// packages from this repository's lockfile, so the clone has no install of
// its own, and no package outside that lockfile runs or is read.
// (Adapted from buzz-plugin-tailscale-host's scripts/build-runner.mjs.)
//
// Usage: node scripts/build-plugin.mjs [--check-only]
//   --check-only    type-check only, no bundle
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE_LINK = join(ROOT, "buzz-app");
const OWN_MODULES = join(ROOT, "node_modules");
/** This repository's own tools; any other copy is outside its lockfile. */
const TOOLS = ["tsc", "vite"];
const CONSTANTS = join(ROOT, "src", "constants.ts");
const REV_PATTERN = /export const BUZZ_APP_REV = "([0-9a-f]{7,40})";/;
/** Local compiles only, but a hung tool must still end the build. */
const GIT_TIMEOUT_MS = 30_000;
const TSC_TIMEOUT_MS = 5 * 60_000;
const VITE_TIMEOUT_MS = 5 * 60_000;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

/** A build precondition or step that failed, with what to do about it. */
class BuildError extends Error {
  constructor(message, { exit = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BuildError";
    this.exit = exit;
  }
}

function parseArgs(argv) {
  const options = { checkOnly: false };
  for (const arg of argv) {
    if (arg === "--check-only") options.checkOnly = true;
    else throw new BuildError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  return options;
}

/** Runs a tool with a bounded wait; output goes straight to the terminal. */
function run(label, command, args, { cwd = ROOT, timeout, capture = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const elapsedMs = Date.now() - started;
  if (result.error) throw new BuildError(`${label} could not run (${command}, ${elapsedMs} ms)`, { cause: result.error });
  if (result.signal) throw new BuildError(`${label} stopped by ${result.signal} after ${elapsedMs} ms (limit ${timeout} ms)`);
  if (result.status !== 0)
    throw new BuildError(`${label} failed with exit ${result.status} after ${elapsedMs} ms${capture ? `: ${result.stderr.trim()}` : ""}`);
  return capture ? result.stdout.trim() : "";
}

function checkLink() {
  let isLink = false;
  try {
    isLink = lstatSync(CLONE_LINK).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (!isLink || !existsSync(CLONE_LINK))
    throw new BuildError(`${CLONE_LINK} is missing: run scripts/link-toolchain <buzz-app clone> first`, { exit: EXIT_CONFIG });
}

/** This repository's packages must be a real install from its own lockfile,
 * never a link to the clone's packages. */
function checkInstall() {
  let isDir = false;
  try {
    isDir = lstatSync(OWN_MODULES).isDirectory();
  } catch {
    isDir = false;
  }
  const missing = TOOLS.filter((name) => !existsSync(join(OWN_MODULES, ".bin", name)));
  if (!isDir || missing.length)
    throw new BuildError(`${OWN_MODULES} is not installed: run 'pnpm install --frozen-lockfile'`, { exit: EXIT_CONFIG });
}

/** The clone must be at the plugin's pinned revision with no tracked edits. */
function checkRevision() {
  const match = REV_PATTERN.exec(readFileSync(CONSTANTS, "utf8"));
  if (!match) throw new BuildError(`BUZZ_APP_REV not found in ${CONSTANTS}`, { exit: EXIT_CONFIG });
  const pinned = match[1];
  const git = (args) => run("git", "git", ["-C", CLONE_LINK, ...args], { capture: true, timeout: GIT_TIMEOUT_MS });
  const head = git(["rev-parse", "HEAD"]);
  if (!head.startsWith(pinned))
    throw new BuildError(`buzz-app clone is at ${head.slice(0, 12)}, the plugin pins ${pinned}: check out ${pinned} and reinstall`, {
      exit: EXIT_CONFIG,
    });
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new BuildError(`buzz-app clone has local edits; the bundle must hold its pinned code only:\n${dirty}`, { exit: EXIT_CONFIG });
  return pinned;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  checkLink();
  checkInstall();
  const rev = checkRevision();
  const bin = (name) => join(OWN_MODULES, ".bin", name);
  run("tsc", bin("tsc"), ["-p", join(ROOT, "tsconfig.json")], { timeout: TSC_TIMEOUT_MS });
  console.log(`typecheck ok (buzz-app ${rev.slice(0, 12)})`);
  if (options.checkOnly) return;
  // From the repository root: the bundle names each module by its path
  // relative to it (buzz-app/..., node_modules/...), so no local path leaks
  // into it.
  run("vite build", bin("vite"), ["build", "--config", join(ROOT, "vite.config.ts")], { timeout: VITE_TIMEOUT_MS });
  console.log(`bundle: ${join(ROOT, "dist", "plugin.js")}`);
}

try {
  main();
} catch (error) {
  console.error(`build-plugin: ${error.message}`);
  if (error.cause) console.error(`  cause: ${error.cause.message ?? error.cause}`);
  process.exit(error.exit ?? 1);
}
