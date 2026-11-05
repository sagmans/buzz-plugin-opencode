// The OpenCode agent type's parts of the app's screens: the New agent dialog
// and the Settings tab. They are built from the app's own components
// (ModelPicker, AgentInstructions, the design system), bundled unchanged from
// the pinned buzz-app clone, and laid out as buzz-app's Goose type lays out
// its own (src/bundled/goose/tabs.tsx), so an OpenCode agent looks like the
// app's own agents. `src/react-host.ts` makes them render with Buzz's React.
import { useEffect, useId, useRef, useState } from "react";
import { AgentInstructions } from "@buzz/features/agents/AgentInstructions";
import { AgentSaveButton } from "@buzz/features/agents/AgentSaveButton";
import { ModelDiscoveryRecovery } from "@buzz/features/agents/ModelDiscoveryRecovery";
import { type ModelChoice, ModelPicker } from "@buzz/features/agents/ModelPicker";
import type { AgentCreateProps, AgentViewProps } from "@buzz/features/agents/service";
import { validWorkspace } from "@buzz/bundled/codex/config";
import { Field } from "@buzz/shared/design-system/ui/Field";
import { Input } from "@buzz/shared/design-system/ui/Input";
import { Select } from "@buzz/shared/design-system/ui/Select";
import { SettingsGroup } from "@buzz/shared/design-system/ui/SettingsGroup";
import { OpenCodeIcon } from "./icon";
import { PanelSaveFooter } from "./save-footer";
import { type ModelList, splitVariant } from "./models";
import { DEFAULT_EFFORT, PROCESS_ID } from "./opencode";
import type { OpenCodeSetup } from "./setup";
import {
  type Config,
  config as readConfig,
  DEFAULT_CONFIG,
} from "@buzz/bundled/goose/runtime";

/** The empty model choice: OpenCode's own config picks the model. */
const DEFAULT_MODEL_LABEL = "OpenCode default";
const RESET_LABEL = "Use OpenCode default";
/** The level of a model with no pick, when the model's own is not known. */
const DEFAULT_LEVEL_LABEL = "Default";
const CREATE_MODEL_LABEL = "OpenCode model";
/** The harness mark beside the model on a library card, as Goose sizes it. */
const CARD_ICON_SIZE = 18;
const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];
const WORKSPACE_HELP =
  "The folder OpenCode works in. Use ~/ for your home folder. OpenCode reads, writes and runs commands there as you, with no approval step.";
const WORKSPACE_ERROR = "Enter an absolute or ~/… workspace path.";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const levelLabel = (level: string) =>
  level.charAt(0).toUpperCase() + level.slice(1);

type Read<T> =
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T };

/** `read()` as it settles, read again on `retry`; a shown value stays while
 * it is read again. (As buzz-app's Goose tabs read goose's lists.) */
function useRead<T>(read: () => Promise<T>, key = "") {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is fixed per view.
  useEffect(() => {
    let live = true;
    const kept = (prior: Read<T>) =>
      prior.value === undefined ? {} : { value: prior.value };
    setState((prior) => ({ status: "loading", ...kept(prior) }));
    read().then(
      (value) => live && setState({ status: "ready", value }),
      (error: unknown) =>
        live &&
        setState((prior) => ({
          status: "error",
          error: message(error),
          ...kept(prior),
        })),
    );
    return () => {
      live = false;
    };
  }, [round, key]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** The model and level to show for a config: a level it names, else the
 * variant its saved model value carries. */
function saved(current: Config, ids: readonly string[] = []) {
  const split = splitVariant(current.model, ids);
  return { model: split.model, effort: current.effort || split.effort };
}

/** Where the agent runs. The app's split Settings shows this group apart from
 * the identity group, so it stays one unit. */
function RuntimeFields({
  draft,
  onChange,
}: {
  draft: Config;
  onChange: (next: Config) => void;
}) {
  return (
    <>
      <Field label="Workspace" description={WORKSPACE_HELP}>
        <Input
          value={draft.workspace}
          onValueChange={(workspace) => onChange({ ...draft, workspace })}
        />
      </Field>
      <Select
        label="Sessions"
        variant="preference"
        value={draft.scope}
        groups={SCOPES}
        onValueChange={(value) =>
          onChange({
            ...draft,
            scope: value === "channel" ? "channel" : "thread",
          })
        }
      />
    </>
  );
}

export function createViews(models: ModelList, setup: OpenCodeSetup) {
  /** OpenCode's models as the picker lists them, each reading its thinking
   * levels only when its menu opens: a read costs a short-lived process. */
  function useChoices() {
    const [list, retry] = useRead(() => models.ids());
    const choices: ModelChoice[] = (list.value ?? []).map((id) => ({
      id,
      label: id,
      effortScope: PROCESS_ID,
      loadEfforts: async () => {
        const { levels } = await setup.efforts(id);
        return levels.length
          ? [
              { id: "", label: DEFAULT_LEVEL_LABEL },
              ...levels.map((level) => ({ id: level, label: levelLabel(level) })),
            ]
          : [];
      },
    }));
    return { list, retry, choices };
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        creation
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** The model row of the New agent dialog and of a library card. */
  function CreateModel({
    config,
    onChange,
    disabled,
    modelAppearance,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { list, retry, choices } = useChoices();
    const shown = saved(current, list.value);
    const [thinking] = useRead(() => setup.efforts(shown.model), shown.model);
    return (
      <ModelDiscoveryRecovery
        error={list.status === "error" ? list.error : undefined}
        loading={list.status === "loading"}
        retry={retry}
        disabled={disabled}
      >
        <ModelPicker
          compact
          groupByFamily
          includeDefault={false}
          resetLabel={RESET_LABEL}
          allowCustomModel
          label={CREATE_MODEL_LABEL}
          appearance={modelAppearance ?? "outlined"}
          // A card names its harness before the model, as Goose's does.
          {...(modelAppearance && {
            leading: <OpenCodeIcon size={CARD_ICON_SIZE} />,
          })}
          models={choices}
          value={shown.model}
          defaultLabel={DEFAULT_MODEL_LABEL}
          effort={shown.effort}
          // A card's chip keeps its room for the model name; its menu still
          // shows and sets the level. (As Goose's does.)
          effortLabel={
            !modelAppearance && thinking.value?.levels.length
              ? shown.effort
                ? levelLabel(shown.effort)
                : DEFAULT_LEVEL_LABEL
              : undefined
          }
          disabled={disabled}
          loading={list.status === "loading"}
          onChange={(model) => onChange({ ...current, model, effort: "" })}
          onEffortChange={(model, effort) =>
            onChange({ ...current, model, effort })
          }
        />
      </ModelDiscoveryRecovery>
    );
  }

  /** The thinking level turns run on: OpenCode's default, or a variant it
   * offers for the model. (As Goose's Thinking field, src/bundled/goose/tabs.tsx.) */
  function ThinkingField({
    model,
    value,
    onChange,
  }: Readonly<{
    model: string;
    value: string;
    onChange(effort: string): void;
  }>) {
    const [efforts] = useRead(() => setup.efforts(model), model);
    const levels = efforts.value?.levels ?? [];
    return (
      <Select
        label="Thinking"
        variant="preference"
        value={value}
        {...(!value ? { valueLabel: DEFAULT_LEVEL_LABEL } : {})}
        {...(efforts.status === "error"
          ? { description: `Could not read OpenCode's levels: ${efforts.error}` }
          : {})}
        groups={[
          {
            label: "",
            options: [
              { value: "", label: DEFAULT_LEVEL_LABEL },
              // A saved level the model does not offer, or not read yet.
              ...(value && !levels.includes(value)
                ? [
                    {
                      value,
                      label:
                        efforts.status === "ready"
                          ? `${levelLabel(value)} (unavailable)`
                          : levelLabel(value),
                    },
                  ]
                : []),
              ...levels.map((level) => ({
                value: level,
                label: levelLabel(level),
              })),
            ],
          },
        ]}
        onValueChange={onChange}
      />
    );
  }

  /** The model row of the Settings tab. */
  function ModelField({
    value,
    onChange,
  }: Readonly<{ value: string; onChange(model: string): void }>) {
    const { list, choices } = useChoices();
    return (
      <ModelPicker
        groupByFamily
        label="Model"
        allowCustomModel
        models={choices}
        loading={list.status === "loading"}
        value={value}
        defaultLabel={DEFAULT_MODEL_LABEL}
        {...(list.status === "error"
          ? { description: `Could not list models: ${list.error}` }
          : {})}
        onChange={onChange}
      />
    );
  }

  /** Every setting of an OpenCode agent, saved together. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const stored = readConfig(agent.config);
    const [draft, setDraft] = useState(stored);
    const [ids] = useRead(() => models.ids());
    const shown = saved(draft, ids.value);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(stored);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
        if (!validWorkspace(workspace)) throw new Error(WORKSPACE_ERROR);
        // The whole config, so fields other views keep are not erased.
        await save({
          ...agent.config,
          ...draft,
          // A saved `provider/model/variant` is stored as the two choices.
          model: shown.model.trim(),
          effort: shown.effort,
          workspace,
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <PanelSaveFooter form={form}>
        <form
          id={form}
          className="grid gap-4 [container-type:inline-size]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && (
            <p
              ref={saveErrorRef}
              tabIndex={-1}
              role="alert"
              className="buzz-field-error"
            >
              {error}
            </p>
          )}
          {settingsSection !== "runtime" && (
            <>
              <SettingsGroup>
                {settingsHost?.typeControl?.(configChanged)}
                <ModelField
                  value={shown.model}
                  onChange={(model) => setDraft({ ...draft, model, effort: "" })}
                />
                <ThinkingField
                  model={shown.model}
                  value={shown.effort === DEFAULT_EFFORT ? "" : shown.effort}
                  onChange={(effort) =>
                    setDraft({ ...draft, model: shown.model, effort })
                  }
                />
              </SettingsGroup>
              <AgentInstructions
                value={draft.instructions}
                disabled={false}
                onChange={(instructions) => setDraft({ ...draft, instructions })}
              />
            </>
          )}
          {settingsSection !== "identity" && (
            <RuntimeFields draft={draft} onChange={setDraft} />
          )}
          <AgentSaveButton form={form} saving={saving} disabled={!changed} />
          {settingsSection !== "identity" && settingsContent}
        </form>
      </PanelSaveFooter>
    );
  }

  return { Create, CreateModel, SettingsTab };
}
