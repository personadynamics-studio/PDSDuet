import type { AuditInitiator } from "../audit";
import { withUntrustedNotice } from "../untrusted-content";
import { ComputerUnavailableError, createComputerTransport } from "./client";
import type { ComputerProvider, ComputerUpdate } from "./provider";
import type {
  ActionResult, ClickInput, ComputerStatus, ControlState, DownloadFileInput,
  HumanInput, HumanInputResult, KeyInput, ListFilesInput, ListFilesResult,
  NavigateResult, ReadFileInput, ReadFileResult, ReadResult, RunCommandInput,
  RunCommandResult, ScreenshotResult, ScrollInput, SecretRequest, SecretResult,
  SignInCodeInput, SignInCodeResult, SignInFillInput, SignInFillResult,
  SnapshotResult, TypeInput, WriteFileInput, WriteFileResult,
} from "./schema";
export {
  ComputerUnavailableError, ElementNotFoundError, HandoffRequestError,
  WorkspaceNotFoundError, WorkspaceRefusedError,
  WorkspaceRequestError, WorkspaceTooLargeError,
} from "./client";
export type ActionActor = { id: string; userId?: string; initiator?: AuditInitiator };
export type ComputerGatewayOptions = { provider: ComputerProvider };

export interface ComputerGateway {
  readonly provider: ComputerProvider;
  locate(botId: string, signal?: AbortSignal): Promise<string>;
  status(botId: string): Promise<ComputerStatus>;
  screenshot(botId: string, signal?: AbortSignal): Promise<ScreenshotResult>;
  snapshot(botId: string, signal?: AbortSignal): Promise<SnapshotResult>;
  read(botId: string, signal?: AbortSignal): Promise<ReadResult>;
  navigate(
    botId: string,
    url: string,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<NavigateResult>;
  click(
    botId: string,
    input: ClickInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  type(
    botId: string,
    input: TypeInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  key(
    botId: string,
    input: KeyInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  scroll(
    botId: string,
    input: ScrollInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  readFile(
    botId: string,
    input: ReadFileInput,
    signal?: AbortSignal,
  ): Promise<ReadFileResult>;
  downloadFile(
    botId: string,
    input: DownloadFileInput,
    signal?: AbortSignal,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    bytes: number;
    name: string;
  }>;
  listFiles(
    botId: string,
    input: ListFilesInput,
    signal?: AbortSignal,
  ): Promise<ListFilesResult>;
  runCommand(
    botId: string,
    input: RunCommandInput,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
  writeFile(
    botId: string,
    input: WriteFileInput,
    signal?: AbortSignal,
  ): Promise<WriteFileResult>;
  control(botId: string, requestId?: string, signal?: AbortSignal): Promise<ControlState>;
  requestHelp(
    botId: string,
    reason: string,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<ControlState>;
  takeControl(
    botId: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<ControlState>;
  releaseControl(
    botId: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<ControlState>;
  cancelControl(
    botId: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<ControlState>;
  requestSecret(
    botId: string,
    input: SecretRequest,
    signal?: AbortSignal,
  ): Promise<ControlState>;
  supplySecret(
    botId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<SecretResult>;
  /** Fill and submit a login form on the Bot's current page. See passwords/service.ts. */
  signIn(
    botId: string,
    input: SignInFillInput,
    signal?: AbortSignal,
  ): Promise<SignInFillResult>;
  /** Type the verification code a site asked for after the password. See passwords/service.ts. */
  signInCode(
    botId: string,
    input: SignInCodeInput,
    signal?: AbortSignal,
  ): Promise<SignInCodeResult>;
  humanInput(botId: string, input: HumanInput, signal?: AbortSignal): Promise<HumanInputResult>;
  computers(): Promise<{
    isolation: "per-bot" | "shared";
    computers: {
      botId: string;
      running: boolean;
      startedAt: string | null;
      egress?: string | null;
      updateAvailable?: boolean;
    }[];
  }>;
  stopComputer(
    botId: string,
  ): Promise<{ wasRunning: boolean }>;
  resetComputer(
    botId: string,
  ): Promise<{ cleared: boolean }>;
  /** Move a computer onto the current image, keeping its files and sign-ins. */
  updateComputer(botId: string): Promise<ComputerUpdate>;
}

export function createComputerGateway(options: ComputerGatewayOptions): ComputerGateway {
  const { provider } = options;
  const transport = createComputerTransport({});
  return {
    provider,
    locate: (botId, signal) => provider.locate(botId, signal),
    status: (botId) => provider.status(botId),
    screenshot: async (botId, signal) => transport.call<ScreenshotResult>(await provider.locate(botId, signal), botId, "/screenshot", undefined, signal),
    async snapshot(botId, signal) {
      return withUntrustedNotice(await transport.post<SnapshotResult>(await provider.locate(botId, signal), botId, "/snapshot", {}, signal), "web page", ["title", "elements"]);
    },
    async read(botId, signal) {
      return withUntrustedNotice(await transport.call<ReadResult>(await provider.locate(botId, signal), botId, "/read", undefined, signal), "web page", ["title", "text"]);
    },
    async navigate(botId, url, toolCallId, signal) {
      const result = await transport.navigate(await provider.locate(botId, signal), botId, url, toolCallId, signal);
      return withUntrustedNotice(result, "web page", ["title", "text"]);
    },
    click: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId, signal), botId, "/click", input, signal),
    type: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId, signal), botId, "/type", input, signal),
    key: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId, signal), botId, "/key", input, signal),
    scroll: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId, signal), botId, "/scroll", input, signal),
    async readFile(botId, input, signal) {
      return withUntrustedNotice(await transport.post<ReadFileResult>(await provider.locate(botId, signal), botId, "/files/read", input, signal), "workspace file", ["text"]);
    },
    async downloadFile(botId, input, signal) {
      const download = await transport.download(await provider.locate(botId, signal), botId, `/files/download?path=${encodeURIComponent(input.path)}`, signal, 300_000);
      return { ...download, name: input.path.split(/[\\/]/).pop() || "download" };
    },
    listFiles: async (botId, input, signal) => transport.post<ListFilesResult>(await provider.locate(botId, signal), botId, "/files/list", input, signal),
    async runCommand(botId, input, signal) {
      const result = await transport.post<RunCommandResult>(await provider.locate(botId, signal), botId, "/exec", input, signal, 615_000);
      return withUntrustedNotice(result, "command output", ["stdout", "stderr"]);
    },
    writeFile: async (botId, input, signal) => transport.post<WriteFileResult>(await provider.locate(botId, signal), botId, "/files/write", input, signal),
    control: async (botId, requestId, signal) => transport.call<ControlState>(await provider.locate(botId, signal), botId, `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`, undefined, signal),
    requestHelp: async (botId, reason, toolCallId, signal) => transport.post<ControlState>(await provider.locate(botId, signal), botId, "/control/request", { reason, ...(toolCallId ? { toolCallId } : {}) }, signal),
    takeControl: async (botId, requestId, signal) => transport.post<ControlState>(await provider.locate(botId, signal), botId, "/control/take", { requestId }, signal),
    releaseControl: async (botId, requestId, signal) => transport.post<ControlState>(await provider.locate(botId, signal), botId, "/control/release", { requestId }, signal),
    cancelControl: async (botId, requestId, signal) => transport.post<ControlState>(await provider.locate(botId, signal), botId, "/control/cancel", { requestId }, signal),
    requestSecret: async (botId, input, signal) => transport.post<ControlState>(await provider.locate(botId, signal), botId, "/control/secret", input, signal),
    supplySecret: async (botId, text, signal) => transport.post<SecretResult>(await provider.locate(botId, signal), botId, "/human/secret", { text }, signal),
    signIn: async (botId, input, signal) => transport.post<SignInFillResult>(await provider.locate(botId, signal), botId, "/sign-in/fill", input, signal, 75_000),
    signInCode: async (botId, input, signal) => transport.post<SignInCodeResult>(await provider.locate(botId, signal), botId, "/sign-in/code", input, signal, 75_000),
    humanInput: async (botId, input, signal) => {
      const { kind, ...payload } = input;
      return transport.post<HumanInputResult>(await provider.locate(botId, signal), botId, `/human/${kind}`, payload, signal);
    },
    async computers() {
      const computers = await provider.list();
      return { isolation: provider.isolation, computers: computers.map((computer) => ({ botId: computer.botId, running: computer.status === "running", startedAt: computer.startedAt ?? null, egress: computer.egress, ...(computer.updateAvailable !== undefined ? { updateAvailable: computer.updateAvailable } : {}) })) };
    },
    stopComputer: (botId) => provider.stop(botId),
    async resetComputer(botId) {
      const result = await provider.reset(botId);
      return result;
    },
    async updateComputer(botId) {
      if (!provider.update) {
        throw new ComputerUnavailableError(
          `The ${provider.name} computer provider has no computer image of its own to update.`,
        );
      }
      return provider.update(botId);
    },
  };
}
