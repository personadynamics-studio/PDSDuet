import { z } from "zod";
import {
  type HeadlessTool,
  HeadlessToolSuspension,
} from "@openbot/toolkit/headless-tools";
import type { ComputerGateway } from "./gateway";
import { HandoffRequestError } from "./client";
import type { ControlState } from "./schema";

/** Shared by the headless tool and the browser's registration, so both promise the same thing. */
export const SIGN_IN_TOOL_DESCRIPTION =
  "Ask the person to take over your browser and sign in to a website. Open its sign-in page first. The person enters their credentials in the browser; never ask them to send a password in chat. This turn waits until they return control.";

/** Shipped browser/file/command tools, with identity bound before the model supplies arguments. */
export function createHeadlessComputerTools(options: {
  gateway: ComputerGateway;
  botId: string;
}): HeadlessTool[] {
  const { gateway, botId } = options;
  const ref = z.string().min(1);
  const text = z.string().min(1);
  const noArgs = z.strictObject({});
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    execute: (
      input: z.output<T>,
      context: { toolCallId: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ): HeadlessTool {
    return {
      definition: { name, description, parameters: z.toJSONSchema(schema) },
      execute: async (args, context) => {
        const input = schema.parse(args);
        if (context.signal.aborted)
          throw new Error("The computer action was stopped.");
        try {
          return await execute(input, context);
        } catch (error) {
          if (!(error instanceof HandoffRequestError) || error.code !== "HUMAN_CONTROL") throw error;
          const state = await gateway.control(botId, undefined, context.signal);
          if (state.holder !== "human") return { ok: false, interrupted: true, reason: "The person took over this action and has returned control. Read the current page before continuing." };
          const handoff = state.request?.toolCallId === context.toolCallId ? state : await gateway.requestHelp(botId, "Return browser control when you have finished helping.", context.toolCallId, context.signal);
          waiting(handoff, "Waiting for the person to return browser control.");
        }
      },
    };
  }
  function waiting(
    state: ControlState,
    reason: string,
    kind = "computer_handoff",
  ): never {
    throw new HeadlessToolSuspension(reason, {
      kind,
      botId,
      ...(state.request?.toolCallId ? { toolCallId: state.request.toolCallId } : {}),
      ...(state.request
        ? { requestId: state.request.id, handoff: state.request }
        : {}),
    });
  }
  const tools = [
    tool(
      "ask_google_ai",
      "Use this when the user asks you to find information. Select your fixed Google Search AI Mode tab; repeated calls reuse it. Use your existing browser tools to ask the question and read Google's full answer and source links. Return Google's entire answer verbatim, preserving its original language, wording, paragraphs, lists and links. Do not summarize, shorten, paraphrase, translate or add your own commentary. Do not add a preamble such as 'Based on what I read with Google AI Mode'.",
      noArgs,
      async (_, { signal }) => ({
        ok: true,
        ...(await gateway.openGoogleAi(botId, signal)),
        instruction: "Use Google AI Mode in this tab. Ask the question and use your existing browser tools to read Google's full answer and source links. Return Google's entire answer verbatim, preserving its original language, wording, paragraphs, lists and links. Do not summarize, shorten, paraphrase, translate or add your own commentary or a tool-use preamble.",
      }),
    ),
    tool(
      "computer_navigate",
      "Open a web page and return its title and readable text. Use the returned content to answer.",
      z.strictObject({ url: text }),
      async ({ url }, { toolCallId, signal }) => {
        const result = await gateway.navigate(botId, url, toolCallId, signal);
        return { ok: true, ...result };
      },
    ),
    tool(
      "computer_read",
      "Read the currently open browser page without navigating.",
      noArgs,
      async (_, { signal }) => ({ ok: true, ...(await gateway.read(botId, signal)) }),
    ),
    tool(
      "computer_snapshot",
      "List fields, buttons and links with refs. Call before clicking or typing to read the current element refs.",
      noArgs,
      async (_, { signal }) => ({ ok: true, ...(await gateway.snapshot(botId, signal)) }),
    ),
    tool(
      "computer_screenshot",
      "Return an image of the browser currently open on your computer.",
      noArgs,
      async (_, { signal }) => ({ ok: true, ...(await gateway.screenshot(botId, signal)) }),
    ),
    tool(
      "computer_click",
      "Click an element using its ref from the current page.",
      z.strictObject({ ref }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.click(botId, input, signal)),
      }),
    ),
    tool(
      "computer_type",
      "Replace a field's contents using its ref. Set submit to press Enter afterwards.",
      z.strictObject({
        ref,
        text: z.string(),
        submit: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.type(botId, input, signal)),
      }),
    ),
    tool(
      "computer_key",
      "Press Enter, Tab, Escape or another key on the page.",
      z
        .strictObject({
          key: text,
          ref: ref.optional(),
        }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.key(botId, input, signal)),
      }),
    ),
    tool(
      "computer_scroll",
      "Scroll down by pixels, or up with a negative deltaY. Defaults to 600.",
      z.strictObject({ deltaY: z.number().optional() }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.scroll(botId, input, signal)),
      }),
    ),
    tool(
      "computer_list_files",
      "List files and folders in your workspace. Call first before reading an uncertain filename.",
      z.strictObject({ path: z.string().optional() }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.listFiles(botId, input, signal)),
      }),
    ),
    tool(
      "computer_read_file",
      "Read a saved file relative to your persistent workspace, such as notes.md.",
      z.strictObject({ path: text }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.readFile(botId, input, signal)),
      }),
    ),
    tool(
      "computer_write_file",
      "Save text in your workspace. Set append to add to the end of an existing file.",
      z.strictObject({
        path: text,
        contents: z.string(),
        append: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.writeFile(botId, input, signal)),
      }),
    ),
    tool(
      "computer_run_command",
      "Run a bash shell command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. For package installation use sudo apt-get; if refused say so rather than retrying.",
      z.strictObject({ command: text }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.runCommand(botId, input, signal)),
      }),
    ),
    tool(
      "computer_request_help",
      "Create a durable request for the person to take the browser and sign in or clear a challenge. This unattended turn pauses until a person helps; never ask them to send you a password.",
      z.strictObject({ reason: text }),
      async ({ reason }, { toolCallId, signal }) =>
        waiting(
          await gateway.requestHelp(botId, reason, toolCallId, signal),
          reason,
        ),
    ),
    tool(
      "computer_request_secret",
      "Ask the person to enter one secret directly into the focused field. Click the field first. You must never receive the secret; this unattended turn pauses for the person.",
      z.strictObject({ label: text, ref }),
      async (input, { signal, toolCallId }) =>
        waiting(
          await gateway.requestSecret(botId, { ...input, toolCallId }, signal),
          `The person must enter ${input.label} directly into the page.`,
          "computer_secret",
        ),
    ),
  ];
  tools.push(tool(
    "computer_request_sign_in",
    SIGN_IN_TOOL_DESCRIPTION,
    z.strictObject({ site: text, reason: z.string().optional() }),
    async ({ site, reason }, { toolCallId, signal }) => {
      const explanation = reason ?? `Please sign in to ${site} in the browser, then return control.`;
      waiting(await gateway.requestHelp(botId, explanation, toolCallId, signal), explanation);
    },
  ));
  return tools;
}
