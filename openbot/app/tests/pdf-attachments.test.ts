import { describe, expect, test } from "bun:test";
import { FILE_PICKER_ACCEPT } from "@/components/channels/composer/attachments";
import { screenPickedFiles } from "@/components/channels/composer/picked-files";
import { classifyAttachment } from "@/lib/channels/attachments";
import { sniffMimeType } from "../../server/src/channels/attachment-mime";
import { resolveAttachmentParts } from "../../server/src/channels/attachment-parts";

const pdf = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
);
const pdfLimit = 8 * 1024 * 1024;

describe("PDF attachments", () => {
  test("offers PDFs to the iPhone file picker by MIME type and extension", () => {
    expect(FILE_PICKER_ACCEPT.split(",")).toContain("application/pdf");
    expect(FILE_PICKER_ACCEPT.split(",")).toContain(".pdf");
    expect(classifyAttachment("application/pdf")).toBe("document");
  });

  test("accepts a PDF above the plain-text ceiling but below the PDF ceiling", () => {
    const file = new File([new Uint8Array(2 * 1024 * 1024)], "report.pdf", {
      type: "application/pdf",
    });
    const result = screenPickedFiles([file], { alreadyStaged: 0 });
    expect(result.accepted).toEqual([file]);
    expect(result.rejected).toEqual([]);
  });

  test("rejects an oversized PDF with a size error", () => {
    const file = new File([new Uint8Array(pdfLimit + 1)], "large.pdf", {
      type: "application/pdf",
    });
    const result = screenPickedFiles([file], { alreadyStaged: 0 });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/too large/);
  });

  test("recognizes PDF bytes even when the device gives no useful MIME type", () => {
    for (const claim of ["", "application/octet-stream", "text/plain"]) {
      expect(sniffMimeType(pdf, claim)).toBe("application/pdf");
    }
  });

  test("does not accept arbitrary bytes merely claiming to be a PDF", () => {
    const sniffed = sniffMimeType(new Uint8Array([0, 1, 2]), "application/pdf");
    expect(classifyAttachment(sniffed)).toBe("unsupported");
  });

  test("passes the original PDF to the model as a document, not decoded text", async () => {
    const metadata = { attachmentId: "pdf-1", filename: "report.pdf" };
    const parts = await resolveAttachmentParts(
      [
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/pdf-1" },
          metadata,
        },
      ],
      async () => ({
        mimeType: "application/pdf",
        name: "report.pdf",
        bytes: pdf,
      }),
    );
    expect(parts).toEqual([
      {
        type: "document",
        source: {
          type: "data",
          value: pdf.toString("base64"),
          mimeType: "application/pdf",
        },
        metadata,
      },
    ]);
  });
});
