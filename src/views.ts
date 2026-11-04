// The OpenCode agent type's parts of the app's screens: the New agent dialog
// and the Settings tab. An installed plugin cannot import the app's React or
// design system, so these take the app's React from `ctx.react` and render the
// element and class names of the app's own fields (shared/design-system/ui:
// Field, Input, Textarea, Button), whose CSS is global in the app.
import type {
  AgentCreateProps,
  AgentViewProps,
} from "@buzz/features/agents/service";
import type { ModelList } from "./models";
import { type Config, config } from "./runtime";

type ReactLike = typeof import("react");

/** The empty model choice: OpenCode's own config picks the model. */
const DEFAULT_MODEL_LABEL = "OpenCode default";
const SCOPES = [
  { value: "thread", label: "Each thread is its own session" },
  { value: "channel", label: "The whole channel is one session" },
] as const;
const LABELS = {
  model: "Model",
  instructions: "Instructions",
  workspace: "Workspace",
  scope: "Sessions",
  save: "Save",
  saving: "Saving…",
  saved: "Saved.",
  loading: "Loading OpenCode models…",
  workspaceHelp:
    "The folder OpenCode works in. OpenCode reads, writes and runs commands there as you, with no approval step.",
} as const;

/** What a model list read gives a view. */
type ListState =
  | { status: "loading" }
  | { status: "ready"; ids: readonly string[] }
  | { status: "error"; message: string };

export function createViews(React: ReactLike, models: ModelList) {
  const h = React.createElement;

  /** OpenCode's model list, read when a view opens. */
  function useModels(): ListState {
    const [state, setState] = React.useState<ListState>({ status: "loading" });
    React.useEffect(() => {
      let live = true;
      models.ids().then(
        (ids) => live && setState({ status: "ready", ids }),
        (error: unknown) =>
          live &&
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
      return () => {
        live = false;
      };
    }, []);
    return state;
  }

  function Field(
    props: Readonly<{
      label: string;
      description?: string;
      error?: string;
      children: (id: string) => ReturnType<typeof h>;
    }>,
  ) {
    const id = React.useId();
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { htmlFor: id, className: "buzz-field-label" }, props.label),
      props.children(id),
      props.description
        ? h("p", { className: "buzz-field-description" }, props.description)
        : null,
      props.error
        ? h("p", { role: "alert", className: "buzz-field-error" }, props.error)
        : null,
    );
  }

  /** A model menu from OpenCode's list. The saved model stays a choice even
   * when OpenCode no longer lists it; with no list, it is typed in. */
  function ModelField(
    props: Readonly<{
      value: string;
      disabled: boolean;
      onChange(model: string): void;
    }>,
  ) {
    const list = useModels();
    if (list.status === "loading")
      return h(
        "p",
        { role: "status", className: "m-0 text-body-sm text-secondary" },
        LABELS.loading,
      );
    if (list.status === "error")
      return h(Field, {
        label: LABELS.model,
        error: list.message,
        description: "Type a model as provider/model, or leave it empty.",
        children: (id) =>
          h("input", {
            id,
            "data-buzz-ui": "",
            className: "buzz-input",
            value: props.value,
            disabled: props.disabled,
            placeholder: DEFAULT_MODEL_LABEL,
            onChange: (event: { target: { value: string } }) =>
              props.onChange(event.target.value.trim()),
          }),
      });
    const ids =
      props.value && !list.ids.includes(props.value)
        ? [props.value, ...list.ids]
        : list.ids;
    return h(Field, {
      label: LABELS.model,
      children: (id) =>
        h(
          "select",
          {
            id,
            "data-buzz-ui": "",
            className: "buzz-input",
            value: props.value,
            disabled: props.disabled,
            onChange: (event: { target: { value: string } }) =>
              props.onChange(event.target.value),
          },
          h("option", { value: "" }, DEFAULT_MODEL_LABEL),
          ...ids.map((model) => h("option", { key: model, value: model }, model)),
        ),
    });
  }

  function InstructionsField(
    props: Readonly<{
      value: string;
      disabled: boolean;
      onChange(text: string): void;
    }>,
  ) {
    return h(Field, {
      label: LABELS.instructions,
      children: (id) =>
        h("textarea", {
          id,
          "data-buzz-ui": "",
          className: "buzz-textarea",
          rows: 6,
          value: props.value,
          disabled: props.disabled,
          onChange: (event: { target: { value: string } }) =>
            props.onChange(event.target.value),
        }),
    });
  }

  /** The model row of the New agent dialog. */
  function CreateModel(props: AgentCreateProps<Config>) {
    const current = config(props.config);
    return h(ModelField, {
      value: current.model,
      disabled: props.disabled,
      onChange: (model) => props.onChange({ ...current, model }),
    });
  }

  /** The rest of the New agent dialog: the instructions. The workspace and
   * sessions keep their defaults and change in Settings, as the app's own
   * agents do. */
  function Create(props: AgentCreateProps<Config>) {
    const current = config(props.config);
    return h(InstructionsField, {
      value: current.instructions,
      disabled: props.disabled,
      onChange: (instructions) => props.onChange({ ...current, instructions }),
    });
  }

  /** Every setting of an OpenCode agent, saved together. */
  function SettingsTab(props: AgentViewProps<Config>) {
    const saved = config(props.agent.config);
    const [draft, setDraft] = React.useState<Config>(saved);
    const [state, setState] = React.useState<
      { status: "idle" | "saving" | "saved" } | { status: "error"; message: string }
    >({ status: "idle" });
    const set = (patch: Partial<Config>) => {
      setDraft({ ...draft, ...patch });
      setState({ status: "idle" });
    };
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
    const busy = state.status === "saving";
    const save = async () => {
      setState({ status: "saving" });
      try {
        // The whole config, so fields other views keep are not erased.
        await props.save({ ...props.agent.config, ...draft });
        setState({ status: "saved" });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    return h(
      "form",
      {
        className: "grid gap-4",
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault();
          if (changed && !busy) void save();
        },
      },
      h(ModelField, {
        value: draft.model,
        disabled: busy,
        onChange: (model) => set({ model }),
      }),
      h(InstructionsField, {
        value: draft.instructions,
        disabled: busy,
        onChange: (instructions) => set({ instructions }),
      }),
      h(Field, {
        label: LABELS.workspace,
        description: LABELS.workspaceHelp,
        children: (id) =>
          h("input", {
            id,
            "data-buzz-ui": "",
            className: "buzz-input",
            value: draft.workspace,
            disabled: busy,
            onChange: (event: { target: { value: string } }) =>
              set({ workspace: event.target.value }),
          }),
      }),
      h(Field, {
        label: LABELS.scope,
        children: (id) =>
          h(
            "select",
            {
              id,
              "data-buzz-ui": "",
              className: "buzz-input",
              value: draft.scope,
              disabled: busy,
              onChange: (event: { target: { value: string } }) =>
                set({ scope: event.target.value as Config["scope"] }),
            },
            ...SCOPES.map((scope) =>
              h("option", { key: scope.value, value: scope.value }, scope.label),
            ),
          ),
      }),
      h(
        "div",
        { className: "flex items-center gap-3" },
        h(
          "button",
          {
            type: "submit",
            "data-buzz-ui": "",
            className: "buzz-button",
            "data-variant": "prominent",
            "data-size": "md",
            "data-button-shape": "capsule",
            disabled: !changed || busy || !draft.workspace.trim(),
          },
          h(
            "span",
            { className: "buzz-button-label" },
            busy ? LABELS.saving : LABELS.save,
          ),
        ),
        state.status === "saved"
          ? h(
              "span",
              { role: "status", className: "text-body-sm text-secondary" },
              LABELS.saved,
            )
          : null,
        state.status === "error"
          ? h(
              "span",
              { role: "alert", className: "text-body-sm text-danger" },
              state.message,
            )
          : null,
      ),
    );
  }

  return { Create, CreateModel, SettingsTab };
}
