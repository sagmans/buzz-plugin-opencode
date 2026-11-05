// OpenCode agents: an agent type whose agents are OpenCode on this computer,
// all in one `opencode acp` process. Each conversation an agent is in is one
// ACP session in it; OpenCode answers with the in-process Buzz tools, served
// to it over loopback HTTP MCP. The turn logic is buzz-app's Goose runtime,
// run wiring and synced settings, bundled unchanged; the build swaps Goose's
// process adapter and sessions module for `./opencode` and `./sessions`
// (vite.config.ts, SWAPS). The wiring follows buzz-app's bundled Goose
// plugin (src/bundled/goose/index.ts), the app's own ACP agent type.
import type { Spawn } from "@buzz/features/agent-harness/acp/types";
import { repositoriesContext } from "@buzz/features/communities/repositories";
import type { AgentType } from "@buzz/features/agents/service";
import type { Host } from "@buzz/features/host/service";
import type { PluginModule } from "@buzz/plugins/api";
import { createActivity } from "./activity";
import { RecordedHistory } from "./history";
import { OpenCodeIcon } from "./icon";
import { ModelList } from "./models";
import { createProvider } from "./provider";
import { bindReact } from "./react-host";
import { ActivityRecorder } from "./recorder";
import { ActivitySessions, HarnessReader, SessionLog } from "./session-read";
import { promptsAsOpenCode } from "./sessions";
import { OpenCodeSetup } from "./setup";
import { STEER_PROCESS_ID } from "./steer";
import { gooseRun } from "@buzz/bundled/goose/run";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
  GooseRuntime,
} from "@buzz/bundled/goose/runtime";
import { OpenCodeProcess } from "./opencode";
import { createViews } from "./views";

/** The type id saved agents match on: never change it. */
export const TYPE_ID = "opencode";
/** The manifest id; used when the host names no plugin owner. */
const PLUGIN_ID = "sagmans.opencode";
/** The runtime name a shared or exported agent records. */
const SHARED_RUNTIME = "opencode";
const TITLE = "OpenCode";
/** The agent storage key of an agent's activity record, before its agent key. */
const ACTIVITY_PREFIX = "sagmans.opencode.activity.v1:";
/** The local storage key of the sessions each agent ran. Saved logs read this
 * one, so sessions from before the record still show. */
const HISTORY_KEY = "sagmans.opencode.history.v1";
/** OpenCode's `session/load` only replays, and its `session/list` names the
 * workspace's sessions, so it can show those from before the log, as Goose does. */
const DISCOVERS_SESSIONS = true;

/** The `spawn` the runtime starts agents with: every agent process it starts is
 * recorded. A steer process is not: its output is no ACP, and it echoes the
 * message. */
const spawnRecorded = (recorder: ActivityRecorder, spawn: Spawn): Spawn => {
  const recorded = recorder.tap(spawn);
  return (id, options) =>
    id === STEER_PROCESS_ID ? spawn(id, options) : recorded(id, options);
};

/** What survives a change of agent type: instructions and workspace. */
const CARRIED: Pick<AgentType<Config>, "adopt" | "carry"> = {
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
};

/** The agent's session list, from what the runtime has open and has saved. */
const sessionViews = (
  runtime: GooseRuntime,
): NonNullable<AgentType<Config>["sessions"]> => ({
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
});

/** What the Activity tab reads sessions through. On the plain `spawn`, off the
 * record: a replay is not a turn. */
const activitySessions = (
  history: RecordedHistory,
  log: SessionLog,
  spawner: ConstructorParameters<typeof HarnessReader>[0],
) =>
  new ActivitySessions(
    history,
    log,
    new HarnessReader(spawner, (spawn, launch) =>
      OpenCodeProcess.start(spawn, launch),
    ),
    DISCOVERS_SESSIONS,
  );

/** Keeps the log of the sessions each agent of this type ran, with the workspace
 * its session must be read in. Returns how to stop. */
const logSessions = (
  runtime: GooseRuntime,
  log: SessionLog,
  agents: Parameters<PluginModule["apply"]>[0]["agents"],
  typeKey: string,
) =>
  runtime.subscribe(() => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    for (const agent of snapshot.running)
      if (agent.type === typeKey)
        log.record(agent.key, runtime, config(agent.config).workspace);
  });

export const inject = ["react", "agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, host } = ctx;
  // Before any view renders: the bundled app components use Buzz's React.
  bindReact(ctx.react);
  // Only the desktop app can start `opencode acp`; no unusable type elsewhere.
  // These are all the host methods the Goose runtime needs: with one missing it
  // would stop each turn with its own "goose agents run only in the desktop
  // app", which must never reach an owner of an OpenCode agent.
  if (!host.spawn || !host.serveMcp || !host.resolveDirectory || !host.readFile)
    return;
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const recorder = new ActivityRecorder(agents.storage, ACTIVITY_PREFIX);
  const history = new RecordedHistory(recorder);
  // Only what the Goose runtime reads of a host.
  const runtimeHost = {
    serveMcp: host.serveMcp.bind(host),
    resolveDirectory: host.resolveDirectory.bind(host),
    readFile: host.readFile.bind(host),
  };
  const runtime = new GooseRuntime(
    {
      ...runtimeHost,
      spawn: spawnRecorded(recorder, host.spawn.bind(host)),
    } as Host,
    agents.relay,
    (key, signal) => agents.core(key, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
    promptsAsOpenCode(agents.storage),
  );
  const models = new ModelList((id) => host.runCommand(id));
  const spawner = {
    spawn: host.spawn.bind(host),
    resolveDirectory: host.resolveDirectory.bind(host),
  };
  const setup = new OpenCodeSetup(spawner, models);
  const { Create, CreateModel, SettingsTab } = createViews(models, setup);
  const log = new SessionLog(localStorage, HISTORY_KEY);
  const { ActivityTab } = createActivity({
    runtime,
    history,
    recorder,
    sessions: activitySessions(history, log, spawner),
  });
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const unsubscribe = agents.subscribe(sync);
  sync();
  const stopLog = logSessions(runtime, log, agents, typeKey);
  ctx.effect(() => () => {
    unsubscribe();
    stopLog();
    runtime.dispose();
    void recorder.flush();
  });
  agents.register<Config>({
    id: TYPE_ID,
    title: TITLE,
    icon: OpenCodeIcon,
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
    ...CARRIED,
    summary: (agent) => config(agent.config).model || TITLE,
    sessions: sessionViews(runtime),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    provider: createProvider(setup),
    usage: (agent, options) => history.usage(agent.key, options),
    models: (agent) => setup.picks(config(agent.config)),
    ...gooseRun(runtime),
  });
};
