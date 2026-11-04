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
import type { ModelList } from "./models";
import { type Config, config as readConfig, DEFAULT_CONFIG } from "./runtime";

/** The empty model choice: OpenCode's own config picks the model. */
const DEFAULT_MODEL_LABEL = "OpenCode default";
const RESET_LABEL = "Use OpenCode default";
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

type Read<T> =
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T };

/** `read()` as it settles, read again on `retry`; a shown value stays while
 * it is read again. (As buzz-app's Goose tabs read goose's lists.) */
function useRead<T>(read: () => Promise<T>) {
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
  }, [round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

export function createViews(models: ModelList) {
  /** OpenCode's models as the picker lists them. OpenCode has no thinking
   * levels over ACP, so no model offers efforts. */
  function useChoices() {
    const [list, retry] = useRead(() => models.ids());
    const choices: ModelChoice[] = (list.value ?? []).map((id) => ({
      id,
      label: id,
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
          value={current.model}
          defaultLabel={DEFAULT_MODEL_LABEL}
          disabled={disabled}
          loading={list.status === "loading"}
          onChange={(model) => onChange({ ...current, model })}
        />
      </ModelDiscoveryRecovery>
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
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
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
          model: draft.model.trim(),
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
                  value={draft.model}
                  onChange={(model) => setDraft({ ...draft, model })}
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
            <>
              <Field label="Workspace" description={WORKSPACE_HELP}>
                <Input
                  value={draft.workspace}
                  onValueChange={(workspace) => setDraft({ ...draft, workspace })}
                />
              </Field>
              <Select
                label="Sessions"
                variant="preference"
                value={draft.scope}
                groups={SCOPES}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    scope: value === "channel" ? "channel" : "thread",
                  })
                }
              />
            </>
          )}
          <AgentSaveButton form={form} saving={saving} disabled={!changed} />
          {settingsSection !== "identity" && settingsContent}
        </form>
      </PanelSaveFooter>
    );
  }

  return { Create, CreateModel, SettingsTab };
}
