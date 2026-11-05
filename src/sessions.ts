// One agent's OpenCode sessions, in the `opencode acp` process all OpenCode agents
// share. The sessions themselves live in the shared ACP client.
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

/** The one `opencode acp` every OpenCode agent's sessions open in, started in the
 * home folder when a session first needs it, and again after it exits. One
 * runtime shares one. */
export class SharedProcess {
  private ready: Promise<AcpProcess> | undefined;
  constructor(
    private readonly host: OpenCodeHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<AcpProcess> {
    if (this.ready) return this.ready;
    const ready = (async () =>
      OpenCodeProcess.start(this.host.spawn, {
        cwd: await this.host.resolveDirectory("~"),
        serve: this.serve,
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((OpenCode) => OpenCode.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it, once its running turns have had
   * a bounded time to end. One that failed to start has nothing to stop. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready
      ?.then(
        async (OpenCode) => {
          await cancelRunning(OpenCode);
          await OpenCode.kill();
        },
        () => undefined,
      )
      .catch((error: unknown) =>
        console.warn("OpenCode's process was not stopped", {
          operation: "SharedProcess.stop",
          error,
        }),
      );
  }
}

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, in the process all OpenCode agents share. */
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
