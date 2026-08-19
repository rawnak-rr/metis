import { z } from "zod";
import type { StudyConfig, StudyState } from "./types.js";

export const CURRENT_STATE_SCHEMA_VERSION = 3 as const;
export const CURRENT_CONFIG_SCHEMA_VERSION = 1 as const;

const sourceRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["text", "markdown", "pdf", "data", "latex"]),
  relativePath: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  tags: z.array(z.string()),
  ingestedAt: z.string().min(1),
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
  mastery: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  attempts: z.number().int().min(0),
  correct: z.number().int().min(0),
  lastStudiedAt: z.string().optional(),
  notes: z.array(z.string()),
  misconceptions: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    recordedAt: z.string().min(1),
    occurrences: z.number().int().positive(),
    resolvedAt: z.string().optional(),
  }).strict()),
  sourceIds: z.array(z.string()),
}).strict();

const cardRecordSchema = z.object({
  id: z.string().min(1),
  front: z.string().min(1),
  back: z.string().min(1),
  conceptId: z.string().optional(),
  sourceIds: z.array(z.string()),
  tags: z.array(z.string()),
  createdAt: z.string().min(1),
  dueAt: z.string().min(1),
  intervalDays: z.number().min(0),
  easeFactor: z.number().min(1.3).max(3),
  repetitions: z.number().int().min(0),
  lapses: z.number().int().min(0),
  suspended: z.boolean(),
}).strict();

const reviewRecordSchema = z.object({
  id: z.string().min(1),
  cardId: z.string().min(1),
  grade: z.number().int().min(0).max(5),
  reviewedAt: z.string().min(1),
  elapsedMs: z.number().int().min(0).optional(),
  note: z.string().optional(),
  previousIntervalDays: z.number().min(0),
  nextIntervalDays: z.number().min(0),
}).strict();

const goalRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  conceptIds: z.array(z.string()),
  targetMastery: z.number().positive().max(1),
  deadline: z.string().optional(),
  minutesPerWeek: z.number().int().positive(),
  status: z.enum(["active", "completed", "paused"]),
  createdAt: z.string().min(1),
}).strict();

export const studyStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_STATE_SCHEMA_VERSION),
  sources: z.array(sourceRecordSchema),
  wikiPages: z.array(wikiPageRecordSchema),
  concepts: z.array(conceptRecordSchema),
  cards: z.array(cardRecordSchema),
  reviews: z.array(reviewRecordSchema),
  goals: z.array(goalRecordSchema),
}).strict();

export const studyConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_CONFIG_SCHEMA_VERSION),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  groundingDefault: z.enum(["sources_only", "sources_first", "open"]),
  dailyReviewLimit: z.number().int().min(1).max(200),
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
