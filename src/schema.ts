import { z } from "zod";

export const CURRENT_STATE_SCHEMA_VERSION = 5 as const;
export const CURRENT_CONFIG_SCHEMA_VERSION = 1 as const;

export const groundingModeSchema = z.enum([
  "sources_only",
  "sources_first",
  "open",
]);

export const sourceKindSchema = z.enum([
  "text",
  "markdown",
  "pdf",
  "data",
  "latex",
  "image",
]);

/** How a source's searchable text is derived from its immutable raw bytes. */
export const extractionMethodSchema = z.enum([
  "verbatim",
  "markdown",
  "latex",
  "pdftotext",
  "vision",
]);

/** Image media types accepted by the Claude Messages API. */
export const imageMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const sourceExtractionSchema = z.object({
  method: extractionMethodSchema,
  /** Image media type, recorded only for vision extraction. */
  mediaType: imageMediaTypeSchema.optional(),
  /** Model that produced the transcript, recorded only for vision extraction. */
  model: z.string().min(1).optional(),
  extractedAt: z.string().min(1).optional(),
}).strict();

export const sourceRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: sourceKindSchema,
  relativePath: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  tags: z.array(z.string()),
  ingestedAt: z.string().min(1),
  extraction: sourceExtractionSchema,
  originalPath: z.string().optional(),
}).strict();

export const wikiPageRecordSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  aliases: z.array(z.string()),
  sourceIds: z.array(z.string()),
  links: z.array(z.string()),
  tags: z.array(z.string()),
  updatedAt: z.string().min(1),
}).strict();

export const conceptRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.array(z.string()),
  sourceIds: z.array(z.string()),
}).strict();

export const studyStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_STATE_SCHEMA_VERSION),
  sources: z.array(sourceRecordSchema),
  wikiPages: z.array(wikiPageRecordSchema),
  concepts: z.array(conceptRecordSchema),
}).strict();

export const studyConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_CONFIG_SCHEMA_VERSION),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  groundingDefault: groundingModeSchema,
}).strict();

export type GroundingMode = z.infer<typeof groundingModeSchema>;
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;
export type SourceExtraction = z.infer<typeof sourceExtractionSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type WikiPageRecord = z.infer<typeof wikiPageRecordSchema>;
export type ConceptRecord = z.infer<typeof conceptRecordSchema>;
export type StudyState = z.infer<typeof studyStateSchema>;
export type StudyConfig = z.infer<typeof studyConfigSchema>;

export function parseStudyState(value: unknown): StudyState {
  return studyStateSchema.parse(value);
}

export function parseStudyConfig(value: unknown): StudyConfig {
  return studyConfigSchema.parse(value);
}

export function schemaVersionOf(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const version = (value as Record<string, unknown>).schemaVersion;
  return typeof version === "number" && Number.isInteger(version) ? version : 0;
}
