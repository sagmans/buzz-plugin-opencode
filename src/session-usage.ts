// An agent's token use as OpenCode stored it, so the app's usage view covers what
// the local record (./recorder.ts) never saw: sessions from before the plugin,
// turns outside the record, and the child sessions of a task.
//
// OpenCode keeps each model request's counts and cost on its assistant message.
// ACP has no way to read them without replaying a whole session, and the database
// is larger than the host's file limit. So each read here is one short
// `opencode --standalone api` process, the grant that steering uses (./steer.ts).
// It runs GET requests only, and what it keeps is numbers and the first prompt's
// place: the rest of each answer is dropped when it is parsed.
//
// Each process costs a server start, so a session is asked again only after
// OpenCode updated it: a later read mostly repeats the session list.
import type { Spawn } from "@buzz/features/agent-harness/acp/types";
import type {
  SessionUsage,
  UsageObservation,
} from "@buzz/features/agents/service";
import { limited, withRevision } from "@buzz/features/agents/session-usage";
import type { HostProcess } from "@buzz/features/host/service";
import { object, promptPlace, str } from "./recorder";
import { abortable } from "./sessions";
import { STEER_PROCESS_ID } from "./steer";

/** Processes at once, for every agent's read together: each one is a server start
 * on the owner's computer, and the first read asks for many. */
const READERS = 4;
/** One API request. A page holds whole messages, so it takes longer than a steer;
 * past this the process is stuck. */
const READ_TIMEOUT_MS = 60_000;
/** One answer's size. The largest page seen is a few MB; a longer one is refused
 * rather than held in the app's memory. */
const ANSWER_LIMIT_CHARS = 64 * 1024 * 1024;
/** Rows of one page. 200 is OpenCode's most for messages. A smaller page starts
 * more processes; a larger one holds more message text in memory at once. */
const PAGE_ROWS = 100;
/** Pages followed in one listing, so a cursor that never ends cannot run forever. */
const PAGE_LIMIT = 1_000;
/** Tries of one request. Its private server can exit before it is ready while
 * others start, seen in 1 to 4 of about 95 starts; the cause is OpenCode's. A
 * refused request gets no second try. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
/** The ids go into a request path, and they come from process output. */
const ID_SHAPE = /^[a-z]{2,8}_[0-9A-Za-z]{1,128}$/;
/** The status line OpenCode writes on stderr for a refused request. */
const HTTP_STATUS = /^HTTP (\d{3})\b/m;
/** Names OpenCode as the cost's source in the app's usage view, as the record does. */
const COST_SOURCE = "harness";
/** A recorded session's gap when OpenCode's store could not be fully read. */
const UNREAD_STORE = "OpenCode's store could not be fully read";

/** A request to OpenCode's API failed. Names no chat text. */
export class OpenCodeUsageError extends Error {
  constructor(
    readonly context: Readonly<{
      operation: string;
      path: string;
      exitCode?: number | null | undefined;
      httpStatus?: string | undefined;
      elapsedMs: number;
    }>,
    options?: ErrorOptions,
  ) {
    super(
      `OpenCode could not answer ${context.path} at ${context.operation} after ${context.elapsedMs} ms`,
      options,
    );
    this.name = "OpenCodeUsageError";
  }
}

export type UsageHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;
/** What the agent's sessions in OpenCode's store used. */
export type UsageRead = Readonly<{
  sessions: readonly SessionUsage[];
  /** What could not be read. The sessions listed are still good. */
  failure?: string;
}>;
/** A session as OpenCode lists it. */
type Row = Readonly<{
  id: string;
  parentId: string | undefined;
  title: string;
  createdAt: number;
  updatedAt: number;
}>;
type Opening = ReturnType<typeof promptPlace>;

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function rowOf(value: unknown): Row | undefined {
  const row = object(value);
  const id = str(row?.id);
  const time = object(row?.time);
  const updatedAt = num(time?.updated);
  if (!ID_SHAPE.test(id) || updatedAt === undefined) return undefined;
  const parentId = str(row?.parentID);
  return {
    id,
    parentId: parentId || undefined,
    title: str(row?.title),
    createdAt: num(time?.created) ?? updatedAt,
    updatedAt,
  };
}

/** The app's name of a model, as OpenCode's ACP reports it to the record, so one
 * model shows as one row. */
function modelName(model: Readonly<Record<string, unknown>> | undefined) {
  return [str(model?.providerID), str(model?.id), str(model?.variant)]
    .filter(Boolean)
    .join("/");
}

/** One assistant message's request. OpenCode counts cached input and thinking
 * apart from `input` and `output`, and the app has no field for thinking. A message
 * with no counts yet is a request still running: it has nothing to report. */
export function observationOf(value: unknown): UsageObservation | undefined {
  const row = object(value);
  const tokens = object(row?.tokens);
  const cache = object(tokens?.cache);
  const time = object(row?.time);
  const counts = {
    input: num(tokens?.input) ?? 0,
    output: (num(tokens?.output) ?? 0) + (num(tokens?.reasoning) ?? 0),
    cacheRead: num(cache?.read) ?? 0,
    cacheWrite: num(cache?.write) ?? 0,
  };
  const at = num(time?.completed) ?? num(time?.created);
  const usd = num(row?.cost);
  if (at === undefined || !Object.values(counts).some(Boolean)) return undefined;
  return {
    ...(str(row?.id) ? { requestId: str(row?.id) } : {}),
    at,
    model: modelName(object(row?.model)) || "unknown",
    tokens: counts,
    ...(usd !== undefined ? { cost: { usd, source: COST_SOURCE } } : {}),
  };
}

/** A session and its descendants. The ids come from process output, so a loop in
 * them must not hang the read. */
function family(root: Row, children: ReadonlyMap<string, readonly Row[]>) {
  const seen = new Map([[root.id, root]]);
  for (const row of seen.values())
    for (const child of children.get(row.id) ?? [])
      if (!seen.has(child.id)) seen.set(child.id, child);
  return [...seen.values()];
}

/** Kills a process. It may have exited already, which is what a kill wants. */
const stop = (child: HostProcess) => child.kill().catch(() => undefined);

export class StoreUsage {
  private readonly reader = limited(READERS);
  /** Each session's requests, by when OpenCode last updated it. */
  private readonly requests = new Map<
    string,
    Readonly<{ at: number; read: Promise<readonly UsageObservation[]> }>
  >();
  /** Each session's first prompt, which never changes. */
  private readonly openings = new Map<string, Promise<Opening | undefined>>();
  /** The listing under way, which every agent's read meanwhile shares. */
  private listing: Promise<readonly Row[]> | undefined;

  constructor(private readonly host: UsageHost) {}

  /** One GET, again after a start that failed: it changes nothing, so a second
   * try is safe. */
  private async get(operation: string, path: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.once(operation, path);
      } catch (error) {
        if (
          !(error instanceof OpenCodeUsageError) ||
          error.context.httpStatus ||
          attempt >= ATTEMPTS
        )
          throw error;
        console.warn("OpenCode usage read tries again", {
          ...error.context,
          attempt,
        });
        const delay = RETRY_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** One GET in a process of its own. A read that was cancelled lets it finish
   * under its deadline, and it still fills the cache for the next read. */
  private async once(operation: string, path: string): Promise<unknown> {
    return this.reader(async () => {
      const started = Date.now();
      const refuse = (
        answer: { exitCode?: number | null | undefined; stderr?: string },
        cause?: unknown,
      ) =>
        new OpenCodeUsageError(
          {
            operation,
            path,
            exitCode: answer.exitCode,
            httpStatus: HTTP_STATUS.exec(answer.stderr ?? "")?.[1],
            elapsedMs: Date.now() - started,
          },
          cause === undefined ? undefined : { cause },
        );
      let stdout = "";
      let stderr = "";
      let tooLong = false;
      const child = await this.host.spawn(STEER_PROCESS_ID, {
        cwd: await this.host.resolveDirectory("~"),
        args: ["GET", path],
        onStdout: (data) => {
          stdout += data;
          if (stdout.length <= ANSWER_LIMIT_CHARS) return;
          tooLong = true;
          stdout = "";
          void stop(child);
        },
        onStderr: (data) => {
          stderr = (stderr + data).slice(-ANSWER_LIMIT_CHARS);
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), READ_TIMEOUT_MS);
      });
      try {
        const exitCode = await Promise.race([child.exited, deadline]);
        if (exitCode === undefined) await stop(child);
        if (exitCode !== 0 || tooLong) throw refuse({ exitCode, stderr });
        try {
          return JSON.parse(stdout) as unknown;
        } catch (error) {
          throw refuse({ exitCode, stderr }, error);
        }
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Every row of a paged answer. OpenCode refuses `order` beside a cursor, which
   * holds it already, so only the first page names it. */
  private async pages(operation: string, query: string, order: string) {
    const rows: unknown[] = [];
    let cursor = "";
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      const answer = object(
        await this.get(
          operation,
          `${query}&${cursor ? `cursor=${encodeURIComponent(cursor)}` : `order=${order}`}`,
        ),
      );
      const data = answer?.data;
      if (Array.isArray(data)) rows.push(...data);
      cursor = str(object(answer?.cursor)?.next);
      if (!cursor) return rows;
    }
    throw new OpenCodeUsageError({
      operation,
      path: query,
      elapsedMs: 0,
    });
  }

  /** All of OpenCode's sessions, children too. The agent may have run in folders
   * it has since left, so this is not limited to its workspace. */
  private list() {
    this.listing ??= this.pages(
      "list",
      `/api/session?limit=${PAGE_ROWS}`,
      "desc",
    )
      .then((rows) => rows.flatMap((row) => rowOf(row) ?? []))
      .finally(() => {
        this.listing = undefined;
      });
    return this.listing;
  }

  /** The place and agent a session's first prompt names. A failed read is tried
   * again next time. */
  private opening(id: string) {
    const known = this.openings.get(id);
    if (known) return known;
    const read = this.get(
      "opening",
      `/api/session/${encodeURIComponent(id)}/message?type=user&limit=1&order=asc`,
    ).then((answer) => {
      const data = object(answer)?.data;
      const first: unknown = Array.isArray(data) ? data[0] : undefined;
      const text = str(object(first)?.text);
      return text ? promptPlace(text) : undefined;
    });
    this.openings.set(id, read);
    read.catch(() => {
      if (this.openings.get(id) === read) this.openings.delete(id);
    });
    return read;
  }

  /** A session's requests, read again only after OpenCode updated it. */
  private used(row: Row) {
    const known = this.requests.get(row.id);
    if (known?.at === row.updatedAt) return known.read;
    const read = this.pages(
      "messages",
      `/api/session/${encodeURIComponent(row.id)}/message?type=assistant&limit=${PAGE_ROWS}`,
      "asc",
    ).then((rows) => rows.flatMap((item) => observationOf(item) ?? []));
    this.requests.set(row.id, { at: row.updatedAt, read });
    read.catch(() => {
      if (this.requests.get(row.id)?.read === read)
        this.requests.delete(row.id);
    });
    return read;
  }

  /** A session and its descendants' requests, and how many could not be read. */
  private async tree(all: readonly Row[], signal: AbortSignal) {
    const read = await Promise.allSettled(
      all.map((row) => abortable(this.used(row), signal)),
    );
    signal.throwIfAborted();
    const main = read[0];
    if (main?.status === "rejected") throw main.reason;
    return {
      observations: read.flatMap((item) =>
        item.status === "fulfilled" ? item.value : [],
      ),
      unread: read.filter((item) => item.status === "rejected").length,
    };
  }

  /** The agent's sessions in OpenCode's store with activity since `since`. A
   * session that cannot be read loses only itself. */
  async usage(
    agent: string,
    since: number,
    signal: AbortSignal,
  ): Promise<UsageRead> {
    let rows: readonly Row[];
    try {
      rows = await abortable(this.list(), signal);
    } catch (error) {
      signal.throwIfAborted();
      return { sessions: [], failure: `the session list: ${message(error)}` };
    }
    const children = new Map<string, Row[]>();
    for (const row of rows)
      if (row.parentId)
        children.set(row.parentId, [
          ...(children.get(row.parentId) ?? []),
          row,
        ]);
    const failures: string[] = [];
    const found = await Promise.all(
      rows
        .filter((row) => !row.parentId)
        .map(async (root) => {
          const all = family(root, children);
          const lastAt = Math.max(...all.map((row) => row.updatedAt));
          if (lastAt < since) return [];
          try {
            const opening = await abortable(this.opening(root.id), signal);
            if (opening?.agent !== agent) return [];
            const tree = await this.tree(all, signal);
            return [
              await withRevision({
                id: root.id,
                gaps: tree.unread
                  ? [`${tree.unread} child sessions could not be read`]
                  : [],
                ...(opening.channelId ? { channelId: opening.channelId } : {}),
                ...(opening.root ? { root: opening.root } : {}),
                ...(root.title ? { title: root.title } : {}),
                startedAt: root.createdAt,
                lastAt,
                observations: tree.observations,
              }),
            ];
          } catch (error) {
            signal.throwIfAborted();
            failures.push(`${root.id}: ${message(error)}`);
            return [];
          }
        }),
    );
    return {
      sessions: found.flat(),
      ...(failures.length ? { failure: failures.join("; ") } : {}),
    };
  }
}

/** The usage view's sessions: each from OpenCode's store when that holds token
 * use, which covers every request and child session, else from the record. A
 * failed read may hide a session: the record's then say so, and nothing to show
 * at all is an unread harness, not an idle one. */
export async function mergedUsage(
  recorded: readonly SessionUsage[],
  { sessions, failure }: UsageRead,
): Promise<readonly SessionUsage[]> {
  const stored = sessions.filter((session) => session.observations.length);
  if (failure && !stored.length && !recorded.length) throw new Error(failure);
  const seen = new Set(stored.map((session) => session.id));
  const rest = recorded.filter((session) => !seen.has(session.id));
  if (!failure) return [...stored, ...rest];
  return [
    ...stored,
    ...(await Promise.all(
      rest.map(({ revision: _, ...session }) =>
        withRevision({ ...session, gaps: [...session.gaps, UNREAD_STORE] }),
      ),
    )),
  ];
}
