import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
export const memoryInputSchema = z
  .object({
    content: text(6000),
    provenance: text(500).default("You"),
    enabled: z.boolean().default(true),
  })
  .strict();
/**
 * A change to a memory, spelled out rather than `memoryInputSchema.partial()`.
 *
 * `.partial()` keeps each field's `.default()`, so every patch parsed as `provenance: "You",
 * enabled: true`: confirming an imported memory rewrote where it came from to "You", and any edit
 * switched a disabled memory back on. Provenance is not here at all. Where a memory came from is
 * recorded when it is made and is not something an edit gets to change.
 */
export const memoryPatchSchema = z
  .object({
    content: text(6000).optional(),
    enabled: z.boolean().optional(),
    reviewState: z.enum(["unreviewed", "confirmed", "edited"]).optional(),
  })
  .strict();
export class MemoryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRefusedError";
  }
}
export class MemoryNotFoundError extends Error {
  constructor() {
    super("This memory could not be found.");
    this.name = "MemoryNotFoundError";
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new MemoryRefusedError(
      result.error.issues[0]?.message ?? "Invalid memory.",
    );
  return result.data;
}
export const parseMemoryInput = (input: unknown) =>
  parse(memoryInputSchema, input);
export const parseMemoryPatch = (input: unknown) => {
  const value = parse(memoryPatchSchema, input);
  if (!Object.keys(value).length)
    throw new MemoryRefusedError("Supply a change to this memory.");
  return value;
};
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type MemoryPatch = z.infer<typeof memoryPatchSchema>;
export type MemoryRecord = MemoryInput & {
  id: string;
  ownerUserId: string;
  sourceId: string | null;
  externalId: string | null;
  importDigest: string | null;
  reviewState: "unreviewed" | "confirmed" | "edited";
  formedBy: "person" | "import" | "bot";
  formedByAgentId: string | null;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  observedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
