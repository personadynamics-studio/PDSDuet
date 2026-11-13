import { useCallback, useRef, useState, type DragEvent } from "react";
import { classifyAttachment } from "@/lib/channels/attachments";
import { newId } from "@/lib/new-id";

export type AttachmentSource =
  | { type: "url"; value: string; mimeType?: string; metadata?: unknown }
  | { type: "data"; value: string; mimeType?: string; metadata?: unknown };
export type Attachment = {
  id: string;
  type: "image" | "document" | "text" | "audio" | "video";
  filename?: string;
  status: "uploading" | "uploaded";
  source: AttachmentSource;
  size?: number;
};
export type AttachmentsConfig = {
  enabled: boolean;
  accept?: string;
  maxSize?: number;
  onUpload(file: File): Promise<AttachmentSource>;
  onUploadFailed?(failure: { file: File; message: string }): void;
};

/** File bytes go directly to this deployment; browser state retains only upload references. */
export function useStagedFiles(config: AttachmentsConfig | undefined) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const removeAttachment = useCallback((id: string) => {
    setAttachments((rows) => rows.filter((row) => row.id !== id));
  }, []);
  const processFiles = useCallback(async (files: File[]) => {
    const current = configRef.current;
    if (!current?.enabled) return;
    await Promise.all(files.map(async (file) => {
      const id = newId();
      const kind = classifyAttachment(file.type);
      const type = kind === "image" ? "image" : kind === "text" ? "text" : "document";
      if (current.maxSize !== undefined && file.size > current.maxSize) {
        current.onUploadFailed?.({ file, message: `「${file.name}」超出檔案大小限制。` });
        return;
      }
      setAttachments((rows) => [...rows, {
        id, type, filename: file.name, status: "uploading",
        source: { type: "data", value: "", mimeType: file.type }, size: file.size,
      }]);
      try {
        const source = await current.onUpload(file);
        setAttachments((rows) => rows.map((row) => row.id === id ? { ...row, source, status: "uploaded" } : row));
      } catch (error) {
        setAttachments((rows) => rows.filter((row) => row.id !== id));
        current.onUploadFailed?.({ file, message: error instanceof Error ? error.message : `無法上載「${file.name}」。` });
      }
    }));
  }, []);
  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => event.preventDefault(), []);
  return { attachments, enabled: config?.enabled === true, fileInputRef, processFiles, removeAttachment, handleDragOver };
}
