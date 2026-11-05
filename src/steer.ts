// Steers a running OpenCode turn: a message the owner sends while the turn runs
// reaches the model at its next step, not after the turn.
//
// OpenCode's ACP has no steer, only its HTTP API has (`delivery: "steer"`). The
// app's plugin host gives a plugin no loopback HTTP, and `opencode acp` has no
// `--server` flag and does not name its private server. So each steer is one
// short `opencode --standalone api` process: it starts a second private server
// on the same database, writes the steer to the session's inbox, and exits. The
// server that runs the turn reads the inbox at each step boundary. No port stays
// open, and the plugin never makes or holds a server password.
//
// OpenCode does not promise that two servers can share a session. The database
// writes are transactions and the smoke run proves one steer end to end, on the
// tested version (README, "Limits"). A failed steer throws, so the shared client
// runs the message as the next turn: the message is never lost.
import type { Spawn } from "@buzz/features/agent-harness/acp/types";
import type {
  HostProcess,
  HostProcessOptions,
} from "@buzz/features/host/service";
import { object, str } from "./recorder";

/** The manifest process that runs `opencode --standalone api`. `--standalone`
 * is fixed in the manifest, and OpenCode refuses it beside `--server`, so the
 * plugin cannot point this process at the owner's service or another server. */
export const STEER_PROCESS_ID = "opencode-api";
/** A one-shot takes under a second on a warm start. Longer than this is a stuck
 * process, and the message must not wait for it. */
const STEER_TIMEOUT_MS = 30_000;
/** The body goes in one argument, because OpenCode's `--data` reads no stdin.
 * A single argument on Linux is limited to 128 KiB. A longer message queues. */
const STEER_BODY_LIMIT_BYTES = 100_000;
/** Holds the inbox row that OpenCode echoes, which includes the message. */
const ANSWER_LIMIT_CHARS = 2 * STEER_BODY_LIMIT_BYTES;
/** The ids go into a request path, and they come from process output. */
const ID_SHAPE = /^[a-z]{2,8}_[0-9A-Za-z]{1,128}$/;
/** The status line OpenCode writes on stderr for a refused request. */
const HTTP_STATUS = /^HTTP (\d{3})\b/m;
/** The answer for an inbox row that OpenCode already gave to the model. */
const GONE_STATUS = "404";

/** The stages of one steer, for its error and log. */
type SteerStage = "validate" | "admit" | "withdraw";

/** What is safe to log about a steer: never the text, which is private chat. */
type SteerContext = Readonly<{
  operation: SteerStage;
  sessionId: string;
  runId: string;
  reason: string;
  exitCode?: number | null | undefined;
  httpStatus?: string;
  elapsedMs: number;
}>;

/** A steer did not reach the running turn. The shared client catches it and runs
 * the message as the next turn. */
export class OpenCodeSteerError extends Error {
  constructor(
    readonly context: SteerContext,
    cause?: unknown,
  ) {
    super(
      `OpenCode could not steer session ${context.sessionId} at ${context.operation}: ${context.reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "OpenCodeSteerError";
  }
}

/** What one API process ended with. */
type ApiAnswer = Readonly<{
  /** `undefined` when the process passed its deadline. */
  exitCode: number | null | undefined;
  stdout: string;
  httpStatus?: string;
}>;

/** Makes the error of a stage, with what the steer knows at that moment. */
type Refuse = (
  operation: SteerStage,
  reason: string,
  answer?: ApiAnswer,
  cause?: unknown,
) => OpenCodeSteerError;

/** The one-shot API calls of one `opencode acp` process. */
export class SteerChannel {
  /** The working folder and environment of the `opencode acp` process. The
   * shared client removes the Buzz identity from that environment, so a steer
   * process must never get a wider one. */
  private launch: Pick<HostProcessOptions, "cwd" | "env"> = {};
  private readonly running = new Set<HostProcess>();
  private closed = false;

  constructor(private readonly spawn: Spawn) {}

  launchedWith({ cwd, env }: HostProcessOptions) {
    this.launch = { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) };
  }

  /** The `opencode acp` process ended, so no steer process may outlive it. */
  close() {
    this.closed = true;
    for (const child of this.running) void stop(child);
  }

  /** Admits `text` into the turn `runId`, or throws so that it queues. `runs`
   * says if that turn still runs. */
  async steer(
    sessionId: string,
    runId: string,
    text: string,
    runs: () => boolean,
  ) {
    const started = Date.now();
    const refuse: Refuse = (operation, reason, answer, cause) =>
      new OpenCodeSteerError(
        {
          operation,
          sessionId,
          runId,
          reason,
          ...(answer ? { exitCode: answer.exitCode } : {}),
          ...(answer?.httpStatus ? { httpStatus: answer.httpStatus } : {}),
          elapsedMs: Date.now() - started,
        },
        cause,
      );
    try {
      await this.admit(sessionId, text, runs, refuse);
    } catch (error) {
      // The shared client swallows this error and queues the message. This is
      // the only record of why a message did not steer.
      if (error instanceof OpenCodeSteerError)
        console.warn("OpenCode steer failed", error.context);
      throw error;
    }
  }

  private async admit(
    sessionId: string,
    text: string,
    runs: () => boolean,
    refuse: Refuse,
  ) {
    if (this.closed) throw refuse("validate", "the process ended");
    if (!runs()) throw refuse("validate", "the turn ended");
    if (!ID_SHAPE.test(sessionId)) throw refuse("validate", "bad session id");
    // `resume: false` keeps the turn in the server that runs it. With a resume,
    // this short-lived server would run the model itself.
    const body = JSON.stringify({ text, delivery: "steer", resume: false });
    if (new TextEncoder().encode(body).length > STEER_BODY_LIMIT_BYTES)
      throw refuse("validate", "the message is too long to steer");
    const path = `/api/session/${encodeURIComponent(sessionId)}`;
    const admitted = await this.call("POST", `${path}/prompt`, body).catch(
      (error: unknown) => {
        throw refuse("admit", "the process did not start", undefined, error);
      },
    );
    // A process past its deadline may have written the row. The client then
    // queues a message that may also steer: two answers beat none.
    if (admitted.exitCode !== 0)
      throw refuse(
        "admit",
        admitted.exitCode === undefined ? "timed out" : "OpenCode refused it",
        admitted,
      );
    if (runs()) return;
    await this.withdraw(path, admitted, refuse);
  }

  /** The turn ended while the steer was on its way. OpenCode holds such a row
   * for the session's next message, which may never come. So it takes the row
   * back and queues the message. If the row is gone, the model has it, and a
   * queued copy would answer twice. */
  private async withdraw(path: string, admitted: ApiAnswer, refuse: Refuse) {
    const inboxId = rowId(admitted.stdout);
    if (!inboxId) return;
    const taken = await this.call(
      "DELETE",
      `${path}/inbox/${encodeURIComponent(inboxId)}`,
    ).catch((error: unknown) => {
      console.warn("OpenCode kept a late steer for the next message", error);
      return undefined;
    });
    if (taken?.exitCode === 0) throw refuse("withdraw", "the turn ended");
    if (taken && taken.httpStatus !== GONE_STATUS)
      console.warn("OpenCode kept a late steer for the next message", {
        exitCode: taken.exitCode,
        httpStatus: taken.httpStatus,
      });
  }

  /** Runs one API request. Its deadline kills the process with its private
   * server. */
  private async call(
    method: string,
    path: string,
    body?: string,
  ): Promise<ApiAnswer> {
    let stdout = "";
    let stderr = "";
    const child = await this.spawn(STEER_PROCESS_ID, {
      ...this.launch,
      args: [method, path, ...(body === undefined ? [] : ["--data", body])],
      onStdout: (data) => {
        stdout = (stdout + data).slice(0, ANSWER_LIMIT_CHARS);
      },
      onStderr: (data) => {
        stderr = (stderr + data).slice(0, ANSWER_LIMIT_CHARS);
      },
    });
    this.running.add(child);
    // `close` ran while the host started it.
    if (this.closed) void stop(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), STEER_TIMEOUT_MS);
    });
    try {
      const exitCode = await Promise.race([child.exited, deadline]);
      if (exitCode === undefined) await stop(child);
      const httpStatus = HTTP_STATUS.exec(stderr)?.[1];
      return { exitCode, stdout, ...(httpStatus ? { httpStatus } : {}) };
    } finally {
      clearTimeout(timer);
      this.running.delete(child);
    }
  }
}

/** Kills a process. It may have exited already, which is what a kill wants. */
const stop = (child: HostProcess) => child.kill().catch(() => undefined);

/** The inbox row id in the answer to an admitted steer. */
function rowId(stdout: string) {
  try {
    const id = str(object(object(JSON.parse(stdout) as unknown)?.data)?.id);
    return ID_SHAPE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
