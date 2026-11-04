// The agent settings that sync across devices (NIP-AP `buzz.agent.settings`):
// every per-agent setting except instructions, which have their own artifact.
// No credentials or env vars live in this config; the allowlist keeps it so.
// Adapted from buzz-app src/bundled/goose/settings.ts (Apache-2.0, see
// NOTICE), without the provider and thinking-level fields OpenCode lacks.
import {
  pickSettings,
  type SettingsSchema,
  withSynced,
} from "@buzz/features/agents/agent-config";
import { type Config, DEFAULT_CONFIG } from "./runtime";

export const syncedSettingsSchema = {
  model: "string",
  scope: ["thread", "channel"],
} as const satisfies SettingsSchema;

export const syncedSettings = (config: Config) =>
  pickSettings(syncedSettingsSchema, config);

/** Synced fields come only from `settings`, a left-out one from the default;
 * everything else stays this device's. */
export const withSyncedSettings = (
  config: Config,
  settings: Readonly<Record<string, string>>,
): Config => withSynced(syncedSettingsSchema, DEFAULT_CONFIG, config, settings);
