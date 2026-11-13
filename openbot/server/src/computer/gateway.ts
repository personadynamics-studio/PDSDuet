import type { AuditInitiator } from "../audit";
import { withUntrustedNotice } from "../untrusted-content";
import { ComputerUnavailableError, createComputerTransport } from "./client";
import type { PageFrameStore } from "./page-frames";
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
export type ComputerGatewayOptions = { provider: ComputerProvider; pageFrames?: PageFrameStore };

export interface ComputerGateway {
  readonly provider: ComputerProvider;
  locate(botId: string): Promise<string>;
  status(botId: string): Promise<ComputerStatus>;
  screenshot(botId: string): Promise<ScreenshotResult>;
  snapshot(botId: string): Promise<SnapshotResult>;
  read(botId: string): Promise<ReadResult>;
  navigate(
    botId: string,
    url: string,
    toolCallId?: string,
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
  ): Promise<ActionResult>;
  readFile(
    botId: string,
    input: ReadFileInput,
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
  ): Promise<ListFilesResult>;
  runCommand(
    botId: string,
    input: RunCommandInput,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
  writeFile(
    botId: string,
    input: WriteFileInput,
  ): Promise<WriteFileResult>;
  control(botId: string, requestId?: string): Promise<ControlState>;
  requestHelp(
    botId: string,
    reason: string,
    toolCallId?: string,
  ): Promise<ControlState>;
  takeControl(
    botId: string,
    requestId?: string,
  ): Promise<ControlState>;
  releaseControl(
    botId: string,
    requestId?: string,
  ): Promise<ControlState>;
  cancelControl(
    botId: string,
    requestId?: string,
  ): Promise<ControlState>;
  requestSecret(
    botId: string,
    input: SecretRequest,
  ): Promise<ControlState>;
  supplySecret(
    botId: string,
    text: string,
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
  humanInput(botId: string, input: HumanInput): Promise<HumanInputResult>;
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
  const { provider, pageFrames } = options;
  const transport = createComputerTransport({});
  return {
    provider,
    locate: (botId) => provider.locate(botId),
    status: (botId) => provider.status(botId),
    screenshot: async (botId) => transport.call<ScreenshotResult>(await provider.locate(botId), botId, "/screenshot"),
    async snapshot(botId) {
      return withUntrustedNotice(await transport.post<SnapshotResult>(await provider.locate(botId), botId, "/snapshot", {}), "web page", ["title", "elements"]);
    },
    async read(botId) {
      return withUntrustedNotice(await transport.call<ReadResult>(await provider.locate(botId), botId, "/read"), "web page", ["title", "text"]);
    },
    async navigate(botId, url, toolCallId) {
      const result = await transport.navigate(await provider.locate(botId), botId, url, toolCallId);
      return withUntrustedNotice(result, "web page", ["title", "text"]);
    },
    click: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId), botId, "/click", input, signal),
    type: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId), botId, "/type", input, signal),
    key: async (botId, input, signal) => transport.post<ActionResult>(await provider.locate(botId), botId, "/key", input, signal),
    scroll: async (botId, input) => transport.post<ActionResult>(await provider.locate(botId), botId, "/scroll", input),
    async readFile(botId, input) {
      return withUntrustedNotice(await transport.post<ReadFileResult>(await provider.locate(botId), botId, "/files/read", input), "workspace file", ["text"]);
    },
    async downloadFile(botId, input, signal) {
      const download = await transport.download(await provider.locate(botId), botId, `/files/download?path=${encodeURIComponent(input.path)}`, signal, 300_000);
      return { ...download, name: input.path.split(/[\\/]/).pop() || "download" };
    },
    listFiles: async (botId, input) => transport.post<ListFilesResult>(await provider.locate(botId), botId, "/files/list", input),
    async runCommand(botId, input, signal) {
      const result = await transport.post<RunCommandResult>(await provider.locate(botId), botId, "/exec", input, signal, 615_000);
      return withUntrustedNotice(result, "command output", ["stdout", "stderr"]);
    },
    writeFile: async (botId, input) => transport.post<WriteFileResult>(await provider.locate(botId), botId, "/files/write", input),
    control: async (botId, requestId) => transport.call<ControlState>(await provider.locate(botId), botId, `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`),
    requestHelp: async (botId, reason, toolCallId) => transport.post<ControlState>(await provider.locate(botId), botId, "/control/request", { reason, ...(toolCallId ? { toolCallId } : {}) }),
    takeControl: async (botId, requestId) => transport.post<ControlState>(await provider.locate(botId), botId, "/control/take", { requestId }),
    releaseControl: async (botId, requestId) => transport.post<ControlState>(await provider.locate(botId), botId, "/control/release", { requestId }),
    cancelControl: async (botId, requestId) => transport.post<ControlState>(await provider.locate(botId), botId, "/control/cancel", { requestId }),
    requestSecret: async (botId, input) => transport.post<ControlState>(await provider.locate(botId), botId, "/control/secret", input),
    supplySecret: async (botId, text) => transport.post<SecretResult>(await provider.locate(botId), botId, "/human/secret", { text }),
    signIn: async (botId, input, signal) => transport.post<SignInFillResult>(await provider.locate(botId), botId, "/sign-in/fill", input, signal, 75_000),
    signInCode: async (botId, input, signal) => transport.post<SignInCodeResult>(await provider.locate(botId), botId, "/sign-in/code", input, signal, 75_000),
    humanInput: async (botId, input) => {
      const { kind, ...payload } = input;
      return transport.post<HumanInputResult>(await provider.locate(botId), botId, `/human/${kind}`, payload);
    },
    async computers() {
      const computers = await provider.list();
      return { isolation: provider.isolation, computers: computers.map((computer) => ({ botId: computer.botId, running: computer.status === "running", startedAt: computer.startedAt ?? null, egress: computer.egress, ...(computer.updateAvailable !== undefined ? { updateAvailable: computer.updateAvailable } : {}) })) };
    },
    stopComputer: (botId) => provider.stop(botId),
    async resetComputer(botId) {
      const result = await provider.reset(botId);
      await pageFrames?.clear(botId);
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
