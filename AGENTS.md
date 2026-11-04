# AGENTS.md

Guidance for coding agents that work in this repository.

## Project

A Buzz desktop plugin (plugin API version 1) that adds the agent type
"OpenCode". OpenCode agents run in one local `opencode acp` process and use
the Buzz tools over loopback MCP. The README describes the behavior, the
install and the security model. Keep it true when you change behavior.

| Path | Purpose |
| --- | --- |
| `manifest.json` | Plugin manifest. The `host` block is the whole native grant. |
| `src/` | Plugin source (TypeScript). Imports buzz-app modules unchanged through `@buzz/*`. |
| `src/runtime.ts`, `src/sessions.ts`, `src/run.ts`, `src/settings.ts` | Adapted from buzz-app's Goose agent type; see NOTICE. |
| `src/constants.ts` | `BUZZ_APP_REV`, the buzz-app revision the bundle is built from. |
| `scripts/build-plugin.mjs`, `scripts/link-toolchain`, `vite.config.ts` | Build: checks the clone, type-checks, bundles one `dist/plugin.js`. |
| `smoke/run.mjs` | End-to-end smoke: the built plugin, a Node host stand-in, real `opencode acp`. |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml` | Pinned packages and tools; 14-day minimum release age. |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks`, `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone.
2. Set up the build once: README, section "Build".
3. Run `scripts/check --quick` while you work, and `scripts/check` before
   you push. The full check builds the plugin and runs the smoke scenario.

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Rules

- `dist/plugin.js` must stay one ES module with no imports. React and
  Cordis come from the app (`ctx.react`); `vite.config.ts` fails the build
  on any import left in the bundle.
- Every `react` import resolves to `src/react-host.ts`. It forwards to the
  app's React after `bindReact(ctx.react)`, so the bundled buzz-app
  components share the app's hooks. The pinned `react` package must have
  the same version as the app's React; `bindReact` stops on a mismatch.
- The views bundle buzz-app components, not copies, so they look as the
  app's own agents do. The build drops their CSS: the class names are
  content hashes that the app's stylesheet of the same revision already
  has. On each new `BUZZ_APP_REV`, check the New agent dialog and the
  agent's Settings tab live in that app version.
- The manifest grant is security-relevant. `scripts/check` accepts only
  the exact grant in `MANIFEST_HOST_GRANT`. Change both together, on
  purpose, and never add network origins.
- Do not change the manifest `id` (`sagmans.opencode`), the type id
  (`opencode`) or the storage keys. Saved agents match on them.
- Import buzz-app modules unchanged. Never edit the buzz-app clone. A new
  app release goes through `BUZZ_APP_REV`, a new build, the smoke run and
  a live check in that app version.
- A package that a buzz-app module needs goes into `package.json` with an
  exact version that is at least 14 days old. Never lower the minimum
  release age.
- Keep NOTICE true: each file adapted from buzz-app names its source in a
  header comment and in NOTICE.
- The smoke scenario never reads or writes the user's OpenCode config: it
  runs OpenCode in throwaway XDG folders. Keep it so. It reads only one
  thing from the user's OpenCode data: the stored login of the smoke model's
  provider, copied read-only by SQLite. Never copy more, and never log it.
