#!/usr/bin/env node
// End-to-end smoke for the built plugin (dist/plugin.js) with the real
// `opencode acp`. It loads the plugin as Buzz would, through `apply(ctx)`,
// with a Node stand-in for the desktop host (process spawn, loopback MCP,
// files, commands) and for the agent and relay services. Then it mentions an
// OpenCode agent as its owner and passes only when the agent answers in the
// thread through the Buzz `send` tool, which proves the whole path: ACP
// session, Buzz tools over HTTP MCP, the agent's signed publish. It also steers
// a running turn and shows that the steered text reaches the model.
//
// OpenCode runs in throwaway XDG folders, so the owner's OpenCode config,
// sessions and MCP servers are never read or written. OpenCode's free models
// hit a usage limit after a few runs, so the default model is a paid one: its
// provider's stored login is the only thing copied from the owner's OpenCode
// data, read-only, into the throwaway folder (see seedCredential).
//
// Usage: node smoke/run.mjs [--model <provider/model[/effort]>] [--keep] [--stub-only]
//   --model   the OpenCode model (default: SMOKE_MODEL below)
//   --stub-only  only what a stand-in process shows of the Activity tab's session
//             reads: no OpenCode, no login copied, no model call
//   --keep    keep the throwaway folder for inspection; it then still holds
//             the copied login, so delete it after use
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StubOpenCode } from "./stub.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "plugin.js");
const MANIFEST = join(ROOT, "dist", "manifest.json");
/** The owner's choice for the smoke: a model of a provider the owner has
 * logged in to. OpenCode's ACP takes `provider/model/effort` as one value. */
const SMOKE_MODEL = "zai-coding-plan/glm-5.3-flash/max";
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
const RUN_TIMEOUT_MS = 8 * 60_000;
/** A manifest command is bounded as the app bounds one (5 s), with room for a
 * cold start. */
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
/** Every JSON-RPC message the plugin wrote to OpenCode, in order: what a
 * setting does on the wire is what proves it. */
const written = [];
/** How many processes and commands the host started: a setup check that stands
 * starts none. */
const hostCalls = { spawns: 0, commands: 0 };
/** Where the app keeps an agent's saved session prompts, by agent type. */
const PROMPTS_KEY = (type) => `buzz.session-prompts.v1:${type}:${AGENT_KEY}`;
/** A prompt an older build of this plugin saved, in the app's stored shape. */
const SAVED_SESSION = "ses_saved_by_an_older_build";
const SAVED_PROMPT = `older-prompt-${MARKER}`;
const SAVED_PROMPTS = JSON.stringify({ version: 1, texts: [SAVED_PROMPT], sessions: [[SAVED_SESSION, [["", 0]]]] });
/** Where the plugin keeps an agent's activity record. */
const ACTIVITY_KEY = `sagmans.opencode.activity.v1:${AGENT_KEY}`;
/** A reply that shows what the transcript's Markdown must do and must not do:
 * format text, and neither load a remote image nor pass on raw HTML. */
const MARKDOWN_REPLY =
  "**bold-word** and ~~gone-word~~\n\n| head |\n| --- |\n| cell |\n\n![alt-word](https://example.com/x.png)\n\n<script>alert(1)</script>";
/** The manifest processes the plugin starts, from dist/manifest.json. */
const ACP_PROCESS = "opencode";
const STEER_PROCESS = "opencode-api";
/** Each bash call ends a model step, and a steer enters at a step boundary. Two
 * sleeps leave time for a steer to arrive in the first and enter before the
 * last step. */
const STEER_SLEEP_SECONDS = 8;
/** A turn that a failed steer falls back from needs only one tool call. */
const STEER_FAIL_SLEEP_SECONDS = 6;
/** How long a turn's first tool call and a steered turn's end may take. */
const STEER_TOOL_TIMEOUT_MS = 90_000;
/** How long private processes get to end after their stop. */
const GONE_TIMEOUT_MS = 10_000;
/** The command line of the owner's background service, which the smoke must not
 * touch. Anchored, because `pgrep -f` also matches any shell whose command text
 * holds these words. */
const OWNER_SERVICE = "^[^ ]*opencode serve --service$";
/** Session ids go into SQL text, so only this shape is accepted. */
const SESSION_ID = /^ses_[0-9A-Za-z]+$/;
/** How a server password would look in a frame or a log. The plugin never gets
 * the random value, so the smoke checks for the names and the header. */
const PASSWORD_PATTERNS = [/OPENCODE[A-Z_]*PASSWORD/, /authorization:\s*basic/i, /\bBasic [A-Za-z0-9+/]{8,}={0,2}/];
/** The processes the plugin started, with their exit codes. */
const started = [];
/** Everything OpenCode's agent process wrote, for its first tool call and for
 * what the model said. */
let agentOutput = "";
/** Everything any process wrote, and everything this run logged. */
const allOutput = [];
const logged = [];
const warned = [];
/** Makes the next steers fail as they can in real use. "refused": OpenCode gets
 * a session it does not have. "late": the steer process starts after the turn. */
const steerFault = { mode: undefined, turnEnded: undefined };
/** A session OpenCode does not have, in the shape the plugin accepts. */
const NO_SUCH_SESSION = "ses_0000000000000000000000000";
/** What the shared client sends to compact a session. */
const COMPACT_PROMPT = "/compact";
const IDLE_TIMEOUT_MS = 30_000;
const IDLE_POLL_MS = 50;
const EXIT_FAIL = 1;
/** A channel only a discovered session names. */
const OTHER_CHANNEL = "other-channel";
/** The local storage key of the plugin's session log. */
const SESSION_LOG_KEY = "sagmans.opencode.history.v1";
/** The workspace the session log names for the stand-in's sessions. */
const STUB_WORKSPACE = "~/work";
/** Longer than the record keeps a string, so seeing all of it proves the read. */
const LONG_TEXT_CHARS = 20_000;
const LONG_TEXT_END = "end-of-long-reply";
const STEER_TAG = "new-message-arrived-while-you-were-working";
/** The turns a transcript shows. */
const TURN_LIMIT = 50;
/** Past the turns a transcript shows, so that it says there are more. */
const OLD_TURNS = 60;
/** The sessions the tab reads for one conversation. */
const SESSION_READ_LIMIT = 10;
/** More old sessions than it reads. */
const OLD_SESSIONS = 12;
const EXIT_USAGE = 64;

const PLUGIN_ID = "sagmans.opencode";
/** How the bundle carries the Settings icon: one file, no asset to load. */
const ICON_DATA_URL = "data:image/png;base64,";

/** A smoke step that failed, with the state needed to see why. */
class SmokeError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "SmokeError";
    this.context = context;
  }
}

function parseArgs(argv) {
  const options = { model: SMOKE_MODEL, keep: false, stubOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") options.keep = true;
    else if (argv[i] === "--stub-only") options.stubOnly = true;
    else if (argv[i] === "--model" && argv[i + 1]) options.model = argv[(i += 1)];
    else {
      console.error(`usage: node smoke/run.mjs [--model <provider/model>] [--keep] [--stub-only]`);
      process.exit(EXIT_USAGE);
    }
  }
  return options;
}

const log = (step, detail = {}) => console.log(JSON.stringify({ step, ...detail }));
const sleep = (ms) => new Promise((settled) => setTimeout(settled, ms));
/** How often each MCP method was called, to see what one turn used. */
const counted = (calls) =>
  calls.reduce((counts, method) => {
    counts[method] = (counts[method] ?? 0) + 1;
    return counts;
  }, {});

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

/** Notes a started process and passes its output on. Returns its exit. */
function watchProcess(id, child, options) {
  const entry = { id, pid: child.pid, args: options.args ?? [], env: options.env ?? {} };
  started.push(entry);
  child.stdout.setEncoding("utf8").on("data", (data) => {
    allOutput.push(data);
    if (id === ACP_PROCESS) agentOutput += data;
    options.onStdout?.(data);
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    allOutput.push(data);
    options.onStderr?.(data);
  });
  return new Promise((done) =>
    child.on("exit", (code) => {
      entry.code = code;
      done(code);
    }),
  );
}

/** An MCP server on loopback, behind a bearer token, as the app starts one. */
async function serveLoopback(handler, mcp, servers) {
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
        if (id === STEER_PROCESS) options = await withFault(options);
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
        hostCalls.spawns += 1;
        const exited = watchProcess(id, child, options);
        await new Promise((ok, fail) => {
          child.once("spawn", ok);
          child.once("error", fail);
        });
        return {
          write: (data) => {
            for (const line of data.split("\n")) if (line.trim()) written.push(JSON.parse(line));
            return new Promise((ok, fail) => child.stdin.write(data, (error) => (error ? fail(error) : ok())));
          },
          end: async (data) => child.stdin.end(data),
          kill: async () => {
            written.push({ killed: child.pid });
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              // Already gone.
            }
          },
          exited,
        };
      },
      serveMcp: (handler) => serveLoopback(handler, mcp, servers),
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
          hostCalls.commands += 1;
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

/** Agent storage (`AgentStore`) in memory, with what an earlier run left in it. */
function memoryAgentStore(seed = {}) {
  const items = new Map(Object.entries(seed));
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
async function loadPlugin(host, model, seed) {
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
    storage: memoryAgentStore(seed),
  };
  const effects = [];
  plugin.apply({
    // The pinned React, the version Buzz runs: apply() checks it.
    react: (await import("react")).default,
    agents,
    host,
    pluginOwner: { id: "sagmans.opencode" },
    effect: (fn) => effects.push(fn()),
  });
  if (!type) throw new SmokeError("the plugin registered no agent type");
  log("registered", { id: type.id, title: type.title });
  return { type, agent, effects, storage: agents.storage };
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

/** Passes when the turn used its session's own Buzz tools: a new session lists
 * the tools, and one that runs again calls them. Without either, OpenCode
 * never had this session's own. */
function checkToolsUsed(before, reuse) {
  const after = counted(mcpCalls);
  const method = reuse ? "tools/call" : "tools/list";
  if ((after[method] ?? 0) <= (before[method] ?? 0))
    throw new SmokeError("OpenCode did not use the session's Buzz tools", { mcpCalls });
}

/** Passes when the marker answer arrived in the channel, in `root`'s thread.
 * A wrong thread can be a model miss (retry); a wrong channel is never one. */
function checkAnswer(published, marker, root, result) {
  const answer = published.find((item) => item.kind === 9 && item.content.includes(marker));
  if (!answer) throw new SmokeError("the agent did not send the marker", { published: published.length, result, retry: true });
  if (!answer.tags.some(([key, value]) => key === "h" && value === CHANNEL))
    throw new SmokeError("the answer is not in the channel", { tags: answer.tags });
  if (!answer.tags.some(([key, value]) => key === "e" && value === root))
    throw new SmokeError("the answer is not in the thread", { tags: answer.tags, retry: true });
}

/** One mention as the owner in a thread, settled. `reuse` is a thread that was
 * mentioned before, so the turn runs in the session the runtime already opened
 * for it. Throws a SmokeError with `retry: true` only for a model miss (see
 * TURN_ATTEMPTS). */
async function mentionOnce(type, agent, marker, effort, reuse) {
  const published = [];
  const root = reuse ?? randomBytes(32).toString("hex");
  const callsBefore = counted(mcpCalls);
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
    ...(effort ? { effort } : {}),
  });
  log("handed-over");
  const result = await done;
  log("settled", { result });
  checkToolsUsed(callsBefore, reuse);
  checkAnswer(published, marker, root, result);
  const sessions = type.sessions.list(AGENT_KEY);
  if (!sessions.some((session) => session.root === root))
    throw new SmokeError("the thread's session is not listed", { sessions });
  return root;
}

/** Passes when OpenCode was asked, on the wire, to run on the picked level. */
function checkEffortPick(effort) {
  const set = written.find(
    (message) =>
      message.method === "session/set_config_option" &&
      message.params?.configId === "effort" &&
      message.params?.value === effort,
  );
  if (!set) throw new SmokeError("the effort pick did not reach OpenCode", { effort });
  log("effort", { value: effort });
}

/** Passes when the thread's session compacts as the app asks it to. Compacting
 * costs one model call, and a failure rejects with OpenCode's error. */
async function checkCompact(type, agent, root) {
  const place = { channelId: CHANNEL, root };
  // The app offers Compact only once the turn has fully wound down.
  const since = Date.now();
  while (type.sessionControls.state(agent, place) !== "idle") {
    if (Date.now() - since > IDLE_TIMEOUT_MS)
      throw new SmokeError("the session did not go idle", { state: type.sessionControls.state(agent, place) });
    await new Promise((done) => setTimeout(done, IDLE_POLL_MS));
  }
  await type.sessionControls.run(agent, place, "compact");
  if (!written.some((message) => message.method === "session/prompt" && message.params?.prompt?.[0]?.text === COMPACT_PROMPT))
    throw new SmokeError("the app's compact did not reach OpenCode", { root });
  log("compact", { ok: true });
}

/** Passes when the Activity tab's data shows the smoke's turn in its thread. */
function checkActivity(type, agent, root, marker) {
  const { history } = type.tabs.find((tab) => tab.id === "activity").component;
  const row = history.find(agent.key, { channelId: CHANNEL, root });
  if (!row) throw new SmokeError("the thread's session is not on record", { recent: history.recent(agent.key) });
  if (!history.recent(agent.key).some((item) => item.sessionId === row.sessionId))
    throw new SmokeError("the session is not among the recent ones");
  const { turns } = history.transcript(agent.key, row.sessionId);
  const turn = turns.find((item) => JSON.stringify(item).includes(marker));
  if (!turn) throw new SmokeError("the transcript does not show the turn", { turns: turns.length });
  if (turn.channelId !== CHANNEL || turn.threadRootId !== root)
    throw new SmokeError("the turn is filed in the wrong place", { channelId: turn.channelId, thread: turn.threadRootId });
  if (!turn.items.some((item) => item.type === "tool"))
    throw new SmokeError("the transcript does not show the tool call", { items: turn.items.map((item) => item.type) });
  log("activity", { sessions: history.recent(agent.key).length, turns: turns.length, config: turn.config, items: turn.items.map((item) => item.type) });
  return row.sessionId;
}

/** Passes when the record in agent storage holds the turn but not the session's
 * MCP bearer token, which OpenCode's `session/new` carries. */
function checkRecordPrivate(storage, marker) {
  const record = storage.keys().filter((key) => key.includes(".activity.")).map((key) => storage.get(key)).join("");
  if (!record.includes(marker)) throw new SmokeError("the record holds no turn", { keys: storage.keys() });
  if (/bearer/i.test(record)) throw new SmokeError("the record holds an MCP credential");
  log("record", { bytes: record.length });
}

/** The view as the app would first paint it. Effects do not run here, so this
 * proves what a view draws from what it already has. */
async function painted(view, props) {
  const [{ createElement }, { renderToString }] = await Promise.all([import("react"), import("react-dom/server")]);
  // The markers React puts between text nodes are not part of what shows.
  return renderToString(createElement(view, props)).replaceAll("<!-- -->", "");
}

/** Passes when the setup check finds OpenCode ready, and the dialog and the row
 * show what it found. Runs OpenCode but no model. */
async function checkProvider(type) {
  const { provider } = type;
  const settled = provider.check();
  if (provider.snapshot().readiness !== "checking") throw new SmokeError("the check did not show it is running");
  await settled;
  const { readiness, attentionLabel } = provider.snapshot();
  const dialog = await painted(provider.DialogBody, { onClose() {} });
  const row = await painted(provider.DefaultControl, { onConfigure() {} });
  if (readiness !== "ready") throw new SmokeError("the check did not find OpenCode ready", { readiness, attentionLabel, dialog });
  const version = dialog.match(/version ([^<]+)/)?.[1];
  if (!version) throw new SmokeError("the dialog names no version", { dialog });
  if (!dialog.includes("Reachable: Yes")) throw new SmokeError("the dialog does not say OpenCode is reachable", { dialog });
  const models = Number(dialog.match(/Models: (\d+)/)?.[1]);
  if (!models) throw new SmokeError("the dialog lists no models", { dialog });
  if (!row.includes("<button")) throw new SmokeError("the row has no button", { row });
  log("provider", { readiness, version, models });
  await checkProviderStands(provider);
}

/** Passes when a good check stands as settings open again, starting no process
 * and showing no "checking" state, and "Check again" still reads afresh. */
async function checkProviderStands(provider) {
  const before = { ...hostCalls };
  await provider.check();
  if (hostCalls.spawns !== before.spawns || hostCalls.commands !== before.commands)
    throw new SmokeError("opening settings again started OpenCode", { before, after: hostCalls });
  if (provider.snapshot().readiness !== "ready") throw new SmokeError("a standing check does not show ready");
  await provider.recheck();
  if (hostCalls.commands <= before.commands || hostCalls.spawns <= before.spawns)
    throw new SmokeError("Check again did not read OpenCode afresh", { before, after: hostCalls });
  log("provider-stands", { before, after: hostCalls });
}

/** Passes when a computer with no OpenCode gets the action to take, not a
 * failure of the page. Takes its own plugin: this host has no OpenCode. */
async function checkProviderMissing(host) {
  let tried = 0;
  const { type } = await loadPlugin(
    {
      ...host,
      spawn: async () => {
        tried += 1;
        throw new Error("No such file or directory (os error 2)");
      },
      runCommand: async () => null,
    },
    "",
  );
  await type.provider.check();
  const { readiness, attentionLabel } = type.provider.snapshot();
  const dialog = await painted(type.provider.DialogBody, { onClose() {} });
  if (readiness !== "attention" || !attentionLabel?.startsWith("Install"))
    throw new SmokeError("a missing OpenCode is not reported", { readiness, attentionLabel });
  if (!dialog.includes("Installed: No")) throw new SmokeError("the dialog does not say OpenCode is missing", { dialog });
  // A problem must not stand: an install done now shows on the next open.
  const triedBefore = tried;
  await type.provider.check();
  if (tried === triedBefore) throw new SmokeError("a failed check stood instead of reading again");
  log("provider-missing", { readiness, attentionLabel });
}

/** Passes when saved prompts stay under this type's own key: one an older build
 * saved still reads through the runtime, the session just opened joins it, and
 * nothing lands under the Goose runtime's name for the key. */
function checkSavedPrompts(type, agent, storage, sessionId) {
  const { prompts } = type.tabs.find((item) => item.id === "activity").component;
  const read = prompts(agent.key);
  if (read.get(SAVED_SESSION)?.[0]?.text !== SAVED_PROMPT)
    throw new SmokeError("a prompt an older build saved does not read", { keys: storage.keys() });
  if (!read.get(sessionId)?.length) throw new SmokeError("the new session's prompt was not saved", { sessionId });
  if (storage.get(PROMPTS_KEY("goose")) !== null)
    throw new SmokeError("saved prompts landed under the Goose key", { keys: storage.keys() });
  if (!storage.get(PROMPTS_KEY("opencode"))?.includes(sessionId))
    throw new SmokeError("the new session's prompt is not under the OpenCode key", { keys: storage.keys() });
  log("saved-prompts", { sessions: JSON.parse(storage.get(PROMPTS_KEY("opencode"))).sessions.length });
}

/** Passes when a host that lacks a method the Goose runtime needs gets no agent
 * type: a type there would stop each turn with Goose's own error text. */
async function checkNoGooseError(host) {
  const { readFile: _readFile, ...partial } = host;
  try {
    await loadPlugin(partial, "");
  } catch (error) {
    if (error instanceof SmokeError && error.message.includes("no agent type")) {
      log("no-goose-error", { ok: true });
      return;
    }
    throw error;
  }
  throw new SmokeError("a host with no readFile still got the agent type");
}

/** One recorded turn with a Markdown reply, in the shape the plugin saves. */
function markdownRecord() {
  const sessionId = "ses_markdown";
  const turnId = "turn-markdown";
  const timestamp = new Date().toISOString();
  const frame = (kind, payload) => ({ turnId, kind, channelId: CHANNEL, sessionId, timestamp, agentIndex: 0, payload });
  const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: MARKDOWN_REPLY } };
  return {
    sessionId,
    value: JSON.stringify({
      version: 1,
      dropped: {},
      turns: [
        {
          id: turnId,
          sessionId,
          conversation: CHANNEL,
          channelId: CHANNEL,
          startedAt: Date.now(),
          lastAt: Date.now(),
          endedAt: Date.now(),
          frames: [
            frame("turn_started", {}),
            frame("acp_read", { method: "session/update", params: { sessionId, update } }),
            frame("turn_completed", {}),
          ],
        },
      ],
    }),
  };
}

/** Passes when a transcript lays out a reply as the app's own Activity does:
 * with the bundled Markdown packages, GitHub tables and strikethrough, no
 * remote image and no raw HTML. Takes its own plugin and a saved record, so that
 * it does not rest on how a model words a reply. */
async function checkMarkdown(host) {
  const { sessionId, value } = markdownRecord();
  const { type, agent } = await loadPlugin(host, "", { [ACTIVITY_KEY]: value });
  const { TranscriptView } = type.tabs.find((item) => item.id === "activity").component;
  const html = await painted(TranscriptView, { agent, row: { key: sessionId, sessionId, title: "", channelId: CHANNEL } });
  const wanted = ["<strong>bold-word</strong>", "<del>gone-word</del>", "<table>", "<td>cell</td>", "alt-word"];
  const missing = wanted.filter((text) => !html.includes(text));
  if (missing.length) throw new SmokeError("the transcript does not lay out Markdown", { missing, html });
  if (html.includes("<img") || html.includes("example.com/x.png")) throw new SmokeError("the transcript loads a remote image", { html });
  if (html.includes("<script")) throw new SmokeError("the transcript passes on raw HTML", { html });
  log("markdown", { checked: wanted.length });
}

/** ACP updates of a replay, as the stand-in says them. */
const userSaid = (text) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const agentSaid = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const steersIn = (turns) => turns.flatMap(({ items }) => items.filter((item) => item.steer === true));
const activityOf = (type) => type.tabs.find((tab) => tab.id === "activity").component;

/** A saved record of one ended turn for `sessionId`, whose prompt is `prompt`. */
function promptRecord(sessionId, prompt) {
  const turnId = "turn-read";
  const timestamp = new Date().toISOString();
  const frame = (kind, payload) => ({ turnId, kind, channelId: CHANNEL, sessionId, timestamp, agentIndex: 0, payload });
  const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On record." } };
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    dropped: {},
    turns: [
      {
        id: turnId,
        sessionId,
        conversation: CHANNEL,
        channelId: CHANNEL,
        startedAt: now,
        lastAt: now,
        endedAt: now,
        frames: [
          frame("turn_started", {}),
          frame("acp_write", { id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } }),
          frame("acp_read", { method: "session/update", params: { sessionId, update } }),
          frame("turn_completed", {}),
        ],
      },
    ],
  });
}

/** Puts rows in the session log, as the plugin saves them. */
function logSessions(agent, rows) {
  const log = JSON.parse(localStorage.getItem(SESSION_LOG_KEY) ?? "{}");
  log[agent] = [...(log[agent] ?? []), ...rows];
  localStorage.setItem(SESSION_LOG_KEY, JSON.stringify(log));
}

/** The tab's read of the conversation `row` is in: what it shows, and each read. */
async function tabRead({ type, agent }, row, working) {
  const { sessions } = activityOf(type);
  const from = sessions.conversation(agent.key, row);
  const reads = await sessions.read(from, working, new AbortController().signal);
  return { from, reads, shown: sessions.shown(agent.key, from, reads, working) };
}

/** The harness's words win, whole, with the record's times; a steer in a replay
 * shows as a steer, in the turn it steered; a read goes on no record and its
 * process ends. */
async function checkHarnessTurns(stub, loaded, row, prompt) {
  const longText = `${"x".repeat(LONG_TEXT_CHARS)}${LONG_TEXT_END}`;
  stub.replays.set(row.sessionId, [
    userSaid(prompt),
    agentSaid(longText),
    userSaid(`<${STEER_TAG}>\nguidance-word\n</${STEER_TAG}>`),
  ]);
  const { shown, reads } = await tabRead(loaded, row);
  if (reads.get(row.sessionId)?.status !== "read") throw new SmokeError("no read", { reads: [...reads] });
  const text = JSON.stringify(shown.turns);
  if (shown.turns.length !== 1 || !text.includes(longText)) throw new SmokeError("the replay is not what shows", { turns: shown.turns.length });
  if (steersIn(shown.turns).length !== 1) throw new SmokeError("the replay's steer does not show as one", { text });
  const [turn] = shown.turns;
  if (!turn.startedAt || !turn.endedAt) throw new SmokeError("no record times", { turn: turn.turnId });
  if (loaded.storage.keys().some((key) => String(loaded.storage.get(key)).includes(LONG_TEXT_END)))
    throw new SmokeError("a read went on the record");
  if (stub.processes.size) throw new SmokeError("a read left its process running");
}

/** A session that the harness cannot give, or that a turn runs in, shows as it is
 * on record; only a failure says so, and the running session is not read at all. */
async function checkHarnessFallback(stub, loaded, row) {
  stub.replays.set(row.sessionId, { error: "the store is locked" });
  const failing = await tabRead(loaded, row);
  if (failing.shown.failed.length !== 1 || !JSON.stringify(failing.shown.turns).includes("On record."))
    throw new SmokeError("a failed read hides the record", { failed: failing.shown.failed });
  stub.replays.delete(row.sessionId);
  const absent = await tabRead(loaded, row);
  if (absent.shown.failed.length || !absent.shown.turns.length) throw new SmokeError("an absent session", { failed: absent.shown.failed });
  const asked = stub.loads.length;
  const working = await tabRead(loaded, row, row.sessionId);
  if (stub.loads.length !== asked || !working.shown.turns.length) throw new SmokeError("the running session is read from the harness");
}

/** The log's sessions show too, and a conversation's sessions join, oldest first,
 * up to the app's limits. Saved as an earlier version of the plugin saved them. */
async function checkHarnessMerge(stub, loaded, row, prompt) {
  const old = Array.from({ length: OLD_SESSIONS }, (_, index) => ({
    sessionId: `ses_old${index}`,
    key: CHANNEL,
    at: 1000 + index,
    workspace: STUB_WORKSPACE,
  }));
  logSessions(loaded.agent.key, old);
  stub.replays.set(
    old.at(-1).sessionId,
    Array.from({ length: OLD_TURNS }, (_, index) => [userSaid(`old turn ${index}`), agentSaid(`old answer ${index}`)]).flat(),
  );
  stub.replays.set(row.sessionId, [userSaid(prompt), agentSaid("New.")]);
  const { sessions } = activityOf(loaded.type);
  if (sessions.recent(loaded.agent.key).length !== 1) throw new SmokeError("a conversation's sessions list as more than one");
  const { from, shown } = await tabRead(loaded, row);
  if (from.length !== SESSION_READ_LIMIT) throw new SmokeError("wrong sessions read", { read: from.length });
  if (shown.turns.length !== TURN_LIMIT || shown.more !== true) throw new SmokeError("wrong turns", { turns: shown.turns.length, more: shown.more });
  if (!JSON.stringify(shown.turns.at(-1)).includes("New.")) throw new SmokeError("the newest session is not last");
  if (!JSON.stringify(shown.turns).includes(`old turn ${OLD_TURNS - 1}`)) throw new SmokeError("the old session is not joined");
}

/** A listed session whose first prompt names this agent joins the list; one that
 * does not stays out and is not replayed again, and a read of it left no trace. */
async function checkHarnessDiscovery(stub, loaded) {
  const { type, agent } = loaded;
  const { sessions } = activityOf(type);
  const opening = (name) => `<context>\nAgent: ${name}\nChannel: other (#${OTHER_CHANNEL})\n</context>\n\nHello.`;
  stub.listed = [
    { sessionId: "ses_mine", updatedAt: "2026-01-02T00:00:00Z" },
    { sessionId: "ses_owner", updatedAt: "2026-01-03T00:00:00Z" },
  ];
  stub.replays.set("ses_mine", [userSaid(opening(agent.key)), agentSaid("Mine.")]);
  stub.replays.set("ses_owner", [userSaid("A question the owner asked by hand."), agentSaid("Theirs.")]);
  const signal = new AbortController().signal;
  if (!(await sessions.discover(agent.key, STUB_WORKSPACE, signal))) throw new SmokeError("no session discovered");
  if (!sessions.find(agent.key, { channelId: OTHER_CHANNEL })) throw new SmokeError("the agent's session is not listed");
  if (JSON.stringify(sessions.recent(agent.key)).includes("ses_owner")) throw new SmokeError("the owner's session is listed");
  if (localStorage.getItem(SESSION_LOG_KEY).includes("owner asked")) throw new SmokeError("the owner's words were kept");
  const asked = stub.loads.length;
  await sessions.discover(agent.key, STUB_WORKSPACE, signal);
  if (stub.loads.length !== asked) throw new SmokeError("a discovery replays sessions it already checked");
}

/** A first prompt that names its agent. */
const storedOpening = (name) =>
  `<context>\nAgent: ${name}\nChannel: other (#${OTHER_CHANNEL})\n</context>\n\nHello.`;
/** Requests of a stored session: thinking counts as output, cost stays OpenCode's. */
const storedRequest = (id, at) => ({
  id,
  type: "assistant",
  time: { created: at, completed: at + 1 },
  model: { id: "m", providerID: "p", variant: "max" },
  cost: 0.5,
  tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 20, write: 4 } },
  content: [{ type: "text", text: "dropped" }],
});
const storedSession = (id, agent, at, requests, parentID) => ({
  id,
  title: id,
  time: { created: at, updated: at + requests },
  ...(parentID ? { parentID } : {}),
  messages: [
    { id: `${id}-u`, type: "user", text: storedOpening(agent) },
    ...Array.from({ length: requests }, (_, index) =>
      storedRequest(`${id}-${index}`, at + index),
    ),
  ],
});

/** OpenCode's store gives the usage the record never saw: paged requests and child
 * sessions at every depth, others' sessions left out. It wins over the record, a
 * repeated read asks only for the list, and a failed read is said. */
async function checkStoreUsage(stub, { type, agent }, recordedId) {
  const base = 5_000_000;
  const paged = 230;
  stub.store = [
    storedSession("ses_paged", agent.key, base, paged),
    storedSession("ses_child", agent.key, base + 500, 1, "ses_paged"),
    storedSession("ses_grand", agent.key, base + 600, 1, "ses_child"),
    storedSession("ses_other", "other-agent", base, 1),
    storedSession("ses_old", agent.key, 1_000, 1),
    storedSession(recordedId, agent.key, base + 700, 1),
  ];
  const read = () =>
    type.usage(agent, { since: base - 1, signal: new AbortController().signal });
  const seen = await read();
  const main = seen.find(({ id }) => id === "ses_paged");
  if (main?.observations.length !== paged + 2 || main.gaps.length)
    throw new SmokeError("a stored session's requests", { requests: main?.observations.length, gaps: main?.gaps });
  const [first] = main.observations;
  if (first.tokens.output !== 5 || first.tokens.cacheRead !== 20 || first.cost?.usd !== 0.5 || first.model !== "p/m/max")
    throw new SmokeError("a stored request", { first });
  if (seen.some(({ id }) => ["ses_child", "ses_grand", "ses_other", "ses_old"].includes(id)))
    throw new SmokeError("usage names a child, another agent's or a too old session", { ids: seen.map(({ id }) => id) });
  const replaced = seen.filter(({ id }) => id === recordedId);
  if (replaced.length !== 1 || replaced[0].observations[0]?.requestId !== `${recordedId}-0`)
    throw new SmokeError("a recorded session's store read", { replaced });
  await checkStoreRereads(stub, read, main);
  stub.store = [];
  log("store-usage", { requests: main.observations.length, calls: "paged, then list only" });
}

/** The reads after the first: an unchanged session costs no request and keeps its
 * revision, and a failed list leaves the record, marked incomplete. */
async function checkStoreRereads(stub, read, main) {
  stub.apiCalls.length = 0;
  const again = await read();
  if (stub.apiCalls.some((path) => path.includes("/message")))
    throw new SmokeError("an unchanged session was read again", { calls: stub.apiCalls });
  if (again.find(({ id }) => id === "ses_paged")?.revision !== main.revision)
    throw new SmokeError("an unchanged session changed its revision");
  stub.apiFailure = "HTTP 500 Internal Server Error";
  const failed = await read();
  if (!failed.length || failed.some(({ gaps }) => !gaps.length))
    throw new SmokeError("a failed list over the record", { failed });
  stub.apiFailure = undefined;
}

/** What the Activity tab shows of a session OpenCode reads back. The stand-in
 * replays it; no OpenCode and no model run. */
/** A stand-in for the app's Settings row: this smoke has no DOM library, and the
 * build checks the real page's markup (ICON_SLOT_MARKS). */
function fakeIconSlot() {
  const slot = {
    attributes: new Set(),
    image: null,
    setAttribute: (name) => slot.attributes.add(name),
    removeAttribute: (name) => slot.attributes.delete(name),
    append: (image) => {
      image.parentElement = slot;
      image.remove = () => (slot.image = null);
      slot.image = image;
    },
    querySelector: (selector) => (selector.startsWith("img") ? slot.image : glyph),
  };
  const glyph = {
    parentElement: slot,
    style: {
      display: "",
      removeProperty: () => (glyph.style.display = ""),
    },
  };
  return { slot, glyph };
}

/** Passes when the plugin puts its artwork on its own Settings row, on the app's
 * tile, and stopping the plugin puts the app's generic icon back. */
async function checkSettingsIcon(host) {
  const { slot, glyph } = fakeIconSlot();
  const row = { getAttribute: () => "false", querySelector: () => glyph };
  const anchor = { closest: () => row };
  const page = globalThis.document;
  globalThis.document = {
    ...page,
    body: {},
    getElementById: (id) => (id === `plugin-description-${PLUGIN_ID}` ? anchor : null),
    createElement: () => ({ setAttribute() {}, addEventListener() {} }),
    querySelectorAll: () => (slot.image ? [slot.image] : []),
  };
  try {
    const { effects } = await loadPlugin(host, "", {});
    if (!slot.image?.src?.startsWith(ICON_DATA_URL)) throw new SmokeError("no inline icon on the row", { src: slot.image?.src?.slice(0, 32) });
    if (!slot.attributes.has("data-branded")) throw new SmokeError("the icon is not on the app's tile");
    if (glyph.style.display !== "none") throw new SmokeError("the generic icon still shows");
    for (const cleanup of effects) cleanup?.();
    if (slot.image || slot.attributes.has("data-branded") || glyph.style.display === "none")
      throw new SmokeError("the icon stayed after the plugin stopped");
  } finally {
    globalThis.document = page;
  }
  log("settings-icon", { checked: "row, tile, removal" });
}

async function checkStubHarnessRead(host) {
  const stub = new StubOpenCode();
  const sessionId = "ses_read";
  const prompt = "Please read this back.";
  const loaded = await loadPlugin({ ...host, spawn: stub.spawn }, "", { [ACTIVITY_KEY]: promptRecord(sessionId, prompt) });
  logSessions(loaded.agent.key, [{ sessionId, key: CHANNEL, at: Date.now(), workspace: STUB_WORKSPACE }]);
  const row = { sessionId, channelId: CHANNEL };
  await checkHarnessTurns(stub, loaded, row, prompt);
  await checkHarnessFallback(stub, loaded, row);
  await checkHarnessMerge(stub, loaded, row, prompt);
  await checkHarnessDiscovery(stub, loaded);
  await checkStoreUsage(stub, loaded, sessionId);
  localStorage.removeItem(SESSION_LOG_KEY);
  log("stub-read", { checked: "harness words whole, record times, steer, fallback, sessions joined, discovery" });
}

/** Real OpenCode reads the turn back: the tab shows it as OpenCode kept it.
 * `session/load` costs no model call. */
async function checkLiveRead(loaded, row, marker) {
  const { reads, shown } = await tabRead(loaded, row);
  const read = reads.get(row.sessionId);
  if (read?.status !== "read" || !read.turns.length) throw new SmokeError("OpenCode did not read it back", { read });
  if (shown.failed.length || !JSON.stringify(shown.turns).includes(marker)) throw new SmokeError("the read lacks the turn", { turns: shown.turns.length });
  log("read", { turns: read.turns.length, steers: steersIn(shown.turns).length });
}

/** Passes when the Activity tab lists the session the turn ran in. */
async function checkActivityPaint(type, agent) {
  const tab = type.tabs.find((item) => item.id === "activity").component;
  const html = await painted(tab, { agent });
  if (!html.includes("View transcript")) throw new SmokeError("the Activity tab lists no session", { html });
  log("activity-paint", { bytes: html.length });
}

/** Passes when the app's usage read reports the turn's tokens for the session,
 * with the same revision on a second read of unchanged usage. */
async function checkUsage(type, agent, sessionId, root) {
  const read = () => type.usage(agent, { since: 0, signal: new AbortController().signal });
  const session = (await read()).find((item) => item.id === sessionId);
  const seen = session?.observations[0];
  if (!seen || !(seen.tokens.input >= 0) || !(seen.tokens.output > 0))
    throw new SmokeError("usage reports no tokens for the turn", { session });
  if (session.channelId !== CHANNEL || session.root !== root)
    throw new SmokeError("usage files the session in the wrong place", { channelId: session.channelId, root: session.root });
  const again = (await read()).find((item) => item.id === sessionId);
  if (again?.revision !== session.revision) throw new SmokeError("the usage revision changed with no new usage");
  log("usage", { observations: session.observations.length, model: seen.model, tokens: seen.tokens, cost: seen.cost, revision: session.revision.slice(0, 8) });
}

/** Passes when stopping the plugin in the middle of a turn asks OpenCode to end
 * that turn before its process dies: OpenCode would run it again by itself
 * otherwise. The turn gets one thread of its own, its reply is not awaited. */
async function checkCancelOnStop(type, agent, effects) {
  const before = written.length;
  const event = {
    id: randomBytes(32).toString("hex"),
    kind: 9,
    pubkey: OWNER,
    created_at: Math.floor(Date.now() / 1000),
    content: `@Smoke write a long list of the first thousand prime numbers before you reply.`,
    tags: [["h", CHANNEL], ["p", AGENT]],
    sig: "",
  };
  let done;
  await type.run({
    trigger: { type: "mention", event },
    channelId: CHANNEL,
    agent: recordingHandle(agent, []),
    config: agent.config,
    signal: new AbortController().signal,
    workingUntil: (promise) => (done = promise),
    current: () => true,
  });
  const since = Date.now();
  const turn = () => written.slice(before).find((message) => message.method === "session/prompt");
  while (!turn()) {
    if (Date.now() - since > IDLE_TIMEOUT_MS) throw new SmokeError("the turn did not start");
    await new Promise((settled) => setTimeout(settled, IDLE_POLL_MS));
  }
  const sessionId = turn().params.sessionId;
  for (const cleanup of effects) cleanup?.();
  void Promise.resolve(done).catch(() => undefined);
  const stopping = Date.now();
  let killed = -1;
  while ((killed = written.findIndex((message, index) => index >= before && message.killed)) < 0) {
    if (Date.now() - stopping > IDLE_TIMEOUT_MS) throw new SmokeError("OpenCode's process was not stopped");
    await new Promise((settled) => setTimeout(settled, IDLE_POLL_MS));
  }
  const cancelled = written.findIndex(
    (message, index) => index >= before && message.method === "session/cancel" && message.params?.sessionId === sessionId,
  );
  if (cancelled < 0 || cancelled > killed)
    throw new SmokeError("a running turn was not cancelled before the kill", { cancelled, killed });
  log("cancel-on-stop", { waitedMs: Date.now() - stopping });
}

/** A steer process's options, after the fault that the run asks for. */
async function withFault(options) {
  const [method, path] = options.args ?? [];
  if (method !== "POST") return options;
  if (steerFault.mode === "refused")
    return { ...options, args: options.args.map((arg) => (arg === path ? `/api/session/${NO_SUCH_SESSION}/prompt` : arg)) };
  if (steerFault.mode === "late") await steerFault.turnEnded();
  return options;
}

/** The text the model produced since `offset` in OpenCode's agent output. */
function modelText(offset) {
  let text = "";
  for (const line of agentOutput.slice(offset).split("\n")) {
    if (!line.trim()) continue;
    const update = JSON.parse(line).params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" || update?.sessionUpdate === "agent_thought_chunk")
      text += update.content?.text ?? "";
  }
  return text;
}

/** One message from the owner, handed to the agent. Returns once it is handed
 * over. `settled` is inside an object because an async function that returns a
 * promise waits for it, which would hold every next message until this one's
 * work ends. */
async function ownerMessage(type, agent, published, { id, content, tags }) {
  let done;
  const event = { id, kind: 9, pubkey: OWNER, created_at: Math.floor(Date.now() / 1000), content, tags, sig: "" };
  await type.run({
    trigger: { type: "mention", event },
    channelId: CHANNEL,
    agent: recordingHandle(agent, published),
    config: agent.config,
    signal: new AbortController().signal,
    workingUntil: (promise) => (done = promise),
    current: () => true,
  });
  return { settled: done };
}

/** Throws unless the steer went through the steer process and the turn: the one
 * prompt on the wire does not hold the token, and the session's inbox is empty. */
function checkSteerPath(env, token, promptsBefore) {
  // The usage read shares this process id, and only a steer posts.
  const steers = started.filter((entry) => entry.id === STEER_PROCESS && entry.args[0] === "POST");
  if (!steers.length) throw new SmokeError("no steer process ran");
  if (steers.some((entry) => entry.code !== 0))
    throw new SmokeError("a steer process failed", { codes: steers.map((entry) => entry.code) });
  const prompts = written.slice(promptsBefore).filter((message) => message.method === "session/prompt");
  if (prompts.length !== 1) throw new SmokeError("the steer ran as its own turn", { prompts: prompts.length });
  if (JSON.stringify(prompts).includes(token)) throw new SmokeError("the steered text went as a prompt");
  const sessionId = prompts[0].params.sessionId;
  if (!SESSION_ID.test(sessionId)) throw new SmokeError("unexpected session id shape");
  const [method, path, flag, body] = steers[0].args;
  const request = JSON.parse(body);
  if (method !== "POST" || path !== `/api/session/${sessionId}/prompt` || flag !== "--data")
    throw new SmokeError("unexpected steer request", { method, path, flag });
  if (request.delivery !== "steer" || request.resume !== false)
    throw new SmokeError("the steer request can start a run", { delivery: request.delivery, resume: request.resume });
  const left = inboxLeft(env, sessionId);
  if (left !== "0") throw new SmokeError("the steer stayed in the inbox", { left });
  return { sessionId, steers: steers.length };
}

/** How many rows wait in the session's inbox in the throwaway database. */
function inboxLeft(env, sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new SmokeError("unexpected session id shape");
  const database = join(env.XDG_DATA_HOME, "opencode", "opencode.db");
  return sqlite(database, `SELECT count(*) FROM session_inbox WHERE session_id='${sessionId}';`);
}

/** Waits until OpenCode answers the first prompt written since `written`
 * index `promptsBefore`, then returns that prompt. */
async function turnEnd(promptsBefore, outputBefore, startedAt) {
  const prompt = written.slice(promptsBefore).find((message) => message.method === "session/prompt");
  while (!agentAnswered(prompt.id, outputBefore)) {
    if (Date.now() - startedAt > STEER_TOOL_TIMEOUT_MS * 2) throw new SmokeError("the turn did not end");
    await sleep(IDLE_POLL_MS);
  }
  return prompt;
}

/** Waits for the turn's first tool call since `outputBefore`, in its output. */
async function firstToolCall(outputBefore, startedAt) {
  while (!agentOutput.slice(outputBefore).includes('"sessionUpdate":"tool_call"')) {
    if (Date.now() - startedAt > STEER_TOOL_TIMEOUT_MS) throw new SmokeError("the turn called no tool");
    await sleep(IDLE_POLL_MS);
  }
}

/** Passes when a steer that cannot reach the turn runs as the next turn, once,
 * with the `mode` fault in place. */
async function checkSteerFails(type, agent, env, mode) {
  const token = `queued-${randomBytes(6).toString("hex")}`;
  const root = randomBytes(32).toString("hex");
  const promptsBefore = written.length;
  const outputBefore = agentOutput.length;
  const startedBefore = started.length;
  const since = Date.now();
  steerFault.mode = mode;
  steerFault.turnEnded = () => turnEnd(promptsBefore, outputBefore, since);
  try {
    const first = await ownerMessage(type, agent, [], {
      id: root,
      tags: [["h", CHANNEL], ["p", AGENT]],
      content: `@Smoke use the bash tool to run \`sleep ${STEER_FAIL_SLEEP_SECONDS}\`, then call the send tool once with only the text argument: done.`,
    });
    await firstToolCall(outputBefore, since);
    const published = [];
    const second = await ownerMessage(type, agent, published, {
      id: randomBytes(32).toString("hex"),
      tags: [["h", CHANNEL], ["p", AGENT], ["e", root, "", "root"], ["e", root, "", "reply"]],
      content: `@Smoke call the send tool once with only the text argument: ${token}.`,
    });
    await Promise.all([first.settled, second.settled]);
    await checkQueued(env, { mode, token, promptsBefore, startedBefore, since });
  } finally {
    steerFault.mode = undefined;
  }
}

/** The second half of `checkSteerFails`, once the work settled. */
async function checkQueued(env, { mode, token, promptsBefore, startedBefore, since }) {
  const prompts = () => written.slice(promptsBefore).filter((message) => message.method === "session/prompt");
  while (prompts().length < 2) {
    if (Date.now() - since > STEER_TOOL_TIMEOUT_MS * 2) throw new SmokeError("a failed steer did not queue", { mode });
    await sleep(IDLE_POLL_MS);
  }
  const holding = prompts().filter((message) => JSON.stringify(message).includes(token));
  if (prompts().length !== 2 || holding.length !== 1)
    throw new SmokeError("a failed steer did not run once as the next turn", { mode, prompts: prompts().length, holding: holding.length });
  const steers = started.slice(startedBefore).filter((entry) => entry.id === STEER_PROCESS);
  const codes = steers.map((entry) => `${entry.args[0]}:${entry.code}`);
  const expected = mode === "refused" ? "POST:1" : "POST:0,DELETE:0";
  if (codes.join() !== expected) throw new SmokeError("unexpected steer processes", { mode, codes });
  const left = inboxLeft(env, prompts()[0].params.sessionId);
  if (left !== "0") throw new SmokeError("a failed steer left a row", { mode, left });
  if (!warned.some((line) => line.includes("OpenCode steer failed"))) throw new SmokeError("a failed steer logged nothing", { mode });
  if (warned.some((line) => line.includes(token))) throw new SmokeError("a steer's text went to a log", { mode });
  log("steer-fails", { mode, codes, prompts: prompts().length, inboxLeft: left });
}

/** Passes when a message sent during a running turn reaches the model in that
 * turn, with no second prompt. */
async function checkSteer(type, agent, env, storage) {
  const token = `steer-${randomBytes(6).toString("hex")}`;
  const root = randomBytes(32).toString("hex");
  const published = [];
  const promptsBefore = written.length;
  const outputBefore = agentOutput.length;
  const first = await ownerMessage(type, agent, published, {
    id: root,
    tags: [["h", CHANNEL], ["p", AGENT]],
    content: `@Smoke do these steps in order. 1. Use the bash tool to run \`sleep ${STEER_SLEEP_SECONDS}\`. 2. Use the bash tool again to run \`sleep ${STEER_SLEEP_SECONDS}\`. 3. Call the send tool once with only the text argument, with a short sentence. Obey any newer instruction from me that you get while you work.`,
  });
  const since = Date.now();
  await firstToolCall(outputBefore, since);
  const second = await ownerMessage(type, agent, published, {
    id: randomBytes(32).toString("hex"),
    // A lone root is no reply (NIP-10, threadReference), so both markers.
    tags: [["h", CHANNEL], ["p", AGENT], ["e", root, "", "root"], ["e", root, "", "reply"]],
    content: `@Smoke newer instruction: the text you send with the send tool must contain the exact word ${token}.`,
  });
  // A turn that ended before the hand-over has nothing to steer: the failure
  // below then names a slow hand-over or turn, not the plugin.
  const prompt = written.slice(promptsBefore).find((message) => message.method === "session/prompt");
  log("steer-sent", { afterMs: Date.now() - since, turnAlreadyEnded: agentAnswered(prompt.id, outputBefore) });
  const results = await Promise.all([first.settled, second.settled]);
  log("steer-settled", { results });
  // The `send` that OpenCode calls can settle the work before its turn ends.
  await turnEnd(promptsBefore, outputBefore, since);
  const inReply = published.some((event) => event.content.includes(token));
  const inText = modelText(outputBefore).includes(token);
  if (!inReply && !inText) throw new SmokeError("the steered text did not reach the model", { published: published.length, results });
  const path = checkSteerPath(env, token, promptsBefore);
  const record = storage.keys().filter((key) => key.includes(".activity.")).map((key) => storage.get(key)).join("");
  if (record.includes('"delivery":"steer"')) throw new SmokeError("the record holds a steer process's output");
  // Whether OpenCode's ACP showed the steered message as the owner's: the README
  // says what the Activity tab shows of it.
  const echoed = agentOutput
    .slice(outputBefore)
    .split("\n")
    .some((line) => line.includes("user_message_chunk") && line.includes(token));
  log("steer", { ...path, inReply, inText, echoed });
  return path.sessionId;
}

/** Whether OpenCode answered the request `id`, after `offset` in its output. */
function agentAnswered(id, offset) {
  return agentOutput
    .slice(offset)
    .split("\n")
    .some((line) => line.startsWith("{") && JSON.parse(line).id === id && "result" in JSON.parse(line));
}

/** The pids of the owner's background service. */
function ownerService() {
  try {
    return execFileSync("pgrep", ["-f", OWNER_SERVICE], { encoding: "utf8", timeout: SEED_TIMEOUT_MS }).trim();
  } catch (error) {
    // pgrep exits 1 when it finds none, which is a valid result.
    if (error.status === 1) return "";
    throw new SmokeError("could not read the service pid", { cause: error.message });
  }
}

/** One value from a database, read with sqlite3. */
function sqlite(database, query) {
  return execFileSync("sqlite3", [database, query], { encoding: "utf8", timeout: SEED_TIMEOUT_MS }).trim();
}

/** Whether a process group has any member left. */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Passes when the plugin's stop left no private process, the owner's service
 * still runs as the same process and holds nothing of this run, and no server
 * password shows in a frame, a record or a log. */
async function checkStopped({ env, storage, serviceBefore, sessionId }) {
  const since = Date.now();
  while (started.some((entry) => groupAlive(entry.pid))) {
    if (Date.now() - since > GONE_TIMEOUT_MS)
      throw new SmokeError("a private process outlived its stop", {
        left: started.filter((entry) => groupAlive(entry.pid)).map((entry) => entry.id),
      });
    await sleep(IDLE_POLL_MS);
  }
  const service = ownerService();
  if (service !== serviceBefore) throw new SmokeError("the owner's service changed", { serviceBefore, service });
  const throwaway = join(env.XDG_DATA_HOME, "opencode", "opencode.db");
  // The control: the same query finds the session where it must be.
  const count = (database) => sqlite(database, `SELECT count(*) FROM session_v2 WHERE id='${sessionId}';`);
  if (count(throwaway) !== "1") throw new SmokeError("the control query found no session");
  const owner = existsSync(ownerDatabase()) ? count(`file:${ownerDatabase()}?mode=ro`) : "0";
  if (owner !== "0") throw new SmokeError("the run's session is in the owner's database");
  const frames = JSON.stringify(written) + allOutput.join("") + storage.keys().map((key) => storage.get(key)).join("");
  const seen = PASSWORD_PATTERNS.filter((pattern) => pattern.test(frames) || pattern.test(logged.join("\n")));
  if (seen.length) throw new SmokeError("a server password shows", { patterns: seen.map(String) });
  if (started.some((entry) => Object.keys(entry.env).some((key) => /PASSWORD/.test(key))))
    throw new SmokeError("the plugin passed a password to a process");
  log("stopped", { processes: started.length, servicePids: service ? service.split("\n").length : 0, ownerSession: owner });
}

/** The level to pick for a run: the one the saved `provider/model/level` rests
 * on, so that the pick stays on the level the owner chose for the smoke.
 * Throws when the saved value did not map to a model and a level. */
function pickedLevel(picks, saved) {
  const model = picks.models.find((item) => item.id === picks.current);
  const level = saved.slice(picks.current.length + 1);
  if (saved.split("/").length < 3) return undefined;
  if (!level || model?.effort !== level || !model.efforts.some((item) => item.id === level))
    throw new SmokeError("a saved provider/model/level did not map to model and level", {
      saved,
      current: picks.current,
      resting: model?.effort,
      efforts: model?.efforts.map((item) => item.id),
    });
  return level;
}

/** Passes when one of TURN_ATTEMPTS mentions gets the marker reply in its
 * thread with its session listed; see TURN_ATTEMPTS for what is retried.
 * `reuse` runs the turn in a thread that was mentioned before. */
async function mentionAndCheck(type, agent, effort, reuse) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await mentionOnce(type, agent, `${MARKER}-${attempt}`, effort, reuse);
    } catch (error) {
      if (!(error instanceof SmokeError) || !error.context?.retry || attempt >= TURN_ATTEMPTS) throw error;
      log("model-miss", { attempt, of: TURN_ATTEMPTS, error: error.message });
    }
  }
}

/** The session the record lists for a thread: the same one every turn in it
 * runs in, which is what makes a later turn's tools the ones it opened with. */
function sessionOf(type, agent, root) {
  const { history } = type.tabs.find((tab) => tab.id === "activity").component;
  return history.find(agent.key, { channelId: CHANNEL, root })?.sessionId;
}

/** Passes when a thread mentioned before another one still answers in itself,
 * in the session it already had. Every session's Buzz tools reach OpenCode as
 * one MCP server, and OpenCode holds one server per name for its whole process:
 * a name that every session shares leaves all the older ones with the newest
 * one's tools, so their sends post in its thread, not their own. */
async function checkSessionRouting(type, agent, effort, first) {
  const before = sessionOf(type, agent, first);
  if (!before) throw new SmokeError("the first thread has no session on record", { first });
  await mentionAndCheck(type, agent, effort);
  await mentionAndCheck(type, agent, effort, first);
  const after = sessionOf(type, agent, first);
  if (after !== before)
    throw new SmokeError("the thread's second turn ran in another session", { before, after });
  log("routing", { sessions: type.sessions.list(AGENT_KEY).length, first: before });
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
  for (const level of ["log", "warn", "error"]) {
    const write = console[level].bind(console);
    console[level] = (...values) => {
      const line = values.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value))).join(" ");
      logged.push(line);
      if (level !== "log") warned.push(line);
      write(...values);
    };
  }
  const serviceBefore = ownerService();
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
  // The bundled transcript's text helpers make one element when they load, as
  // browsers allow; the smoke renders nothing, so a bare element is enough.
  globalThis.document ??= { createElement: () => ({}), body: {}, getElementById: () => null, querySelectorAll: () => [] };
  // The Settings icon watches the page; here no page changes.
  globalThis.MutationObserver ??= class {
    observe() {}
    disconnect() {}
  };
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
    await checkSettingsIcon(host);
    await checkStubHarnessRead(host);
    if (options.stubOnly) return;
    seedCredential(env, options.model);
    await checkProviderMissing(host);
    await checkNoGooseError(host);
    await checkMarkdown(host);
    const { type, agent, effects, storage } = await loadPlugin(host, options.model, {
      [PROMPTS_KEY("opencode")]: SAVED_PROMPTS,
    });
    await checkProvider(type);
    const picks = await type.models(agent);
    if (!picks.models.length) throw new SmokeError("no models listed", { picks });
    log("models", { count: picks.models.length, current: picks.current });
    const effort = pickedLevel(picks, options.model);
    const root = await mentionAndCheck(type, agent, effort);
    if (effort) checkEffortPick(effort);
    await checkSessionRouting(type, agent, effort, root);
    await checkCompact(type, agent, root);
    const sessionId = checkActivity(type, agent, root, MARKER);
    await checkLiveRead({ type, agent }, { sessionId, channelId: CHANNEL, root }, MARKER);
    await checkUsage(type, agent, sessionId, root);
    checkSavedPrompts(type, agent, storage, sessionId);
    checkRecordPrivate(storage, MARKER);
    await checkActivityPaint(type, agent);
    const steered = await checkSteer(type, agent, env, storage);
    await checkLiveRead({ type, agent }, { sessionId: steered }, "");
    await checkSteerFails(type, agent, env, "refused");
    await checkSteerFails(type, agent, env, "late");
    await checkCancelOnStop(type, agent, effects);
    await checkStopped({ env, storage, serviceBefore, sessionId: steered });
    log("pass", { marker: MARKER, model: options.model });
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
