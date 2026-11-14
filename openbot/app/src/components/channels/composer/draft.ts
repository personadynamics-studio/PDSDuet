import type { Attachment } from "@/lib/chat/attachments";
import { getChipsByTrigger, isSegmentsEmpty, mergeAdjacentTextSegments, type Segment, segmentsToPlainText } from "prompt-area/helpers";

export const AGENT_TRIGGER = "@";
export type ComposerDraft = {
  text: string;
  /** An explicit group recipient; null addresses the selected group roster. */
  agentId: string | null;
  isEmpty: boolean;
  attachments: Attachment[];
};
export function toDraft(segments: Segment[], attachments: Attachment[] = []): ComposerDraft {
  return {
    text: segmentsToPlainText(segments).trim(),
    agentId: getChipsByTrigger(segments, AGENT_TRIGGER).at(-1)?.value ?? null,
    isEmpty: isSegmentsEmpty(segments),
    attachments,
  };
}
export function canSendDraft(draft: ComposerDraft): boolean {
  return !draft.attachments.some((attachment) => attachment.status === "uploading") && (draft.attachments.length > 0 || !draft.isEmpty);
}
export function enforceSingleAgent(segments: Segment[]): Segment[] {
  let remaining = getChipsByTrigger(segments, AGENT_TRIGGER).length;
  if (remaining <= 1) return segments;
  return mergeAdjacentTextSegments(segments.filter((segment) => segment.type !== "chip" || segment.trigger !== AGENT_TRIGGER || --remaining === 0));
}
