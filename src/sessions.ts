// One agent's OpenCode sessions, each conversation in an `opencode acp`
// process of its own. The sessions themselves live in the shared ACP client.
// Adapted from buzz-app src/bundled/goose/sessions.ts (Apache-2.0, see
// NOTICE), with Goose's process swapped for OpenCode's. The build puts this
// module in place of that file (vite.config.ts, SWAPS), so the Goose runtime
// keeps its exports and names; the storage key stays OpenCode's own, which
// saved conversations match on.
import {
  AgentSessions as AcpAgentSessions,
  type SessionsOptions as AcpSessionsOptions,
} from "@buzz/features/agent-harness/acp/agent-sessions";
import type { AcpProcess } from "@buzz/features/agent-harness/acp/process";
import {
  cancelRunning,
  OpenCodeProcess,
  type OpenCodeHost,
  type ServeMcp,
} from "./opencode";
import type {
  SavedConversation,
  SessionStore,
} from "@buzz/features/agent-harness/acp/agent-sessions";
import { PROMPTS_PREFIX } from "@buzz/features/agents/session-prompts";
import type { AgentStore } from "@buzz/features/agents/store";

export {
  abortable,
  absolute,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  type Launch,
  type SavedConversation,
  type SessionStore,
} from "@buzz/features/agent-harness/acp/agent-sessions";

/** A process `get()` started must have a session opened in it within this
 * long, else it is stopped: the client can give up between taking the process
 * and opening in it (the agent was removed, a pool slot never freed), and a
 * process with no session never sees one close, so nothing else stops it. */
const ADOPT_MS = 120_000;

/** The `opencode acp` processes OpenCode agents' sessions open in: one per
 * conversation, started in the home folder when the conversation first needs
 * one. The name is the Goose runtime's, which imports this class.
 *
 * One process per conversation, not one shared process, because OpenCode
 * exposes every MCP server registered in a process to every session in it,
 * and the shared ACP client registers each session's Buzz tools under the one
 * name `buzz`. In a shared process the newest session's server replaces every
 * older one's, so an older thread's turn would post through the newest
 * conversation's tools, in the wrong thread. A process of its own keeps each
 * conversation's tool calls routed to its own thread. */
export class SharedProcess {
  /** The processes started and not stopped yet, one per live conversation. */
  private readonly running = new Set<AcpProcess>();
  /** Counts the `stop` calls, so a start that one overtakes is not tracked
   * after it resolves: `stop` can only kill what is registered, and a process
   * registered after it would outlive the teardown it was meant to end. */
  private stops = 0;
  constructor(
    private readonly host: OpenCodeHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
  ) {}

  /** A process of its own for the conversation that asks, which the client
   * opens one session in. The returned process is a proxy that only adds the
   * lifecycle: the real one is stopped once its session is done. */
  async get(): Promise<AcpProcess> {
    const stops = this.stops;
    const real = await OpenCodeProcess.start(this.host.spawn, {
      cwd: await this.host.resolveDirectory("~"),
      serve: this.serve,
    });
    if (stops !== this.stops) {
      await real.kill().catch(() => undefined);
      throw new Error("OpenCode was stopped while its process started");
    }
    this.running.add(real);
    // A process that exits on its own fails its session, which closes the
    // session's tool server, so the same hook retires it as a closed session.
    let adopted = false;
    const orphan = setTimeout(() => {
      if (!adopted) this.retire(real);
    }, ADOPT_MS);
    return new Proxy(real, {
      get: (target, property) => {
        if (property !== "open") {
          const value = Reflect.get(target, property, target);
          // Methods read private state, so they run on the target, never on
          // the proxy.
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (launch: Parameters<AcpProcess["open"]>[0]) => {
          adopted = true;
          clearTimeout(orphan);
          const session = await target.open(launch);
          // The tool server closes when the client retires the session — idle
          // eviction, conversation removal, shutdown — or when the process
          // exits; either way the process has nothing left to serve.
          const done = () => this.retire(target);
          void (session.server?.closed ?? Promise.resolve()).then(done, done);
          return session;
        };
      },
    });
  }

  /** Stops every process, failing every session in them, once their running
   * turns have had a bounded time to end. */
  stop() {
    this.stops++;
    const running = [...this.running];
    this.running.clear();
    void Promise.all(
      running.map(async (real) => {
        await cancelRunning(real);
        await real.kill();
      }),
    ).catch((error: unknown) =>
      console.warn("OpenCode's processes were not stopped", {
        operation: "SharedProcess.stop",
        error,
      }),
    );
  }

  /** Stops a process whose session is done. OpenCode runs again, unasked, any
   * turn still running when its process dies, so the turns end first, bounded,
   * as in `stop`. The first call wins; a process is retired once. */
  private retire(real: AcpProcess) {
    if (!this.running.delete(real)) return;
    void (async () => {
      await cancelRunning(real);
      await real.kill();
    })().catch((error: unknown) =>
      console.warn("An OpenCode process was not stopped", {
        operation: "SharedProcess.retire",
        error,
      }),
    );
  }
}

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, each conversation in a process of its own. */
export class AgentSessions extends AcpAgentSessions {
  constructor(options: SessionsOptions) {
    super({ ...options, label: "OpenCode" });
  }
}

/** The saved-prompts key the Goose runtime names, bundled unchanged. */
const PROMPTS_GOOSE = `${PROMPTS_PREFIX}goose:`;
/** The key saved prompts have always had for this type, and that the app clears
 * when it removes an agent. */
const PROMPTS_OPENCODE = `${PROMPTS_PREFIX}opencode:`;

/** `store`, with the Goose runtime's saved-prompts key read and written as
 * OpenCode's, so saved prompts stay where they are and no migration runs. Only
 * that key changes, and the runtime keeps nothing else in this store. */
export function promptsAsOpenCode(store: AgentStore): AgentStore {
  const own = (key: string) =>
    key.startsWith(PROMPTS_GOOSE)
      ? `${PROMPTS_OPENCODE}${key.slice(PROMPTS_GOOSE.length)}`
      : key;
  return {
    keys: () => store.keys(),
    get: (key) => store.get(own(key)),
    read: (key) => store.read(own(key)),
    // Whole-prefix reads: the Goose prefix is the only one this rename touches.
    scan: async (prefix) => {
      if (!prefix.startsWith(PROMPTS_GOOSE)) return store.scan(prefix);
      const saved = await store.scan(own(prefix));
      return Object.fromEntries(
        Object.entries(saved).map(([key, value]) => [
          `${PROMPTS_GOOSE}${key.slice(PROMPTS_OPENCODE.length)}`,
          value,
        ]),
      );
    },
    set: (key, value) => store.set(own(key), value),
    add: (key, value) => store.add(own(key), value),
  };
}

/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** Conversations saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "sagmans.opencode.sessions.v1",
): SessionStore & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
} {
  const readAll = (): Record<string, Record<string, SavedConversation>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const list = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  return {
    list: () => list(readAll()[agent]),
    get: (key) => readAll()[agent]?.[key],
    set: (key, saved) => {
      const all = readAll();
      const kept = list({ ...all[agent], [key]: saved }).slice(0, SAVED_LIMIT);
      all[agent] = Object.fromEntries(kept);
      try {
        storage.setItem(name, JSON.stringify(all));
      } catch (error) {
        console.warn("OpenCode sessions were not saved", error);
      }
    },
  };
}
