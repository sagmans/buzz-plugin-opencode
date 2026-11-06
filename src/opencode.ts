// OpenCode on buzz-app's shared ACP client: each conversation needs its own
// `opencode acp` process to keep tool calls in its thread. These hooks add
// only the model and thinking-level picks, which OpenCode takes as session
// config options, and `OpenCodeWire` turns OpenCode's way of reporting a
// compaction into the one the shared client reads and knows which turns run,
// so they can end before the process does and can take a steer (`./steer`).
// Each session's Buzz tools reach OpenCode over loopback HTTP MCP, never a
// Buzz key (the client removes the Buzz identity from the environment).
//
// The build puts this module in place of buzz-app's
// src/bundled/goose/goose.ts (vite.config.ts, SWAPS), so the Goose runtime,
// bundled unchanged, runs OpenCode. It therefore exports every name the Goose
// modules import from that file, under the same names.
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "@buzz/features/agent-harness/acp/process";
import type {
  AcpSession,
  ConfigOptions,
} from "@buzz/features/agent-harness/acp/session";
import { errorMessage } from "@buzz/features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "@buzz/features/agent-harness/acp/types";
import { object, promptText, str, tapSpawn, type Wire, type WireTap } from "./recorder";
import { SteerChannel } from "./steer";

export {
  REQUEST_TIMEOUT_MS,
  TOOL_SERVER,
} from "@buzz/features/agent-harness/acp/process";
export { stepLabel } from "@buzz/features/agent-harness/acp/steps";
export type {
  ActivityReceipt,
  Choice,
  ServeMcp,
  Settled,
  Spawn,
  ToolServer,
} from "@buzz/features/agent-harness/acp/types";

/** Goose's names for the process and session types, which the Goose modules
 * import from the file this one replaces. */
export type GooseProcess = AcpProcess;
export type GooseSession = AcpSession;

/** The manifest process that runs `opencode acp`. */
export const PROCESS_ID = "opencode";
/** OpenCode's session config options, as `session/new` lists them. */
const MODEL_OPTION = "model";
const EFFORT_OPTION = "effort";
/** The `effort` value that clears a level. OpenCode lists it beside the
 * model's variants. */
export const DEFAULT_EFFORT = "default";

/** What the shared client sends to compact a session, and the only text it
 * takes as success (agent-sessions.ts `reset`). */
const COMPACT_PROMPT = "/compact";
const COMPACTED_TEXT = "Compaction complete";
/** Where OpenCode reports a compaction, in `session_info_update` metadata. It
 * sends no text for one unless the client declares a capability that the
 * shared client does not. */
const COMPACTION_META = "opencode/compaction";
/** Bounds what OpenCode's error can put in a message to the owner. */
const COMPACTION_ERROR_LIMIT = 500;
/** How long OpenCode gets to end its turns before its process is killed: a
 * turn that winds down in time does not run again by itself later. */
const CANCEL_WAIT_MS = 3_000;
/** A version the setup dialog shows. The answer is process output, so anything
 * else in that field is not shown. */
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const UPDATE_METHOD = "session/update";
const TEXT_CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk"]);
/** The updates that show a turn runs. OpenCode names no run on ACP, and the
 * shared client steers only a run it knows. */
const TURN_UPDATES = new Set([
  ...TEXT_CHUNKS,
  "tool_call",
  "tool_call_update",
  "plan",
]);
/** Where the wire tells the shared client which run is active, in
 * `session_info_update` metadata. */
const RUN_META = "sagmans.opencode";
/** A run id: the shared client's own prompt, so only the wire can make one. */
const RUN_PREFIX = "opencode-prompt-";

/** OpenCode refused a config option, or did not answer in time. */
export class OpenCodeConfigError extends Error {
  constructor(
    readonly sessionId: string,
    readonly configId: string,
    readonly value: string,
    cause: unknown,
  ) {
    super(
      `OpenCode could not switch its ${configId} to ${value}: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = "OpenCodeConfigError";
  }
}

/** The desktop host's `spawn` and `resolveDirectory`, which OpenCode starts with. */
export type OpenCodeHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;
/** Goose's name for it. */
export type GooseHost = OpenCodeHost;

/** What every `opencode acp` runs with. An agent turn must never stop to
 * update OpenCode itself, so its self-update is off; the owner updates
 * OpenCode as usual. */
export const ENV: Readonly<Record<string, string | null>> = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};

export const OPENCODE: AcpHooks = {
  label: "OpenCode",
  program: PROCESS_ID,
  missing:
    "OpenCode was not found. Install it (opencode.ai) and make sure `opencode` is on the PATH Buzz starts programs with.",
  // OpenCode is installed by the owner, often in a folder only a login
  // shell adds to PATH: a missing program then shows as `missing`.
  diagnoseStartup: true,
  env: ENV,
  steering: {
    // Only the wire's own update names a run. Reading no other update keeps the
    // client's step labels, which it drops for an update that names one.
    runId: (update) => {
      if (update.sessionUpdate !== "session_info_update") return null;
      const run = object(update._meta)?.[RUN_META];
      if (run === undefined) return null;
      const id = object(run)?.activeRunId;
      return typeof id === "string" ? id : undefined;
    },
    steer: async (process, sessionId, runId, text) => {
      const wire = wires.get(process);
      if (!wire) throw new Error("OpenCode's process has no wire to steer");
      await wire.steerer.steer(
        sessionId,
        runId,
        text,
        () => wire.runOf(sessionId) === runId,
      );
    },
  },
  // A model in OpenCode is `provider/model`, one config value, which also
  // takes `provider/model/variant`. An empty pick keeps what the owner's
  // OpenCode config chooses.
  select: async (opencode, session, want) => {
    const configure = async (configId: string, value: string) => {
      try {
        session.offer(
          (await opencode.request(
            "session/set_config_option",
            { sessionId: session.id, configId, value },
            REQUEST_TIMEOUT_MS,
          )) as ConfigOptions,
        );
      } catch (error) {
        throw new OpenCodeConfigError(session.id, configId, value, error);
      }
    };
    /** The session, with no level noted: a noted one makes the shared client
     * reopen the session for a turn that wants the default, and a variant
     * carried in a saved model value must not do that. */
    const unleveled = () => {
      const { effort: _effort, ...chosen } = session.chosen;
      return chosen;
    };
    if (want.model && want.model !== session.chosen.model) {
      await configure(MODEL_OPTION, want.model);
      // OpenCode keeps a level only on the same model, so it is set again.
      session.chosen = { ...unleveled(), model: want.model };
    }
    if (want.effort === DEFAULT_EFFORT) {
      await configure(EFFORT_OPTION, DEFAULT_EFFORT);
      session.chosen = unleveled();
    } else if (want.effort && want.effort !== session.chosen.effort) {
      await configure(EFFORT_OPTION, want.effort);
      session.chosen = { ...session.chosen, effort: want.effort };
    }
  },
};

/** Tracks one `opencode acp`'s prompts: which are unanswered, and how each
 * compaction the shared client asked for ended, which it tells that client.
 * Only the session of a `/compact` the client sent, and only until that
 * prompt's answer: compactions OpenCode starts on its own, and all other
 * turns, pass through untouched. */
export class OpenCodeWire implements WireTap {
  /** The version `initialize` reported, "" when it named none we can show. */
  version = "";
  /** Sessions compacting, with the id of their `/compact` prompt. */
  private readonly compacting = new Map<string, unknown>();
  /** Prompts not answered yet, by id, with their session. */
  private readonly running = new Map<unknown, string>();
  /** Each session's running turn prompt, and its run id once the turn shows. A
   * `/compact` is no turn: the client must not steer it. */
  private readonly turns = new Map<string, { id: unknown; runId?: string }>();
  private readonly idlers = new Set<() => void>();

  constructor(readonly steerer: SteerChannel) {}

  /** The run id of the session's running turn. */
  runOf(sessionId: string) {
    return this.turns.get(sessionId)?.runId;
  }

  /** The sessions with a turn running. */
  busy(): readonly string[] {
    return [...new Set(this.running.values())];
  }

  /** Resolves once every prompt is answered or the process has exited, or
   * after `timeoutMs`, whichever comes first. */
  idle(timeoutMs: number): Promise<void> {
    if (!this.running.size) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idlers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.idlers.add(done);
    });
  }

  exited() {
    this.running.clear();
    this.turns.clear();
    this.steerer.close();
    this.settle();
  }

  written(message: Wire) {
    if (message.method !== "session/prompt" || message.id === undefined) return;
    const sessionId = str(object(message.params)?.sessionId);
    this.running.set(message.id, sessionId);
    if (promptText(message) === COMPACT_PROMPT)
      this.compacting.set(sessionId, message.id);
    else this.turns.set(sessionId, { id: message.id });
  }

  private settle() {
    if (this.running.size) return;
    for (const done of [...this.idlers]) done();
  }

  /** Names the run at a turn's first update. */
  private turnShown(sessionId: string, kind: string, message: Wire) {
    const turn = this.turns.get(sessionId);
    if (!turn || turn.runId || !TURN_UPDATES.has(kind)) return undefined;
    turn.runId = `${RUN_PREFIX}${String(turn.id)}`;
    return [runUpdate(sessionId, turn.runId), message];
  }

  /** Clears the run before the prompt's answer, so that the client never steers
   * a turn that ended. */
  private turnEnded(message: Wire) {
    for (const [sessionId, turn] of this.turns) {
      if (turn.id !== message.id) continue;
      this.turns.delete(sessionId);
      return turn.runId ? [runUpdate(sessionId, null), message] : undefined;
    }
    return undefined;
  }

  read(message: Wire): readonly Wire[] | undefined {
    if (message.method === undefined) {
      const version = str(object(object(message.result)?.agentInfo)?.version);
      if (VERSION_SHAPE.test(version)) this.version = version;
      for (const [sessionId, id] of this.compacting)
        if (id === message.id) this.compacting.delete(sessionId);
      if (this.running.delete(message.id)) this.settle();
      return this.turnEnded(message);
    }
    if (message.method !== UPDATE_METHOD) return undefined;
    const params = object(message.params);
    const sessionId = str(params?.sessionId);
    const update = object(params?.update);
    const kind = str(update?.sessionUpdate);
    if (!this.compacting.has(sessionId))
      return this.turnShown(sessionId, kind, message);
    // Any text beside the result would fail the client's exact match.
    if (TEXT_CHUNKS.has(kind)) return [];
    const compaction = object(object(update?._meta)?.[COMPACTION_META]);
    const status = str(compaction?.status);
    if (status === "completed")
      return [message, textChunk(sessionId, COMPACTED_TEXT)];
    if (status !== "failed") return undefined;
    const reason = str(object(compaction?.error)?.message);
    return [
      message,
      textChunk(
        sessionId,
        `OpenCode could not compact the session${
          reason ? `: ${reason.slice(0, COMPACTION_ERROR_LIMIT)}` : ""
        }`,
      ),
    ];
  }
}

/** A `session/update` that gives the client `text` as the turn's reply. */
const textChunk = (sessionId: string, text: string): Wire => ({
  jsonrpc: "2.0",
  method: UPDATE_METHOD,
  params: {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  },
});

/** A `session/update` that tells the client which run is active, if any. */
const runUpdate = (sessionId: string, activeRunId: string | null): Wire => ({
  jsonrpc: "2.0",
  method: UPDATE_METHOD,
  params: {
    sessionId,
    update: {
      sessionUpdate: "session_info_update",
      _meta: { [RUN_META]: { activeRunId } },
    },
  },
});

/** Starts `opencode acp` and checks it can reach the Buzz tools. */
export const OpenCodeProcess = {
  start: async (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ) => {
    const steerer = new SteerChannel(spawn);
    const wire = new OpenCodeWire(steerer);
    const started = await AcpProcess.start(
      tapSpawn(
        (id, options) => {
          if (options) steerer.launchedWith(options);
          return spawn(id, options);
        },
        () => wire,
      ),
      OPENCODE,
      launch,
    );
    wires.set(started, wire);
    return started;
  },
};

/** Each process's wire. A map, as the shared client makes the process. */
const wires = new WeakMap<AcpProcess, OpenCodeWire>();

/** The version `opencode` reported when it started, "" when it named none. */
export const reportedVersion = (opencode: AcpProcess) =>
  wires.get(opencode)?.version ?? "";

/** Asks OpenCode to end every running turn, and waits a bounded time for it.
 * OpenCode runs again, unasked, any turn still running when its process dies,
 * the next time its server starts. A turn it was told to cancel stays ended. */
export async function cancelRunning(
  opencode: AcpProcess,
  timeoutMs = CANCEL_WAIT_MS,
) {
  const wire = wires.get(opencode);
  if (!wire) return;
  for (const sessionId of wire.busy())
    opencode.notify("session/cancel", { sessionId });
  await wire.idle(timeoutMs);
}
/** Goose's name for it, as the Goose modules import it. */
export const GooseProcess = OpenCodeProcess;
