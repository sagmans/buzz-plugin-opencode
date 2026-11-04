// The part of the OpenCode agent type that runs agents, without its views.
// Adapted from buzz-app src/bundled/goose/run.ts (Apache-2.0, see NOTICE).
import type { AgentType } from "@buzz/features/agents/service";
import { type Config, config, type OpenCodeRuntime } from "./runtime";
import { syncedSettingsSchema, withSyncedSettings } from "./settings";

/** A turn's run returns once OpenCode has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. */
export const openCodeRun = (
  runtime: OpenCodeRuntime,
): Pick<
  AgentType<Config>,
  | "sessionControls"
  | "run"
  | "runOnce"
  | "timeoutMs"
  | "syncedSettings"
  | "resumes"
> => ({
  sessionControls: {
    scope: (agent) => config(agent.config).scope,
    state: (agent, place) => runtime.sessionState(agent, place),
    run: (agent, place, action) => runtime.session(agent, place, action),
    subscribe: (listener) => runtime.subscribe(listener),
  },
  run: (delivery) => runtime.run(delivery),
  runOnce: (turn) => runtime.runOnce(turn),
  timeoutMs: HANDOVER_MS,
  syncedSettings: {
    schema: syncedSettingsSchema,
    withSynced: withSyncedSettings,
  },
  // Closing or reloading the app stops its turns; each resumed one carries on
  // in a new session shown what it already did in the conversation.
  resumes: true,
});
