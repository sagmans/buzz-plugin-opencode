// OpenCode agents: an agent type whose agents are OpenCode on this computer,
// all in one `opencode acp` process. Each conversation an agent is in is one
// ACP session in it; OpenCode answers with the in-process Buzz tools, served
// to it over loopback HTTP MCP. The wiring follows buzz-app's bundled Goose
// plugin (src/bundled/goose/index.ts), the app's own ACP agent type.
import { repositoriesContext } from "@buzz/features/communities/repositories";
import type { PluginModule } from "@buzz/plugins/api";
import { ModelList } from "./models";
import { openCodeRun } from "./run";
import { type Config, config, DEFAULT_CONFIG, OpenCodeRuntime } from "./runtime";
import { createViews } from "./views";

/** The type id saved agents match on: never change it. */
export const TYPE_ID = "opencode";
/** The manifest id; used when the host names no plugin owner. */
const PLUGIN_ID = "sagmans.opencode";
/** The runtime name a shared or exported agent records. */
const SHARED_RUNTIME = "opencode";
const TITLE = "OpenCode";

export const inject = ["react", "agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, host } = ctx;
  // Only the desktop app can start `opencode acp`; no unusable type elsewhere.
  if (!host.spawn || !host.serveMcp || !host.resolveDirectory) return;
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const runtime = new OpenCodeRuntime(
    host,
    agents.relay,
    (key, signal) => agents.core(key, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
    agents.storage,
  );
  const models = new ModelList((id) => host.runCommand(id));
  const { Create, CreateModel, SettingsTab } = createViews(ctx.react, models);
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const unsubscribe = agents.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    unsubscribe();
    runtime.dispose();
  });

  agents.register<Config>({
    id: TYPE_ID,
    title: TITLE,
    description:
      "OpenCode on this computer, with any provider OpenCode supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    importShared: (source) =>
      source.runtime === SHARED_RUNTIME
        ? { ...DEFAULT_CONFIG, model: source.model }
        : undefined,
    exportShared: (saved) => ({
      runtime: SHARED_RUNTIME,
      model: config(saved).model,
    }),
    Create,
    CreateModel,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => config(agent.config).model || TITLE,
    sessions: {
      list: (key) => {
        const live = runtime.sessions(key);
        const busy = new Map(live.map((view) => [view.key, view.busy]));
        const used = new Map(
          runtime.conversations(key).map(({ key, at }) => [key, at]),
        );
        // Open ones are listed even when saving them failed. A one-off turn
        // joins no conversation. (As buzz-app's Goose plugin lists them.)
        for (const { key, at } of live) if (at !== undefined) used.set(key, at);
        return [...used]
          .sort(([, a], [, b]) => b - a)
          .map(([key, at]) => {
            const [channelId = key, root] = key.split("/");
            const working = busy.get(key);
            return {
              channelId,
              ...(root && { root }),
              at,
              ...(working !== undefined && {
                status: working ? "Working" : "Idle",
              }),
            };
          });
      },
      subscribe: (listener) => runtime.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: SettingsTab,
      },
    ],
    models: (agent) => models.picks(config(agent.config).model),
    ...openCodeRun(runtime),
  });
};
