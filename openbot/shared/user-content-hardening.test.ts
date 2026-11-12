import { describe, expect, test } from "bun:test";
import { userContent } from "./user-content";

const png = Buffer.from([137, 80, 78, 71]).toString("base64");

describe("userContent PDF files", () => {
  const data = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
  const pdf = {
    type: "document",
    source: { type: "data", value: data, mimeType: "application/pdf" },
    metadata: { filename: "plan.pdf" },
  };

  test("sends original PDF bytes and filename as an OpenAI file part", () => {
    expect(userContent([pdf])).toEqual([
      {
        type: "file",
        file: {
          filename: "plan.pdf",
          file_data: `data:application/pdf;base64,${data}`,
        },
      },
    ]);
  });

  test("uses a PDF filename when no usable filename was supplied", () => {
    const result = userContent([{ ...pdf, metadata: null }]);
    expect(result).toEqual([
      {
        type: "file",
        file: {
          filename: "document.pdf",
          file_data: `data:application/pdf;base64,${data}`,
        },
      },
    ]);
  });

  test.each(["", "not-base64!", "data:application/pdf;base64,abcd"])(
    "does not turn an invalid inline value into a provider file: %p",
    (value) => {
      expect(
        userContent([{ ...pdf, source: { ...pdf.source, value } }]),
      ).toEqual([{ type: "text", text: "[document]" }]);
    },
  );

  test("does not treat a different MIME type as PDF", () => {
    expect(
      userContent([
        { ...pdf, source: { ...pdf.source, mimeType: "text/html" } },
      ]),
    ).toEqual([{ type: "text", text: "[document]" }]);
  });

  test.each(["anthropic", "google"])(
    "keeps the previous fallback for %s",
    (provider) => {
      expect(userContent([pdf], provider)).toEqual([
        { type: "text", text: "[document]" },
      ]);
    },
  );
});

/**
 * The mime type reaches a `data:` URL sent to model providers with no allowlist, and the value
 * with no shape check. `text/html`, smuggling whitespace, and empty values now degrade to a
 * named part instead of a provider payload.
 */
describe("userContent image hardening", () => {
  test("passes an allowlisted png through", () => {
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: png, mimeType: "image/png" },
        },
      ]),
    ).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
    ]);
  });

  test.each([["text/html"], ["application/javascript"], ["text/plain"]])(
    "names a %s attachment instead of sending it",
    (mimeType) => {
      expect(
        userContent([
          {
            type: "image",
            source: { type: "data", value: png, mimeType },
          },
        ]),
      ).toEqual([{ type: "text", text: "[image]" }]);
    },
  );

  test("names an empty value instead of sending it", () => {
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: "   ", mimeType: "image/png" },
        },
      ]),
    ).toEqual([{ type: "text", text: "[image]" }]);
  });

  test("normalises a padded, upper-case mime type", () => {
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: png, mimeType: "  IMAGE/JPEG  " },
        },
      ]),
    ).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${png}` },
      },
    ]);
  });
});
