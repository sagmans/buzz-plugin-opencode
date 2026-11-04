#!/usr/bin/env node
// End-to-end smoke for the built plugin (dist/plugin.js) with the real
// `opencode acp`. It loads the plugin as Buzz would, through `apply(ctx)`,
// with a Node stand-in for the desktop host (process spawn, loopback MCP,
// files, commands) and for the agent and relay services. Then it mentions an
// OpenCode agent as its owner and passes only when the agent answers in the
// thread through the Buzz `send` tool, which proves the whole path: ACP
// session, Buzz tools over HTTP MCP, the agent's signed publish.
//
// OpenCode runs in throwaway XDG folders, so the owner's OpenCode config,
// sessions and MCP servers are never read or written. OpenCode's free models
// hit a usage limit after a few runs, so the default model is a paid one: its
// provider's stored login is the only thing copied from the owner's OpenCode
// data, read-only, into the throwaway folder (see seedCredential).
//
// Usage: node smoke/run.mjs [--model <provider/model[/effort]>] [--keep]
//   --model   the OpenCode model (default: SMOKE_MODEL below)
//   --keep    keep the throwaway folder for inspection; it then still holds
//             the copied login, so delete it after use
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "plugin.js");
const MANIFEST = join(ROOT, "dist", "manifest.json");
/** The owner's choice for the smoke: a model of a provider the owner has
 * logged in to. OpenCode's ACP takes `provider/model/effort` as one value. */
const SMOKE_MODEL = "zai-coding-plan/glm-5.3/max";
/** OpenCode's own provider: its free models need no login, so nothing is
 * copied for them. */
const FREE_PROVIDER = "opencode";
/** The login that `opencode auth login` stores for a provider. */
const CREDENTIAL_LABEL = "default";
/** Provider ids go into SQL text, so only this shape is accepted. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;
/** Characters that would end or change the read-only SQLite URI. */
const UNSAFE_URI_PATH = /['?#%]/;
/** Each OpenCode or sqlite3 call that prepares the login is bounded. */
const SEED_TIMEOUT_MS = 30_000;
/** The database that holds the copied login is readable by its owner only. */
const SECRET_FILE_MODE = 0o600;
/** SQLite keeps the database in these files; each may hold the login. */
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"];
/** A stop by the user (SIGINT), by the hook timeout (SIGTERM) or by a closed
 * terminal (SIGHUP) still removes the throwaway folder and its login. */
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
/** Shells report a death by signal N as 128 + N; the hook reads 143 as its
 * own timeout. */
const SIGNAL_EXIT_BASE = 128;
/** Model turns are slow and free models slower; the whole run is bounded. */
const RUN_TIMEOUT_MS = 5 * 60_000;
/** `opencode models` is bounded as the app bounds a command (5 s), with room
 * for a cold start. */
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BYTES = 262_144;
const CHANNEL = "c".repeat(8) + "-0000-4000-8000-" + "0".repeat(12);
const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const AGENT_KEY = `wss://relay.example/${AGENT}`;
const MARKER = `smoke-${randomBytes(4).toString("hex")}`;
/** A model sometimes answers in plain text or posts elsewhere instead
 * of calling `send` as asked. Such a model miss is retried in a new thread,
 * a bounded number of times; a plugin fault (OpenCode never listed the Buzz
 * tools, or a reply outside the channel) fails at once. */
const TURN_ATTEMPTS = 3;
/** Every MCP method OpenCode called, in order, for the checks above. */
const mcpCalls = [];
const EXIT_FAIL = 1;
const EXIT_USAGE = 64;

/** A smoke step that failed, with the state needed to see why. */
class SmokeError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "SmokeError";
    this.context = context;
  }
}

function parseArgs(argv) {
  const options = { model: SMOKE_MODEL, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") options.keep = true;
    else if (argv[i] === "--model" && argv[i + 1]) options.model = argv[(i += 1)];
    else {
      console.error(`usage: node smoke/run.mjs [--model <provider/model>] [--keep]`);
      process.exit(EXIT_USAGE);
    }
  }
  return options;
}

const log = (step, detail = {}) => console.log(JSON.stringify({ step, ...detail }));

/** `~/…` against the throwaway home, as the app resolves it against the real one. */
function expand(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (!isAbsolute(path)) throw new SmokeError("path must be absolute or ~/…", { path });
  return path;
}

/** The declared processes and commands, as the app reads them from the
 * manifest: the program and its fixed arguments come only from there. */
function grants() {
  const { host } = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const byId = (list) => new Map((list ?? []).map((entry) => [entry.id, entry]));
  return { processes: byId(host.processes), commands: byId(host.commands), mcp: host.mcp === true };
}

/** The desktop host as an installed plugin sees it, in Node. */
function nodeHost(home, env, servers) {
  const { processes, commands, mcp } = grants();
  const children = new Set();
  return {
    children,
    host: {
      async spawn(id, options = {}) {
        const declared = processes.get(id);
        if (!declared) throw new SmokeError("undeclared process", { id });
        // The app creates a missing working directory; so does this host.
        const cwd = expand(options.cwd ?? "~", home);
        mkdirSync(cwd, { recursive: true });
        const child = spawn(declared.program, [...(declared.args ?? []), ...(options.args ?? [])], {
          cwd,
          env: Object.fromEntries(
            Object.entries({ ...env, ...options.env }).filter(
              ([key, value]) => value !== null && !key.startsWith("BUZZ_") && !key.startsWith("NOSTR_"),
            ),
          ),
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        children.add(child);
        child.stdout.setEncoding("utf8").on("data", (data) => options.onStdout?.(data));
        child.stderr.setEncoding("utf8").on("data", (data) => options.onStderr?.(data));
        const exited = new Promise((done) => child.on("exit", (code) => done(code)));
        await new Promise((ok, fail) => {
          child.once("spawn", ok);
          child.once("error", fail);
        });
        return {
          write: (data) => new Promise((ok, fail) => child.stdin.write(data, (error) => (error ? fail(error) : ok()))),
          end: async (data) => child.stdin.end(data),
          kill: async () => {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              // Already gone.
            }
          },
          exited,
        };
      },
      async serveMcp(handler) {
        if (!mcp) throw new SmokeError("manifest does not declare host.mcp");
        const token = randomBytes(16).toString("hex");
        const server = createServer((request, response) => {
          if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(request.method === "POST" ? 401 : 405).end();
            return;
          }
          let body = "";
          request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
          request.on("end", async () => {
            try {
              const message = JSON.parse(body);
              // Which MCP calls OpenCode made, and when: a turn that never
              // listed the tools fails for another reason than one that did.
              mcpCalls.push(message.method);
              log("mcp", { method: message.method, ...(message.params?.name && { tool: message.params.name }) });
              const reply = await handler(message);
              if (reply === null || reply === undefined) response.writeHead(202).end();
              else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
            } catch (error) {
              response.writeHead(500).end(String(error));
            }
          });
        });
        await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
        servers.add(server);
        let stopped;
        const closed = new Promise((ok) => (stopped = ok));
        return {
          url: `http://127.0.0.1:${server.address().port}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
          close: async () => {
            server.close();
            stopped();
          },
          closed,
        };
      },
      async resolveDirectory(path) {
        const directory = expand(path, home);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      async readFile(path, options = {}) {
        const base = options.cwd ? expand(options.cwd, home) : home;
        return readFileSync(isAbsolute(path) || path.startsWith("~") ? expand(path, home) : join(base, path));
      },
      async runCommand(id) {
        const declared = commands.get(id);
        if (!declared) throw new SmokeError("undeclared command", { id });
        return new Promise((done) => {
          const child = spawn(declared.program, declared.args ?? [], { env, cwd: home, timeout: COMMAND_TIMEOUT_MS });
          let out = "";
          child.stdout.setEncoding("utf8").on("data", (data) => (out += data));
          child.on("exit", (code) => done(code === 0 && out.length <= (declared.maxOutputBytes ?? COMMAND_MAX_BYTES) ? out : null));
          child.on("error", () => done(null));
        });
      },
    },
  };
}

/** Memory-only Web Storage: the runtime keeps saved sessions in it. */
function memoryStorage() {
  const items = new Map();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
  };
}

/** Agent storage (`AgentStore`) in memory. */
function memoryAgentStore() {
  const items = new Map();
  return {
    keys: () => [...items.keys()],
    get: (key) => items.get(key) ?? null,
    set: async (key, value) => void (value === null ? items.delete(key) : items.set(key, value)),
    add: async (key, value) => {
      if (!items.has(key)) items.set(key, value);
      return items.get(key);
    },
  };
}

/** Loads the bundle and applies it as Buzz does; returns its agent type. */
async function loadPlugin(host, model) {
  const plugin = await import(pathToFileURL(BUNDLE).href);
  log("loaded", { inject: plugin.inject });
  let type;
  const listeners = new Set();
  const agent = {
    key: AGENT_KEY,
    pubkey: AGENT,
    name: "Smoke",
    owner: OWNER,
    type: "sagmans.opencode/opencode",
    config: { model, workspace: "~/work" },
  };
  const agents = {
    register: (registered) => (type = registered),
    snapshot: () => ({ status: "ready", running: [agent] }),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    relay: () => undefined,
    core: async () => undefined,
    tools: () => [],
    storage: memoryAgentStore(),
  };
  const effects = [];
  plugin.apply({
    react: { createElement: () => null, useState: () => [], useEffect: () => {}, useId: () => "" },
    agents,
    host,
    pluginOwner: { id: "sagmans.opencode" },
    effect: (fn) => effects.push(fn()),
  });
  if (!type) throw new SmokeError("the plugin registered no agent type");
  log("registered", { id: type.id, title: type.title });
  return { type, agent, effects };
}

/** The agent's relay handle: every publish is recorded instead of sent. */
function recordingHandle(agent, published) {
  return {
    ...agent,
    publish: async (template) => {
      const event = { ...template, id: randomBytes(32).toString("hex"), pubkey: AGENT, created_at: Math.floor(Date.now() / 1000), sig: "" };
      published.push(event);
      log("published", { kind: event.kind, content: event.content.slice(0, 200), tags: event.tags });
      return event;
    },
    query: async () => [],
    searchProfiles: async () => undefined,
    templates: () => [],
    tabs: () => undefined,
    attention: { enabled: () => false, interests: () => [] },
  };
}

/** One mention as the owner in a new thread, settled. Throws a SmokeError
 * with `retry: true` only for a model miss (see TURN_ATTEMPTS). */
async function mentionOnce(type, agent, marker) {
  const published = [];
  const root = randomBytes(32).toString("hex");
  const listedBefore = mcpCalls.filter((method) => method === "tools/list").length;
  // A free model may route the reply on its own; the prompt names the
  // tool call so that a top-level post fails only on a real routing bug.
  const event = {
    id: root,
    kind: 9,
    pubkey: OWNER,
    created_at: Math.floor(Date.now() / 1000),
    content: `@Smoke reply in this thread with one message that contains the exact text ${marker}. Call the send tool once with only the text argument: no channel and no reply, so it lands in this thread. Then stop.`,
    tags: [["h", CHANNEL], ["p", AGENT]],
    sig: "",
  };
  let done;
  await type.run({
    trigger: { type: "mention", event },
    channelId: CHANNEL,
    agent: recordingHandle(agent, published),
    config: agent.config,
    signal: new AbortController().signal,
    workingUntil: (promise) => (done = promise),
    current: () => true,
  });
  log("handed-over");
  const result = await done;
  log("settled", { result });
  // Each new session lists the tools; without that, OpenCode never had them.
  if (mcpCalls.filter((method) => method === "tools/list").length === listedBefore)
    throw new SmokeError("OpenCode did not list the Buzz tools", { mcpCalls });
  const answer = published.find((item) => item.kind === 9 && item.content.includes(marker));
  if (!answer) throw new SmokeError("the agent did not send the marker", { published: published.length, result, retry: true });
  if (!answer.tags.some(([key, value]) => key === "h" && value === CHANNEL))
    throw new SmokeError("the answer is not in the channel", { tags: answer.tags });
  if (!answer.tags.some(([key, value]) => key === "e" && value === root))
    throw new SmokeError("the answer is not in the thread", { tags: answer.tags, retry: true });
  const sessions = type.sessions.list(AGENT_KEY);
  if (!sessions.some((session) => session.root === root))
    throw new SmokeError("the thread's session is not listed", { sessions });
}

/** Passes when one of TURN_ATTEMPTS mentions gets the marker reply in its
 * thread with its session listed; see TURN_ATTEMPTS for what is retried. */
async function mentionAndCheck(type, agent) {
  for (let attempt = 1; ; attempt++) {
    try {
      await mentionOnce(type, agent, `${MARKER}-${attempt}`);
      return;
    } catch (error) {
      if (!(error instanceof SmokeError) || !error.context?.retry || attempt >= TURN_ATTEMPTS) throw error;
      log("model-miss", { attempt, of: TURN_ATTEMPTS, error: error.message });
    }
  }
}

/** The owner's OpenCode database, where `opencode auth login` keeps logins.
 * Resolved from the caller's environment, before the smoke replaces XDG. */
function ownerDatabase() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

/** Copies the one stored login that the model's provider needs into the
 * throwaway OpenCode database, so a paid model works while every other login,
 * session and setting of the owner stays out. OpenCode first creates the
 * database with its own schema (`--standalone` keeps it off the background
 * service); SQLite then copies the row, the owner's database opened
 * read-only, so the secret never passes through this process. */
function seedCredential(env, model) {
  const provider = model.split("/")[0];
  if (provider === FREE_PROVIDER) return;
  if (!PROVIDER_ID.test(provider)) throw new SmokeError("bad provider id", { model });
  const source = ownerDatabase();
  if (UNSAFE_URI_PATH.test(source)) throw new SmokeError("unsupported path for the OpenCode database", { source });
  const target = join(env.XDG_DATA_HOME, "opencode", "opencode.db");
  try {
    execFileSync("opencode", ["--standalone", "auth", "list"], { env, stdio: "ignore", timeout: SEED_TIMEOUT_MS });
    // Tighten the files before the login lands in them; SQLite gives files
    // that it creates later the mode of the database file.
    for (const suffix of DATABASE_FILE_SUFFIXES)
      if (existsSync(target + suffix)) chmodSync(target + suffix, SECRET_FILE_MODE);
    const copied = execFileSync(
      "sqlite3",
      [
        target,
        `ATTACH 'file:${source}?mode=ro' AS owner;` +
          ` INSERT INTO main.credential SELECT * FROM owner.credential` +
          ` WHERE integration_id = '${provider}' AND label = '${CREDENTIAL_LABEL}';` +
          ` SELECT changes(); DETACH owner;`,
      ],
      { timeout: SEED_TIMEOUT_MS },
    )
      .toString()
      .trim();
    if (copied !== "1")
      throw new SmokeError(`no stored login for ${provider}: run opencode auth login`, { provider, copied });
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError("cannot copy the provider login", { provider, cause: error.message });
  }
  log("login", { provider });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const work = mkdtempSync(join(tmpdir(), "opencode-smoke-"));
  const home = join(work, "home");
  mkdirSync(home);
  // OpenCode's own config, data and cache stay in the throwaway folder.
  const env = {
    ...process.env,
    HOME: homedir(),
    XDG_CONFIG_HOME: join(work, "config"),
    XDG_DATA_HOME: join(work, "data"),
    XDG_STATE_HOME: join(work, "state"),
    XDG_CACHE_HOME: join(work, "cache"),
  };
  const servers = new Set();
  const { host, children } = nodeHost(home, env, servers);
  globalThis.localStorage = memoryStorage();
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ step: "timeout", ms: RUN_TIMEOUT_MS }));
    process.exit(EXIT_FAIL);
  }, RUN_TIMEOUT_MS);
  // Every way out runs this once: the end of the run, the timeout's
  // process.exit, and a signal. Only process.exit runs "exit" handlers, so a
  // signal is turned into one.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(deadline);
    for (const child of children)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    for (const server of servers) server.close();
    if (options.keep) log("kept", { work });
    else rmSync(work, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  for (const signal of CLEANUP_SIGNALS)
    process.on(signal, () => process.exit(SIGNAL_EXIT_BASE + constants.signals[signal]));
  try {
    seedCredential(env, options.model);
    const { type, agent, effects } = await loadPlugin(host, options.model);
    const picks = await type.models(agent);
    if (!picks.models.length) throw new SmokeError("no models listed", { picks });
    log("models", { count: picks.models.length, current: picks.current });
    await mentionAndCheck(type, agent);
    log("pass", { marker: MARKER, model: options.model });
    for (const cleanup of effects) cleanup?.();
  } finally {
    cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(JSON.stringify({ step: "fail", error: error.message, context: error.context ?? {}, stack: error.stack }));
    process.exit(EXIT_FAIL);
  },
);
