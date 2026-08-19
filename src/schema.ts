import { z } from "zod";
import type { StudyConfig, StudyState } from "./types.js";

export const CURRENT_STATE_SCHEMA_VERSION = 5 as const;
export const CURRENT_CONFIG_SCHEMA_VERSION = 1 as const;

const sourceRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["text", "markdown", "pdf", "data", "latex", "image"]),
  relativePath: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  tags: z.array(z.string()),
  ingestedAt: z.string().min(1),
  extraction: z.object({
    method: z.enum(["verbatim", "markdown", "latex", "pdftotext", "vision"]),
    mediaType: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    extractedAt: z.string().min(1).optional(),
  }).strict(),
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
  groundingDefault: z.enum(["sources_only", "sources_first", "open"]),
}).strict();

export function parseStudyState(value: unknown): StudyState {
  return studyStateSchema.parse(value) as StudyState;
}

export function parseStudyConfig(value: unknown): StudyConfig {
  return studyConfigSchema.parse(value) as StudyConfig;
}

export function schemaVersionOf(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const version = (value as Record<string, unknown>).schemaVersion;
  return typeof version === "number" && Number.isInteger(version) ? version : 0;
}
