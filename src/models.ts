// The models OpenCode offers on this computer, for the New agent dialog, the
// Settings tab and the model pick on a mention. OpenCode lists them itself
// (`opencode --standalone models`, one `provider/model` per line), so the list always
// matches the providers the owner set up in OpenCode, with no model catalog
// in this plugin.

/** The manifest command that runs `opencode --standalone models`: the flag
 * keeps the read on a private server, so it never starts or uses the owner's
 * background service. */
export const MODELS_COMMAND = "models";
/** A list is kept this long, so opening several dialogs and settings runs
 * OpenCode once. A model added since shows after this, or at once with the
 * dialog's "Check again". */
export const MODELS_TTL_MS = 5 * 60_000;
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

/** A saved `provider/model/variant` as OpenCode's model and level. OpenCode
 * reads that form itself, so such a config keeps running as saved; pickers
 * show it as the two choices it is. An id OpenCode lists whole, or whose
 * shorter form it does not list, is a model id with slashes. */
export function splitVariant(
  model: string,
  ids: readonly string[],
): Readonly<{ model: string; effort: string }> {
  const cut = model.lastIndexOf("/");
  const base = model.slice(0, Math.max(cut, 0));
  return !ids.includes(model) && ids.includes(base)
    ? { model: base, effort: model.slice(cut + 1) }
    : { model, effort: "" };
}

/** Reads and caches OpenCode's model list. */
export class ModelList {
  private cached: { at: number; ids: Promise<string[]> } | undefined;
  constructor(private readonly runCommand: RunCommand) {}

  /** Drops the kept list: a setup check must see a provider set up just now. */
  forget() {
    this.cached = undefined;
  }

  /** The model ids, read again after `MODELS_TTL_MS` or a failure. */
  ids(): Promise<string[]> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < MODELS_TTL_MS) return this.cached.ids;
    const ids = (async () => {
      const output = await this.runCommand(MODELS_COMMAND);
      // The host gives null for a failed, timed-out or oversized run.
      if (output === null)
        throw new ModelListError(
          "OpenCode did not list its models. Check that `opencode --standalone models` works in a terminal.",
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
}
