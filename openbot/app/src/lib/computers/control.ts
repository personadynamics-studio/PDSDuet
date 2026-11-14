import { client } from "@/lib/client";
import type { ComputerControlState } from "@openbot/shared/computer-control";

export type { ComputerControlState as ControlState } from "@openbot/shared/computer-control";

async function callControl(computerId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<ComputerControlState> {
  const response = await client(`/api/computers/${encodeURIComponent(computerId)}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body }), signal,
  });
  return response.json();
}

export function readControl(computerId: string, requestId?: string, signal?: AbortSignal) {
  return callControl(computerId, `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`, undefined, signal);
}
export function takeControl(computerId: string, requestId?: string) {
  return callControl(computerId, "/control/take", { requestId });
}
export function releaseControl(computerId: string, requestId?: string) {
  return callControl(computerId, "/control/release", { requestId });
}
export function cancelControl(computerId: string, requestId?: string) {
  return callControl(computerId, "/control/cancel", { requestId });
}

/** The page receives the value; conversation history receives only the successful outcome. */
export async function supplySecret(computerId: string, text: string): Promise<void> {
  const response = await client(`/api/computers/${encodeURIComponent(computerId)}/human/secret`, {
    method: "POST", body: { text }, fallback: "未能將資料傳送至網頁。",
  });
  const result = await response.json() as { supplied: boolean };
  if (!result.supplied) throw new Error("網頁未接受資料，請重試。");
}
