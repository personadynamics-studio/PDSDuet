import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_HARNESS,
  type HarnessChoice,
  HarnessPicker,
} from "./HarnessPicker";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import { Welcome } from "./Welcome";

type Blocker =
  | "wsl-absent"
  | "wsl-one"
  | "virtual-machine-platform-disabled"
  | "virtualization-disabled"
  | "not-administrator";

type Progress = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
};

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
  harness: HarnessChoice | null;
};

export function App() {
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [blockerFailure, setBlockerFailure] = useState<Problem | null>(null);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  /*
   * Which Bot and which model, as two separate answers.
   *
   * Held here rather than inside the screens so going Back does not lose what was already chosen:
   * the flow is resumable at the screen it stopped on, and a wizard that asks twice is one nobody
   * finishes. `null` means not answered yet, which is what decides the screen below.
   */
  const [harness, setHarness] = useState<HarnessChoice | null>({
    id: DEFAULT_HARNESS,
  });
  const [model, setModel] = useState<ModelChoice | null>(null);
  /** Model credentials a previous run already wrote, so the provider screen arrives filled in. */
  const [alreadyHeld, setAlreadyHeld] = useState<HeldConfiguration>({});
  const [step, setStep] = useState<"welcome" | "harness" | "install" | "model" | "ready">("welcome");
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [checkingResume, setCheckingResume] = useState(true);
  const [running, setRunning] = useState(false);
  const configuredRunRef = useRef(0);
  /*
   * A failure, in both registers.
   *
   * `said` is what a person reads and `detail` is the real output, kept behind a disclosure. One
   * string could not serve both: the plain sentence alone throws away the evidence, and the raw
   * engine output alone is how "pull access denied ... may require 'docker login'" ended up as the
   * headline on a setup screen. See `problem.rs`.
   */
  const [failure, setFailure] = useState<Problem | null>(null);
  // A supervisor notice belongs to the interrupted run, not to the form being hydrated.
  const [recoveryFailure, setRecoveryFailure] = useState<Problem | null>(null);
  const recoverFromStart = useCallback((error: unknown) => {
    const problem = asProblem(error);
    setSteps((current) => settleProgress(current, problem));
    setRecoveryFailure(problem);
    if (problem.connection === "model") setStep("model");
  }, []);
  const displayedFailure = failure ?? recoveryFailure;
  const clearRootScopedSavedState = useCallback(() => {
    setAlreadyHeld({});
  }, []);

  const loadConfiguredRoot = useCallback(
    async (nextRoot: string) => {
      const trimmedRoot = nextRoot.trim();
      const run = configuredRunRef.current + 1;
      configuredRunRef.current = run;
      clearRootScopedSavedState();
      if (!trimmedRoot) return;
      try {
        const configured = await invoke<AlreadyConfigured>(
          "already_configured",
          { root: trimmedRoot },
        );
        if (configuredRunRef.current !== run) return;
        const { values, saved } = configured;
        setAlreadyHeld({ ...values, saved });
        return configured;
      } catch {
        if (configuredRunRef.current === run) {
          setAlreadyHeld({});
        }
      }
    },
    [clearRootScopedSavedState],
  );

  useEffect(() => {
    let active = true;
    const windowsReady = invoke<Blocker | null>("windows_blocker")
      .then(async (found) => {
        setBlocker(found);
        if (found) {
          setInstruction(
            await invoke<string>("windows_blocker_instruction", {
              blocker: found,
            }),
          );
        }
        return found === null;
      })
      .catch((error) => {
        setBlockerFailure(asProblem(error));
        return false;
      });
    // A supervisor that stopped retrying must stay stopped when it returns to this window.
    const interruptedRun = invoke<Problem | null>("last_failure")
      .then((found) => {
        if (found) setRecoveryFailure(found);
        return found;
      })
      .catch(() => null);
    Promise.all([
      invoke<string | null>("selected_root").catch(() => null),
      invoke<string>("default_root"),
      windowsReady,
      interruptedRun,
    ])
      .then(async ([selected, fallback, canResume, interrupted]) => {
        if (!active) return;
        const found = selected || fallback;
        setRoot(found);
        /*
         * Arrive filled in when a previous run already wrote these.
         *
         * The alternative is asking somebody to find a key again, and "find it again" means opening
         * a dotfile in a text editor — the exact thing this product exists not to require. Their own
         * file, read back to them on their own machine.
         */
        const configured = await loadConfiguredRoot(found);
        if (!active) return;
        setHarness(configured?.harness ?? null);
        const resumedModel = configured
          ? recordedModel({
              ...configured.values,
              saved: configured.saved,
            })
          : null;
        if (resumedModel) {
          setModel(resumedModel);
          setStep("ready");
        }
        if (interrupted) recoverFromStart(interrupted);
        // A stack this app started may still be up from a previous window. Ask, rather than
        // offering to set up something that is already running.
        if (
          await invoke<boolean>("already_running", { root: found }).catch(
            () => false,
          )
        ) {
          // Already up from a previous window: show it, rather than a screen about it.
          await invoke("show_openbot");
          setRunning(true);
          return;
        }
        if (!active || !canResume || !configured || !resumedModel) return;
        setBusy(true);
        setResuming(true);
        try {
          await invoke("start_stack", {
            root: found,
            model: resumedModel,
            harness: configured.harness,
          });
          if (!active) return;
          setSteps((current) => settleProgress(current));
          setRunning(true);
          setRecoveryFailure(null);
          await invoke("show_openbot");
        } catch (error) {
          if (active) recoverFromStart(error);
        } finally {
          if (active) {
            setBusy(false);
            setResuming(false);
          }
        }
      })
      .catch((error) => {
        if (active) recoverFromStart(error);
      })
      .finally(() => {
        if (active) setCheckingResume(false);
      });
    const stop = listen<Progress>("setup:progress", (event) => {
      // One row per step, updated in place. A step that reports twice is the same step saying
      // more, and a list that grows a line each time reads as a log rather than as progress.
      setSteps((current) => {
        const at = current.findIndex(
          (step) => step.step === event.payload.step,
        );
        if (at === -1) return [...current, event.payload];
        const next = [...current];
        next[at] = event.payload;
        return next;
      });
    });
    return () => {
      active = false;
      stop.then((unlisten) => unlisten());
    };
  }, [loadConfiguredRoot, recoverFromStart]);

  async function install() {
    if (busy || !root.trim()) return;
    setBusy(true);
    setFailure(null);
    setSteps([
      {
        step: "engine",
        ok: true,
        running: true,
        detail: "Checking the software OpenBot needs.",
      },
    ]);
    try {
      await invoke("prepare_installation", { root: root.trim(), harness });
      setSteps((current) => settleProgress(current));
      setStep("model");
    } catch (error) {
      const problem = asProblem(error);
      setSteps((current) => settleProgress(current, problem));
      setFailure(problem);
    } finally {
      setBusy(false);
    }
  }

  async function start(nextModel = model) {
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("start_stack", {
        root: root.trim(),
        // The whole answer from the model screen, so the Rust side decides which keys that
        // implies. Sending a bare key here is what made `ANTHROPIC_API_KEY` and a plan token
        // expressible at the same time.
        model: nextModel,
        // By id only. The image, the port and how it is dialled are facts about the harness, and
        // the window carrying them would be a second list to keep in step with the catalogue.
        harness,
      });
      setSteps((current) => settleProgress(current));
      setRunning(true);
      setRecoveryFailure(null);
      setStep("ready");
      await invoke("show_openbot");
    } catch (error) {
      recoverFromStart(error);
    } finally {
      setBusy(false);
    }
  }

  function modelCanStart() {
    if (!model) return false;
    if (!model.saved) return true;
    if (model.provider === "google" || model.provider === "xai") {
      return model.login === "oauth" && Boolean(model.model?.trim());
    }
    if (model.provider === "openai-compatible") {
      return (
        model.login === "endpoint" &&
        isHttpEndpointUrl(model.baseUrl ?? "") &&
        Boolean(model.model?.trim())
      );
    }
    if (model.provider !== "openai" && model.provider !== "anthropic") {
      return false;
    }
    return model.login === "plan" || model.login === "api-key";
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("ready");
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  // Nothing else on this screen can be done until the machine allows it, so nothing else is shown.
  if (blockerFailure) {
    return (
      <main>
        <h1>OpenBot could not check Windows setup</h1>
        <Failure problem={blockerFailure} />
      </main>
    );
  }

  if (blocker) {
    return (
      <main>
        <h1>OpenBot needs one thing first</h1>
        <div className="blocker">
          <h2>{titleFor(blocker)}</h2>
          <p>{instruction}</p>
        </div>
      </main>
    );
  }

  if (resuming || checkingResume) {
    return (
      <main>
        <h1>{resuming ? "Starting OpenBot" : "Opening OpenBot"}</h1>
        <p role="status">
          {resuming
            ? "Opening your saved setup…"
            : "Checking your saved setup…"}
        </p>
        <SetupProgress steps={steps} />
      </main>
    );
  }

  /*
   * Install local software before showing either sign-in. A completed installation is retained
   * while somebody changes or retries their connection; changing its folder or Bot invalidates it.
   *
   * Skipped entirely when a stack is already up: somebody returning to a running OpenBot is not
   * setting one up, and asking them to pick a Bot again would be the wizard asking twice.
   */
  if (!running && step === "welcome") {
    return (
      <main>
        <Welcome onStart={() => setStep("harness")} />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && step === "harness") {
    return (
      <main>
        <HarnessPicker
          chosen={harness}
          onChoose={(choice) => {
            if (
              choice.id !== harness?.id ||
              choice.agentUrl !== harness?.agentUrl
            ) {
              setSteps([]);
            }
            setHarness(choice);
          }}
          onContinue={() => {
            setHarness((choice) =>
              choice?.id === "byo-url"
                ? { ...choice, agentUrl: choice.agentUrl?.trim() }
                : choice,
            );
            setStep("install");
          }}
          onBack={() => setStep("welcome")}
        />
      </main>
    );
  }

  if (!running && step === "install") {
    return (
      <main>
        <div className="sheet">
          <p className="steps-of">Step 2 of 4</p>
          <h1>Install OpenBot</h1>
          <p className="lede">Install the local software, then connect your accounts.</p>
          <div className="field">
            <label htmlFor="root">Where OpenBot lives</label>
            <input
              id="root"
              disabled={busy}
              value={root}
              onChange={(event) => {
                configuredRunRef.current += 1;
                setRoot(event.target.value);
                setModel(null);
                setSteps([]);
                clearRootScopedSavedState();
              }}
              onBlur={(event) => loadConfiguredRoot(event.target.value)}
              spellCheck={false}
            />
          </div>
          <SetupProgress steps={steps} />
          {displayedFailure && <Failure problem={displayedFailure} />}
          {busy && <p role="status">Installing local software…</p>}
          <div className="row">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setStep("harness")}
            >
              Back
            </button>
            <button type="button" disabled={busy || !root.trim()} onClick={install}>
              {busy ? "Installing…" : "Install OpenBot"}
            </button>
            <button type="button" disabled={busy} onClick={() => setStep("model")}>
              Continue to sign in
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!running && step === "model") {
    return (
      <main>
        <ProviderPicker
          held={alreadyHeld}
          root={root}
          chosen={model}
          busy={busy}
          onChoose={(choice) => {
            setModel(choice);
            setStep("ready");
          }}
          onBack={() => {
            setSteps([]);
            setStep("install");
          }}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  return (
    <main>
      <div className="sheet connection-sheet">
        {!running && (
          <p className="steps-of">Step 4 of 4</p>
        )}
        <h1>
          {running && !displayedFailure
            ? "OpenBot is running"
            : "Start OpenBot"}
        </h1>
        <p className="lede">
          {running && !displayedFailure
            ? "The stack is up. OpenBot is in this window; the menu bar has it too, and stops it."
            : "Your conversations and progress are stored in the local PostgreSQL database."}
        </p>

        <SetupProgress steps={steps} />

        {displayedFailure && <Failure problem={displayedFailure} />}

        {!running && (
          <details>
            <summary>Installation options</summary>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => {
                setSteps([]);
                setStep("install");
              }}
            >
              Change installation
            </button>
          </details>
        )}
        <div className="row">
          {!running && (
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setStep("model")}
            >
              Back
            </button>
          )}
          {running ? (
            <>
              <button
                type="button"
                onClick={() =>
                  invoke("show_openbot").catch((error) =>
                    recoverFromStart(error),
                  )
                }
              >
                Show OpenBot
              </button>
              <button
                type="button"
                className="quiet"
                onClick={stop}
                disabled={busy}
              >
                Stop OpenBot
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => start()}
              // The model is answered by its own screen now, so what is checked here is that it was
              // answered at all, not that some field on this screen is non-empty.
              disabled={
                busy ||
                !modelCanStart() ||
                root.trim() === ""
              }
            >
              {busy ? "Working…" : "Start OpenBot"}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function settleProgress(steps: Progress[], problem?: Problem): Progress[] {
  return steps.map((step) =>
    step.running
      ? {
          ...step,
          running: false,
          ok: !problem,
          detail: problem?.said ?? "Finished.",
        }
      : step,
  );
}

function SetupProgress({ steps }: { steps: Progress[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label="Setup progress" aria-live="polite">
      {steps.map((step) => (
        <SetupProgressRow key={step.step} step={step} />
      ))}
    </ol>
  );
}

function SetupProgressRow({ step }: { step: Progress }) {
  const [elapsed, setElapsed] = useState(0);
  const running = step.running ?? false;
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {running ? <span className="step-spinner" /> : step.ok ? "✓" : "✗"}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span className="step-status">
        {running ? "In progress" : step.ok ? "Complete" : "Failed"}
        {running && (
          <span className="step-elapsed" aria-hidden="true" aria-live="off">
            {" · "}
            {elapsed < 60
              ? `${elapsed}s`
              : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}{" "}
            elapsed
          </span>
        )}
      </span>
      <span className="detail">
        {step.detail}
        {step.downloadBytes != null &&
          ` ${formatDownloadBytes(step.downloadBytes)} downloaded.`}
      </span>
    </li>
  );
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1000 ** power).toFixed(1)} ${units[power - 1]}`;
}

function titleFor(blocker: Blocker): string {
  switch (blocker) {
    case "wsl-absent":
      return "Windows Subsystem for Linux is not installed";
    case "wsl-one":
      return "Windows Subsystem for Linux is at version 1";
    case "virtual-machine-platform-disabled":
      return "Virtual Machine Platform is switched off";
    case "virtualization-disabled":
      return "Virtualization is off in this machine's firmware";
    case "not-administrator":
      return "This account cannot install Windows components";
  }
}

function label(step: string): string {
  switch (step) {
    case "engine":
    case "install-engine":
      return "Container engine";
    case "create-machine":
      return "Engine machine";
    case "start-machine":
      return "Starting the machine";
    case "health-gate":
      return "Engine answering";
    case "deployment":
      return "Deployment";
    case "env":
      return "Settings";
    case "ports":
      return "Ports";
    case "dependencies":
      return "Dependencies";
    case "images":
      return "Local software";
    case "installation":
      return "Installation";
    case "answering":
      return "Answering";
    case "services":
      return "Containers";
    case "migrate":
      return "Database";
    default:
      return step;
  }
}
