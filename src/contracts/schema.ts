import { z } from "zod";

export const groundingModeSchema = z.enum([
  "sources_only",
  "sources_first",
  "open",
]);

const sourceKindSchema = z.enum([
  "text",
  "markdown",
  "pdf",
  "data",
  "latex",
  "image",
]);

/** How a source's searchable text is derived from its immutable raw bytes. */
const extractionMethodSchema = z.enum([
  "verbatim",
  "markdown",
  "latex",
  "pdftotext",
  "vision",
]);

/** Image media types accepted by the Claude Messages API. */
const imageMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const sourceExtractionSchema = z.object({
  method: extractionMethodSchema,
  /** Image media type, recorded only for vision extraction. */
  mediaType: imageMediaTypeSchema.optional(),
  /** Model that produced the transcript, recorded only for vision extraction. */
  model: z.string().min(1).optional(),
  extractedAt: z.string().min(1).optional(),
}).strict();

const sourceRecordSchema = z.object({
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

const wikiPageRecordSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  aliases: z.array(z.string()),
  sourceIds: z.array(z.string()),
  links: z.array(z.string()),
  tags: z.array(z.string()),
  updatedAt: z.string().min(1),
}).strict();

const conceptRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.array(z.string()),
  sourceIds: z.array(z.string()),
}).strict();

const studyStateSchema = z.object({
  sources: z.array(sourceRecordSchema),
  wikiPages: z.array(wikiPageRecordSchema),
  concepts: z.array(conceptRecordSchema),
}).strict();

const studyConfigSchema = z.object({
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
