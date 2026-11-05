// A stand-in for `opencode acp` that answers the requests a session read makes, in
// this process, for what the real one cannot show on demand: a read that fails, a
// session it no longer has, and sessions listed from before the plugin's log. No
// model runs and nothing is sent anywhere.

const INTERNAL_ERROR = -32603;
const NO_METHOD = -32601;

export class StubOpenCode {
  /** What `session/load` replays, per session: ACP updates, or `{ error }` for a
   * read that fails. A session not here is one OpenCode no longer has. */
  replays = new Map();
  /** What `session/list` names: `{ sessionId, updatedAt }`. */
  listed = [];
  /** Every session a `session/load` asked for. */
  loads = [];
  /** Each running process's way to end. */
  processes = new Set();
  /** What the API process knows: session rows, each with `messages`. */
  store = [];
  /** Each path the API process was asked for. */
  apiCalls = [];
  /** When set, what the API process fails with, on stderr. */
  apiFailure = undefined;

  /** One `opencode --standalone api GET <path>`, paged as OpenCode pages. */
  answerApi([method, path], options) {
    this.apiCalls.push(path);
    if (this.apiFailure || method !== "GET") {
      options.onStderr?.(this.apiFailure ?? "HTTP 405 Method Not Allowed");
      return 1;
    }
    const url = new URL(path, "http://stub");
    if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
      options.onStderr?.("HTTP 400 Bad Request");
      return 1;
    }
    const limit = Number(url.searchParams.get("limit"));
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const match = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    const session = match && this.store.find((row) => row.id === match[1]);
    if (match && !session) {
      options.onStderr?.("HTTP 404 Not Found");
      return 1;
    }
    const all = match
      ? session.messages.filter(({ type }) => type === url.searchParams.get("type"))
      : this.store.map(({ messages, ...row }) => row);
    const page = all.slice(from, from + limit);
    const next = from + limit < all.length ? String(from + limit) : null;
    options.onStdout?.(JSON.stringify({ data: page, cursor: { previous: null, next } }));
    return 0;
  }

  spawn = async (id, options = {}) => {
    if (id === "opencode-api") {
      const code = this.answerApi(options.args ?? [], options);
      return { write: async () => {}, end: async () => {}, kill: async () => {}, exited: Promise.resolve(code) };
    }
    let finish;
    const exited = new Promise((done) => {
      finish = done;
    });
    const end = () => {
      this.processes.delete(end);
      finish(0);
    };
    this.processes.add(end);
    const out = (message) =>
      setImmediate(() => options.onStdout?.(`${JSON.stringify(message)}\n`));
    return {
      write: async (data) => {
        for (const line of String(data).split("\n"))
          if (line.trim()) this.handle(JSON.parse(line), out);
      },
      end: async () => end(),
      kill: async () => end(),
      exited,
    };
  };

  handle({ id, method, params }, out) {
    if (!method || id === undefined) return;
    const answer = (result) => out({ jsonrpc: "2.0", id, result });
    const refuse = (code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize")
      answer({
        protocolVersion: 1,
        agentInfo: { name: "OpenCode", version: "9.9.9+stub" },
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      });
    else if (method === "session/list") answer({ sessions: this.listed });
    else if (method === "session/load") {
      const { sessionId } = params;
      this.loads.push(sessionId);
      const replay = this.replays.get(sessionId);
      if (!replay) refuse(INTERNAL_ERROR, `Session not found: ${sessionId}`);
      else if (replay.error) refuse(INTERNAL_ERROR, replay.error);
      else {
        for (const update of replay)
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
        answer({});
      }
    } else refuse(NO_METHOD, `No ${method}`);
  }
}
