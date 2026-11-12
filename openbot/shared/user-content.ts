/**
 * What a person said, in the shape a chat model reads. Read by both Bots.
 *
 * A message is a string until somebody attaches a file. Then the composer sends a list of parts —
 * what the person typed, then the file — and `copilot.ts` resolves each file before the run leaves
 * the server: text, image and PDF parts carry their contents. Both Bots read `content` with
 * `String()`, which for that list is
 * `[object Object],[object Object]`, so that is what the model was sent in place of the question and
 * the file both.
 *
 * ONE DECLARATION FOR BOTH BOTS, for the reason `bot-prompt.ts` gives for `NO_ANSWER_CAME`. The two
 * text/image shapes work across providers. PDF file blocks use OpenAI's Chat Completions format;
 * other providers keep the named-part fallback.
 *
 * A part neither shape can carry is NAMED, not dropped, which is the rule `resultText` in
 * `server/src/plugins/mcp.ts` follows for a tool result: a model told "[audio]" can say something was
 * attached that it cannot hear, and a model handed nothing answers as though nothing was attached.
 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export function userContent(
  content: unknown,
  provider = "openai",
): string | UserContentPart[] {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part): UserContentPart => {
    const item = (part ?? {}) as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; value?: unknown; mimeType?: unknown } | null;
      metadata?: { filename?: unknown } | null;
    };
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    const source = item.source;
    if (
      provider === "openai" &&
      item.type === "document" &&
      source?.type === "data" &&
      typeof source.value === "string" &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(source.value) &&
      typeof source.mimeType === "string" &&
      source.mimeType.trim().toLowerCase() === "application/pdf"
    ) {
      const name = item.metadata?.filename;
      return {
        type: "file",
        file: {
          filename:
            typeof name === "string" && /\.pdf$/i.test(name)
              ? name
              : "document.pdf",
          file_data: `data:application/pdf;base64,${source.value}`,
        },
      };
    }
    // The mime type reaches a `data:` URL sent to model providers. Allowlisted to images and
    // base64-shape-checked, so `text/html` (or whitespace/quotes/CRLF smuggling) and empty values
    // degrade to a named part instead of a provider payload.
    if (
      item.type === "image" &&
      source?.type === "data" &&
      typeof source.value === "string" &&
      source.value.trim() &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(source.value.replace(/\s/g, "")) &&
      typeof source.mimeType === "string" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        source.mimeType.trim().toLowerCase(),
      )
    ) {
      return {
        type: "image_url",
        image_url: {
          url: `data:${source.mimeType.trim().toLowerCase()};base64,${source.value}`,
        },
      };
    }
    const name =
      typeof item.type === "string" && item.type ? item.type : "unknown";
    return { type: "text", text: `[${name}]` };
  });
}
