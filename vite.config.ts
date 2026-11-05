// Bundles the plugin into one self-contained `plugin.js`, as Buzz's plugin
// scaffold does (crates/plugin-manager in buzz-app): one ES module, no
// imports, no assets, React only from `ctx.react`. Build tools and libraries
// are this repository's own (package.json, pnpm-lock.yaml); `buzz-app` is a
// local link to a buzz-app clone at the pinned revision (scripts/link-toolchain),
// so `@buzz` imports its harness modules unchanged.
// Build with scripts/build-plugin.mjs, which checks the link, the revision and
// the installed dependencies.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The markdown parser's dependency whose browser build calls `document` when
 * it loads. Its plain build decodes the same names from a table. The plugin
 * module must load without a DOM: the smoke run loads it in Node. */
const DOM_AT_LOAD = "decode-named-character-reference";
const DOM_BUILD = /index\.dom\.js$/;
const PLAIN_BUILD = "index.js";

/** Resolves DOM_AT_LOAD to its plain build. */
function plainBuildAtLoad(): Plugin {
  return {
    name: "plain-build-at-load",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source !== DOM_AT_LOAD) return null;
      const found = await this.resolve(source, importer, { ...options, skipSelf: true });
      return found && { ...found, id: found.id.replace(DOM_BUILD, PLAIN_BUILD) };
    },
  };
}

/** The buzz-app clone link that scripts/link-toolchain makes. */
const BUZZ_APP_LINK = "buzz-app";
const BUNDLE_NAME = "plugin.js";
const MANIFEST = "manifest.json";
const ICON = "icon.png";
const CSS_SUFFIX = ".css";
const ENTRY = resolve(here, "src/index.ts");
/** Imports that name a file, a builtin or a module Vite made up, not a package. */
const NOT_A_PACKAGE = /^(?:[./]|node:|\0|virtual:)/;
/** An import statement left in the emitted module (rolldown writes each at
 * the start of a line). */
const STATIC_IMPORT = /^import\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;
/** A web worker in the emitted code. Plugin API v1 has no worker asset. */
const WORKER = /\bnew Worker\(/;
/** Supplied by Buzz at run time: a copy in the bundle would be a Cordis the
 * app does not manage. React is not here: see REACT_HOST. */
const HOST_SUPPLIED = /^(?:@buzz\/author$|@deepseek-ai\/cordis(?:\/|$))/;
/** Buzz's React, bound at `apply(ctx)`: every `react` import resolves to it,
 * so bundled buzz-app components render with the React that renders them. */
const REACT_HOST = resolve(here, "src/react-host.ts");
/** The one import of the bundled React package: `src/react-host.ts` only. */
const REACT_BUNDLED = "react-bundled";
/** Parts of React packages that are safe to bundle: the JSX runtime only
 * builds element objects, and `react-dom` (not its renderers) supplies
 * `createPortal` and `flushSync`. A renderer stays an import, and
 * pluginContract fails the build. */
const REACT_BUNDLE = /^(?:react\/jsx(?:-dev)?-runtime|react-dom)$/;
/** Any other part of the React packages, such as a renderer. */
const REACT_OTHER = /^react(?:-dom)?\//;
/**
 * buzz-app modules (relative to its src/, no extension) that the bundle
 * replaces with this repository's own. The Goose runtime, its run wiring and
 * its synced settings are bundled unchanged, so OpenCode agents follow the
 * app's own turn, prompt and session rules with no copy that drifts; only
 * Goose's process adapter and its sessions module (which starts that
 * process) become OpenCode's. Each replacement exports every name the Goose
 * code imports from the original.
 */
const SWAPS: Readonly<Record<string, string>> = {
  "bundled/goose/goose": "src/opencode.ts",
  "bundled/goose/sessions": "src/sessions.ts",
  // Its web worker is a file beside the module, which Plugin API v1 cannot load.
  "features/messages/encode-webp": "src/encode-webp.ts",
};
/** TypeScript sources a swapped module may resolve to. */
const SOURCE_SUFFIX = /\.tsx?$/;

const buzzLink = resolve(here, BUZZ_APP_LINK);
const buzzSrc = resolve(buzzLink, "src");
const outDir = resolve(here, "dist");

/** True when `file` is inside `dir`. */
function inside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** Resolves the React packages before ownDependencies sees them: `react`
 * to Buzz's React (REACT_HOST), the safe parts into the bundle, any other
 * part left as an import, which pluginContract then rejects. */
function reactFromHost(): Plugin {
  return {
    name: "opencode-react-from-host",
    enforce: "pre",
    resolveId(source, importer, options) {
      if (source === "react") return REACT_HOST;
      if (source === REACT_BUNDLED) {
        if (importer !== REACT_HOST) this.error(`${REACT_BUNDLED} is for src/react-host.ts only`);
        return this.resolve("react", ENTRY, { ...options, skipSelf: true });
      }
      if (REACT_BUNDLE.test(source)) return this.resolve(source, ENTRY, { ...options, skipSelf: true });
      if (REACT_OTHER.test(source)) return { id: source, external: true };
      return null;
    },
  };
}

/**
 * A buzz-app module's package imports resolve here, not in the clone. Vite
 * resolves a module's imports from its real path, so without this the clone's
 * own node_modules would supply them, outside this lockfile and its 14-day
 * release age. A package this repository does not declare is left out as
 * an import: buzz-app modules import many packages for app code this plugin
 * never runs, which tree-shaking drops. One that the plugin does run stays
 * an import, and pluginContract stops the build (fail closed), so a new
 * dependency is added to package.json on purpose, never pulled in unseen.
 * (Adapted from buzz-plugin-tailscale-host's runner build.)
 */
function ownDependencies(): Plugin {
  let clone = "";
  return {
    name: "opencode-own-dependencies",
    enforce: "pre",
    buildStart() {
      clone = realpathSync(buzzLink);
    },
    async resolveId(source, importer, options) {
      // Left out, not bundled: a buzz-app module may import one for code
      // this plugin never runs, which tree-shaking then drops. One that is
      // still used stays an import, and pluginContract fails the build.
      if (HOST_SUPPLIED.test(source)) return { id: source, external: true };
      if (!importer || NOT_A_PACKAGE.test(source) || isAbsolute(source)) return null;
      const from = importer.split("?")[0] ?? importer;
      const base = inside(buzzLink, from) ? buzzLink : inside(clone, from) ? clone : undefined;
      if (!base) return null;
      const found = await this.resolve(source, ENTRY, { ...options, skipSelf: true });
      return found ?? { id: source, external: true };
    },
  };
}

/** Resolves each swapped buzz-app module (SWAPS) to its replacement, from
 * every importer, by the clone's link path and by its real path: Vite names
 * a module by the link (preserveSymlinks), but a package can reach the clone
 * by its real path. */
function swapModules(): Plugin {
  const swaps = new Map<string, string>();
  return {
    name: "opencode-swap-modules",
    enforce: "pre",
    buildStart() {
      swaps.clear();
      const real = resolve(realpathSync(buzzLink), "src");
      for (const [from, to] of Object.entries(SWAPS))
        for (const base of [buzzSrc, real]) swaps.set(resolve(base, from), resolve(here, to));
    },
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const found = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!found || found.external) return null;
      const target = swaps.get(found.id.split("?")[0]?.replace(SOURCE_SUFFIX, "") ?? "");
      return target && target !== importer ? target : null;
    },
  };
}

/** The installed form Buzz reads: one chunk with no imports, exporting
 * `apply`, beside its manifest. */
function pluginContract(): Plugin {
  return {
    name: "opencode-plugin-contract",
    // After Vite's CSS plugin, which adds the CSS modules of bundled buzz-app
    // components as an asset.
    generateBundle: { order: "post", handler(_options, bundle) {
      // Buzz loads no plugin CSS. Those class names are content hashes, the
      // same in Buzz's own build of the same buzz-app revision, so Buzz's
      // stylesheet already styles them. AGENTS.md says to check this live
      // on each new BUZZ_APP_REV.
      for (const [name, output] of Object.entries(bundle))
        if (output.type === "asset" && name.endsWith(CSS_SUFFIX)) delete bundle[name];
      const outputs = Object.values(bundle);
      const chunk = outputs[0];
      if (outputs.length !== 1 || chunk?.type !== "chunk")
        this.error(`Plugin API v1 needs one self-contained JS module, without assets; found ${Object.keys(bundle).join(", ")}`);
      // Fail closed: a swapped module that still made it into the bundle
      // would run Goose's own process code for OpenCode agents.
      const unswapped = Object.keys(chunk.modules).filter((id) =>
        Object.keys(SWAPS).some((from) => id.replace(SOURCE_SUFFIX, "").endsWith(`/src/${from}`)),
      );
      if (unswapped.length) this.error(`The bundle still holds swapped modules: ${unswapped.join(", ")}`);
      // The emitted code, not `chunk.imports`: that lists every left-out
      // package a bundled module named, also those tree-shaking then dropped.
      const left = [...chunk.code.matchAll(STATIC_IMPORT)].map((match) => match[1]).concat(chunk.dynamicImports);
      if (left.length)
        this.error(`The plugin still imports ${left.join(", ")}: add each to package.json with a pinned version, or stop using it (React and Cordis come from Buzz)`);
      if (WORKER.test(chunk.code)) this.error("The bundle holds a web worker, which Plugin API v1 cannot load");
      if (!chunk.exports.includes("apply")) this.error("The entry must export apply(ctx)");
      this.emitFile({ type: "asset", fileName: MANIFEST, source: readFileSync(resolve(here, MANIFEST), "utf8") });
      this.emitFile({ type: "asset", fileName: ICON, source: readFileSync(resolve(here, ICON)) });
    } },
  };
}

export default defineConfig({
  root: here,
  publicDir: false,
  // The bundled React packages (react, react-dom) pick their build by it.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [plainBuildAtLoad(), reactFromHost(), swapModules(), ownDependencies(), pluginContract()],
  // Symlinks kept: buzz-app modules keep their buzz-app/... ids, so the
  // bundle names them relative to the repository and holds no local path.
  resolve: { alias: { "@buzz": buzzSrc }, preserveSymlinks: true },
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    lib: { entry: ENTRY, formats: ["es"], fileName: () => BUNDLE_NAME },
    rolldownOptions: {
      output: { codeSplitting: false },
      // A left-out package is never loaded for its side effects alone: only
      // one whose exports the plugin uses stays an import (see above).
      treeshake: { moduleSideEffects: (_id, external) => !external },
    },
  },
});
