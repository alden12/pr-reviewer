import { z } from "zod";

/**
 * One fold the reader opened, or folded back, by hand (KNOW-4): what kind of thing it was. The app sends these and the
 * server logs them (`pipeline/host.ts`), so the schema is shared: the server takes nothing it can't parse.
 */
export const readingEventSchema = z.strictObject({
  at: z.string(),
  action: z.enum(["open", "fold"]),
  path: z.string(),
  hunkIndex: z.number().int().min(0),
  /** The fold's reason (a block) or the span's kind (a run inside one): `generated`, `types`, `imports`... */
  kind: z.string(),
  /** A run's summary, when it was one. */
  summary: z.string().optional(),
});
export type ReadingEvent = z.infer<typeof readingEventSchema>;

/** A local review's folder name: one segment, never `..`. */
export const isReviewName = (name: string): boolean => /^[\w-][\w.-]*$/.test(name) && !name.includes("..");
