// The models OpenCode offers on this computer, for the New agent dialog, the
// Settings tab and the model pick on a mention. OpenCode lists them itself
// (`opencode models`, one `provider/model` per line), so the list always
// matches the providers the owner set up in OpenCode, with no model catalog
// in this plugin.
import type { Model, Models } from "@buzz/features/agents/service";

/** The manifest command that runs `opencode models`. */
export const MODELS_COMMAND = "models";
/** A list is kept this long, so opening several dialogs runs OpenCode once. */
const CACHE_MS = 60_000;
/** OpenCode's model ids are `provider/model`; anything else in its output
 * (a warning, a banner) is not a model. */
const MODEL_LINE = /^[A-Za-z0-9._@:-]+\/[A-Za-z0-9._@:/+-]+$/;
/** Bounds what one bad output can put in a menu. */
const MODELS_MAX = 2_000;

/** `opencode models` failed or gave no model: OpenCode is missing, or no
 * provider is set up. */
export class ModelListError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelListError";
  }
}

type RunCommand = (id: string) => Promise<string | null>;

/** Model ids from `opencode models` output, in its order, without duplicates. */
export function parseModels(output: string): string[] {
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const id = line.trim();
    if (MODEL_LINE.test(id)) seen.add(id);
    if (seen.size >= MODELS_MAX) break;
  }
  return [...seen];
}

/** Reads and caches OpenCode's model list. */
export class ModelList {
  private cached: { at: number; ids: Promise<string[]> } | undefined;
  constructor(private readonly runCommand: RunCommand) {}

  /** The model ids, read again after `CACHE_MS` or a failure. */
  ids(): Promise<string[]> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.ids;
    const ids = (async () => {
      const output = await this.runCommand(MODELS_COMMAND);
      // The host gives null for a failed, timed-out or oversized run.
      if (output === null)
        throw new ModelListError(
          "OpenCode did not list its models. Check that `opencode models` works in a terminal.",
        );
      const list = parseModels(output);
      if (!list.length)
        throw new ModelListError(
          "OpenCode lists no models. Set up a provider with `opencode auth login`.",
        );
      return list;
    })();
    const entry = { at: now, ids };
    this.cached = entry;
    // A failed read is not kept: the next call tries again.
    ids.catch(() => {
      if (this.cached === entry) this.cached = undefined;
    });
    return ids;
  }

  /** The picks for a mention: OpenCode's models, with the agent's own model
   * first even when OpenCode no longer lists it, as it is the one it runs on.
   * OpenCode has no thinking levels in ACP, so no model offers efforts. */
  async picks(current: string): Promise<Models> {
    const ids = await this.ids().catch(() => [] as string[]);
    const named = current && !ids.includes(current) ? [current, ...ids] : ids;
    const models: Model[] = named.map((id) => ({ id, label: id, efforts: [] }));
    return { current, models };
  }
}
