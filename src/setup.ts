// What OpenCode offers on this computer beyond its model list: whether it runs
// at all, for the app's provider row and dialog, and the thinking levels
// (variants) of each model. Adapted from buzz-app
// src/bundled/goose/setup.ts (Apache-2.0, see NOTICE). OpenCode's model list
// names no variants and ACP lists config options only per session and only for the
// session's model, so each read runs a short-lived `opencode acp` and moves a
// throwaway session across the models. That process serves no Buzz tools and
// runs no model. Its server does not resume interrupted turns (only OpenCode's
// managed server does), so it cannot disturb the conversation processes' turns.
import type {
  AgentProviderSnapshot,
  Models,
} from "@buzz/features/agents/service";
import { type ModelList, MODELS_TTL_MS, splitVariant } from "./models";
import {
  DEFAULT_EFFORT,
  type GooseProcess as OpenCodeAcp,
  OPENCODE,
  OpenCodeProcess,
  type OpenCodeHost,
  REQUEST_TIMEOUT_MS,
  reportedVersion,
} from "./opencode";

/** The whole read of many models stops here, so a mention's model menu is not
 * held up by a long catalog; models not reached offer no levels until the next
 * read. */
const LEVELS_READ_MS = 15_000;
/** A setup check stops waiting here: the row stays "Checking…" until it ends,
 * and one hung process must not hold that up. Its process is still stopped. */
const CHECK_WAIT_MS = 30_000;
/** The app checks each time its settings open, and a check starts OpenCode
 * twice. A check that found all well stands this long; it matches the model
 * list it read. One that found a problem never stands, so a fix shows on the
 * next open. */
const CHECK_TTL_MS = MODELS_TTL_MS;
/** Bounds the process output a dialog can show. */
const PROBLEM_LIMIT = 500;
/** The app's provider row shows these as the action to take. */
const LABEL_INSTALL = "Install OpenCode";
const LABEL_CHECK = "Check OpenCode setup";
const LABEL_SET_UP = "Set up OpenCode";

/** A model's thinking levels; each is a value of OpenCode's `effort` option. */
export type Efforts = Readonly<{ levels: readonly string[] }>;

/** A session's settings, as `session/new` and `session/set_config_option`
 * return them. */
type ConfigOptions = {
  configOptions?: {
    id?: string;
    category?: string | null;
    currentValue?: unknown;
    options?: { value: string }[];
  }[];
};
/** An open session, as `session/new` returns it. */
type OpenedSession = ConfigOptions & { sessionId: string };

/** What a setup check found. Never holds a key: the check does not read any. */
export type OpenCodeStatus = Readonly<{
  /** False only when the system could not find the program. */
  installed: boolean;
  /** Whether `opencode acp` started and opened a session. */
  reachable: boolean;
  version: string;
  /** The model OpenCode's own config picks, "" when it did not name one. */
  defaultModel: string;
  models: readonly string[];
  /** What to tell the owner, "" when all is well. */
  problem: string;
}>;

/** A setup check did not finish. */
export class SetupCheckError extends Error {
  constructor(
    readonly operation: string,
    readonly waitedMs: number,
  ) {
    super(`OpenCode did not answer ${operation} within ${waitedMs / 1000} seconds`);
    this.name = "SetupCheckError";
  }
}

/** OpenCode did not give a model's thinking levels. */
export class LevelsError extends Error {
  constructor(
    readonly model: string,
    cause?: unknown,
  ) {
    super(
      `OpenCode gave no thinking levels for ${model || "its default model"}`,
      { cause },
    );
    this.name = "LevelsError";
  }
}

const offered = ({ configOptions = [] }: ConfigOptions): Efforts => ({
  levels: (
    configOptions.find((item) => item.category === "thought_level")?.options ??
    []
  )
    .map(({ value }) => value)
    // Not a level: it is what no pick means, and the views offer it as such.
    .filter((value) => value !== DEFAULT_EFFORT),
});

/** The first letter up, as the app labels levels. */
const label = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);

/** `work`, or a `SetupCheckError` once `CHECK_WAIT_MS` have passed. */
function bounded<T>(operation: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SetupCheckError(operation, CHECK_WAIT_MS)),
      CHECK_WAIT_MS,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, PROBLEM_LIMIT);

const currentModel = ({ configOptions = [] }: ConfigOptions) => {
  const value = configOptions.find((item) => item.id === "model")?.currentValue;
  return typeof value === "string" ? value : "";
};

/** The row's state for a check's findings. */
function readiness(status: OpenCodeStatus): AgentProviderSnapshot {
  if (!status.installed)
    return { readiness: "attention", attentionLabel: LABEL_INSTALL };
  if (!status.reachable)
    return { readiness: "attention", attentionLabel: LABEL_CHECK };
  if (!status.models.length)
    return { readiness: "attention", attentionLabel: LABEL_SET_UP };
  return { readiness: "ready" };
}

export class OpenCodeSetup {
  private readonly thinking = new Map<string, Promise<Efforts>>();
  private state: AgentProviderSnapshot = { readiness: "checking" };
  private found: OpenCodeStatus | undefined;
  /** When a check that found all well ended; undefined until one has. */
  private goodAt: number | undefined;
  private checking: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly host: OpenCodeHost,
    private readonly list: ModelList,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** What the latest check found; undefined until one has ended. */
  status = () => this.found;

  private update(state: AgentProviderSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** What the app calls when its settings open: the standing findings while
   * they are good and new, so that opening settings does not start OpenCode
   * each time, or else a fresh read. */
  check = (): Promise<void> =>
    this.goodAt !== undefined && Date.now() - this.goodAt < CHECK_TTL_MS
      ? Promise.resolve()
      : this.recheck();

  /** A fresh read, so that `opencode auth login` or an install done since the
   * last one shows. It never changes OpenCode's setup. Never rejects: the app
   * reads the outcome from the snapshot. */
  recheck = (): Promise<void> => {
    if (this.checking) return this.checking;
    this.list.forget();
    this.thinking.clear();
    this.goodAt = undefined;
    this.update({ readiness: "checking" });
    this.checking = this.probe()
      .then((status) => {
        this.found = status;
        const state = readiness(status);
        if (state.readiness === "ready") this.goodAt = Date.now();
        this.update(state);
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  };

  private async probe(): Promise<OpenCodeStatus> {
    const started = Date.now();
    const [acp, list] = await Promise.allSettled([
      bounded(
        "`opencode acp`",
        this.session(async (opencode, opened) => ({
          version: reportedVersion(opencode),
          defaultModel: currentModel(opened),
        })),
      ),
      bounded("`opencode --standalone models`", this.list.ids()),
    ]);
    const models = list.status === "fulfilled" ? list.value : [];
    const failed = acp.status === "rejected" ? reason(acp.reason) : "";
    const status: OpenCodeStatus = {
      installed: failed !== OPENCODE.missing,
      reachable: acp.status === "fulfilled",
      version: acp.status === "fulfilled" ? acp.value.version : "",
      defaultModel: acp.status === "fulfilled" ? acp.value.defaultModel : "",
      models,
      problem:
        failed || (list.status === "rejected" ? reason(list.reason) : ""),
    };
    if (status.problem)
      // The text can hold OpenCode's stderr: the dialog shows it to the owner,
      // and the log does not keep it.
      console.warn("OpenCode's setup check found a problem", {
        operation: "provider check",
        installed: status.installed,
        reachable: status.reachable,
        models: models.length,
        elapsedMs: Date.now() - started,
      });
    return status;
  }

  /** The thinking levels OpenCode offers on `model`; "" is its default one.
   * A model without variants offers none. */
  efforts(model: string): Promise<Efforts> {
    return this.levels([model])[0] as Promise<Efforts>;
  }

  /** The models an agent on `choice` can be asked to run a turn on, its own
   * first even when OpenCode no longer lists it, each with its levels, resting
   * on the agent's own level. `Default` leads them: it lets one message drop
   * an agent's saved level, and the composer's slider needs a resting place. */
  async picks(choice: Readonly<{ model: string; effort: string }>): Promise<Models> {
    const ids = await this.list.ids().catch(() => [] as string[]);
    const { model: current, effort: variant } = splitVariant(choice.model, ids);
    const named = current && !ids.includes(current) ? [current, ...ids] : ids;
    // Without levels a model offers no slider, so a failed read costs only it.
    const levels = await Promise.all(
      this.levels(named).map((read) => read.catch(() => undefined)),
    );
    const resting = choice.effort || variant;
    return {
      current,
      models: named.map((id, index) => {
        const offers = levels[index]?.levels ?? [];
        return {
          id,
          label: id,
          efforts: offers.length
            ? [DEFAULT_EFFORT, ...offers].map((level) => ({
                id: level,
                label: label(level),
              }))
            : [],
          ...(offers.length
            ? { effort: offers.includes(resting) ? resting : DEFAULT_EFFORT }
            : {}),
        };
      }),
    };
  }

  /** `efforts` for each of `models`. Those not read yet are read together, in
   * one throwaway session moved from model to model. */
  private levels(models: readonly string[]): Promise<Efforts>[] {
    const wanted = [...new Set(models.map((model) => model.trim()))]
      .filter((model) => !this.thinking.has(model))
      // The session opens on OpenCode's default model, so "" is read first.
      .sort((a, b) => Number(Boolean(a)) - Number(Boolean(b)));
    if (wanted.length) {
      const read = this.session(async (opencode, opened) => {
        const started = Date.now();
        const found = new Map<string, Efforts | Error>();
        for (const model of wanted) {
          if (Date.now() - started > LEVELS_READ_MS) break;
          try {
            found.set(
              model,
              offered(
                model
                  ? ((await opencode.request(
                      "session/set_config_option",
                      {
                        sessionId: opened.sessionId,
                        configId: "model",
                        value: model,
                      },
                      REQUEST_TIMEOUT_MS,
                    )) as ConfigOptions)
                  : opened,
              ),
            );
          } catch (error) {
            // One model OpenCode cannot move to does not cost the others.
            found.set(model, new LevelsError(model, error));
          }
        }
        return found;
      });
      for (const model of wanted) {
        const one = read.then((found) => {
          const efforts = found.get(model);
          if (!efforts || efforts instanceof Error)
            throw efforts ?? new LevelsError(model);
          return efforts;
        });
        // A failed read is tried again.
        one.catch(() => {
          if (this.thinking.get(model) === one) this.thinking.delete(model);
        });
        this.thinking.set(model, one);
      }
    }
    return models.map(
      (model) => this.thinking.get(model.trim()) as Promise<Efforts>,
    );
  }

  /** Runs `run` in a throwaway session of its own `opencode acp`. */
  private session<T>(
    run: (opencode: OpenCodeAcp, opened: OpenedSession) => Promise<T>,
  ): Promise<T> {
    return this.with(async (opencode, cwd) => {
      const opened = (await opencode.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      )) as OpenedSession;
      try {
        return await run(opencode, opened);
      } finally {
        // OpenCode keeps every session; this one is not worth keeping.
        await opencode
          .request(
            "session/delete",
            { sessionId: opened.sessionId },
            REQUEST_TIMEOUT_MS,
          )
          .catch(() => undefined);
      }
    });
  }

  /** Runs `run` against an `opencode acp` started for it in the home folder,
   * and stops it after. */
  private async with<T>(
    run: (opencode: OpenCodeAcp, cwd: string) => Promise<T>,
  ): Promise<T> {
    const cwd = await this.host.resolveDirectory("~");
    const opencode = await OpenCodeProcess.start(this.host.spawn, { cwd });
    try {
      return await run(opencode, cwd);
    } finally {
      await opencode.kill();
    }
  }
}
