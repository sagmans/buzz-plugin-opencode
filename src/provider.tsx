// The OpenCode row of the app's agent settings, and its dialog: whether OpenCode
// is installed and answers, its version, its default model and its models.
// Laid out as buzz-app's Goose type lays out its own (src/bundled/goose/tabs.tsx,
// Apache-2.0, see NOTICE), but read-only: OpenCode keeps its logins and default
// model in its own config, and this plugin neither holds nor writes them.
import { useEffect, useSyncExternalStore } from "react";
import { ProviderDialogActions } from "@buzz/features/agents/ProviderDialogActions";
import type { AgentProvider } from "@buzz/features/agents/service";
import { Button } from "@buzz/shared/design-system/ui/Button";
import type { OpenCodeSetup } from "./setup";

/** What the row shows when OpenCode's config names no default model. */
const DEFAULT_MODEL_LABEL = "OpenCode default";
/** A catalog can list hundreds of models: the dialog scrolls them. As an inline
 * style, as the app's stylesheet has only the classes the app itself uses. */
const MODEL_LIST_STYLE = { maxHeight: 240, overflow: "auto", margin: 0 } as const;

export function createProvider(setup: OpenCodeSetup): AgentProvider {
  /** Follows the check's state, so a new finding shows at once. */
  const useCheck = () =>
    useSyncExternalStore(setup.subscribe, setup.snapshot, setup.snapshot);

  /** Read-only: a button, as the app returns focus to the row's button. */
  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    useCheck();
    return (
      <Button size="sm" onClick={onConfigure}>
        {setup.status()?.defaultModel || DEFAULT_MODEL_LABEL}
      </Button>
    );
  }

  function DialogBody({ onClose }: { onClose(): void }) {
    const { readiness } = useCheck();
    const status = setup.status();
    const checking = readiness === "checking";
    // The app checks when its settings open; a dialog routed to directly may
    // open with no check started.
    useEffect(() => {
      if (!setup.status()) void setup.check();
    }, []);
    return (
      <div className="grid gap-4">
        {status ? (
          <>
            <p className="m-0 text-body-sm">
              Installed:{" "}
              {status.installed
                ? `Yes${status.version ? `, version ${status.version}` : ""}`
                : "No"}
            </p>
            <p className="m-0 text-body-sm">
              Reachable: {status.reachable ? "Yes" : "No"}
            </p>
            {status.defaultModel && (
              <p className="m-0 text-body-sm">
                Default model: {status.defaultModel}
              </p>
            )}
            {status.problem && <p role="alert">{status.problem}</p>}
            {status.models.length > 0 && (
              <div className="grid gap-2">
                <p className="m-0 text-body-sm">
                  Models: {status.models.length}
                </p>
                <ul className="text-body-sm" style={MODEL_LIST_STYLE}>
                  {status.models.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p role="status">Checking OpenCode…</p>
        )}
        <p className="m-0 text-body-sm text-subtle">
          OpenCode keeps its own logins and default model. Change them with{" "}
          <code>opencode auth login</code> and OpenCode's config.
        </p>
        <ProviderDialogActions>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={checking}
            loading={checking}
            onClick={() => void setup.recheck()}
          >
            Check again
          </Button>
        </ProviderDialogActions>
      </div>
    );
  }

  // The smoke run has no DOM to press "Check again" in, so it reads what the
  // button runs through the provider.
  return Object.assign(
    {
      snapshot: setup.snapshot,
      subscribe: setup.subscribe,
      check: setup.check,
      DialogBody,
      DefaultControl,
    },
    { recheck: setup.recheck },
  );
}
