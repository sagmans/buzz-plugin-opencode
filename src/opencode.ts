// OpenCode on buzz-app's shared ACP client: one `opencode acp` process for
// every OpenCode agent. Plain ACP covers almost all of it; these hooks add
// only the model pick, which OpenCode takes as a session config option.
// Each session's Buzz tools reach OpenCode over loopback HTTP MCP, never a
// Buzz key (the client removes the Buzz identity from the environment).
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "@buzz/features/agent-harness/acp/process";
import type { ConfigOptions } from "@buzz/features/agent-harness/acp/session";
import { errorMessage } from "@buzz/features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "@buzz/features/agent-harness/acp/types";

export {
  REQUEST_TIMEOUT_MS,
  TOOL_SERVER,
} from "@buzz/features/agent-harness/acp/process";
export type {
  ServeMcp,
  Spawn,
  ToolServer,
} from "@buzz/features/agent-harness/acp/types";

/** The manifest process that runs `opencode acp`. */
export const PROCESS_ID = "opencode";
/** OpenCode's session config option for the model, as `session/new` lists it. */
const MODEL_OPTION = "model";

/** The desktop host's `spawn` and `resolveDirectory`, which OpenCode starts with. */
export type OpenCodeHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** What every `opencode acp` runs with. An agent turn must never stop to
 * update OpenCode itself, so its self-update is off; the owner updates
 * OpenCode as usual. */
export const ENV: Readonly<Record<string, string | null>> = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};

export const OPENCODE: AcpHooks = {
  label: "OpenCode",
  program: PROCESS_ID,
  missing:
    "OpenCode was not found. Install it (opencode.ai) and make sure `opencode` is on the PATH Buzz starts programs with.",
  // OpenCode is installed by the owner, often in a folder only a login
  // shell adds to PATH: a missing program then shows as `missing`.
  diagnoseStartup: true,
  env: ENV,
  // A model in OpenCode is `provider/model`, one config value. An empty
  // pick keeps what the owner's OpenCode config chooses.
  select: async (opencode, session, want) => {
    if (!want.model || want.model === session.chosen.model) return;
    try {
      session.offer(
        (await opencode.request(
          "session/set_config_option",
          { sessionId: session.id, configId: MODEL_OPTION, value: want.model },
          REQUEST_TIMEOUT_MS,
        )) as ConfigOptions,
      );
    } catch (error) {
      throw new Error(
        `OpenCode could not switch its model to ${want.model}: ${errorMessage(error)}`,
      );
    }
    session.chosen = { ...session.chosen, model: want.model };
  },
};

/** Starts `opencode acp` and checks it can reach the Buzz tools. */
export const OpenCodeProcess = {
  start: (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ) => AcpProcess.start(spawn, OPENCODE, launch),
};
