import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_STATE_SCHEMA_VERSION,
  groundingModeSchema,
  parseStudyConfig,
  parseStudyState,
  schemaVersionOf,
  type ExtractionMethod,
  type StudyConfig,
  type StudyState,
} from "./schema.js";
import { nowIso, sha256 } from "../shared/util.js";

type JsonObject = Record<string, unknown>;
type Migration = (value: JsonObject) => JsonObject;

export interface MigrationResult<T> {
  beforeVersion: number;
  afterVersion: number;
  value: T;
  actions: string[];
}

const STATE_MIGRATIONS = new Map<number, Migration>([
  [0, (legacy) => ({
    schemaVersion: 1,
    sources: arrayOrEmpty(legacy.sources),
    wikiPages: arrayOrEmpty(legacy.wikiPages),
    concepts: arrayOrEmpty(legacy.concepts),
    cards: arrayOrEmpty(legacy.cards),
    reviews: arrayOrEmpty(legacy.reviews),
    goals: arrayOrEmpty(legacy.goals),
  })],
  [1, (legacy) => ({
    ...legacy,
    schemaVersion: 2,
    concepts: arrayOrEmpty(legacy.concepts).map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const concept = value as JsonObject;
      if (Array.isArray(concept.misconceptions)) return concept;
      const recordedAt = nonEmptyString(concept.lastStudiedAt) ?? "1970-01-01T00:00:00.000Z";
      const notes = Array.isArray(concept.notes)
        ? concept.notes.filter((note): note is string =>
            typeof note === "string" && Boolean(note.trim()))
        : [];
      return {
        ...concept,
        misconceptions: notes.map((text, index) => ({
          id: `mis_legacy_${sha256(`${String(concept.id)}:${index}:${text}`).slice(0, 12)}`,
          text,
          recordedAt,
          occurrences: 1,
        })),
      };
    }),
  })],
  [2, (legacy) => ({
    ...legacy,
    schemaVersion: 3,
    wikiPages: arrayOrEmpty(legacy.wikiPages).map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const page = value as JsonObject;
      return {
        ...page,
        aliases: Array.isArray(page.aliases)
          ? page.aliases.filter((alias): alias is string =>
              typeof alias === "string" && Boolean(alias.trim()))
          : [],
      };
    }),
  })],
  [3, (legacy) => {
    const { cards: _cards, reviews: _reviews, goals: _goals, ...rest } = legacy;
    return {
      ...rest,
      schemaVersion: 4,
      concepts: arrayOrEmpty(legacy.concepts).map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const concept = value as JsonObject;
        return {
          id: concept.id,
          title: concept.title,
          notes: Array.isArray(concept.notes)
            ? concept.notes.filter((note): note is string =>
                typeof note === "string" && Boolean(note.trim()))
            : [],
          sourceIds: arrayOrEmpty(concept.sourceIds),
        };
      }),
    };
  }],
  [4, (legacy) => ({
    ...legacy,
    schemaVersion: 5,
    sources: arrayOrEmpty(legacy.sources).map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const source = value as JsonObject;
      if (source.extraction && typeof source.extraction === "object") return source;
      return { ...source, extraction: { method: legacyExtractionMethod(source.kind) } };
    }),
  })],
]);

const CONFIG_MIGRATIONS = new Map<number, Migration>([
  [0, (legacy) => ({
    schemaVersion: 1,
    name: nonEmptyString(legacy.name) ?? "Study Vault",
    createdAt: nonEmptyString(legacy.createdAt) ?? nowIso(),
    groundingDefault: groundingModeSchema.safeParse(legacy.groundingDefault).success
      ? legacy.groundingDefault
      : "sources_first",
  })],
]);

export function migrateState(value: unknown): MigrationResult<StudyState> {
  return migrate(
    value,
    CURRENT_STATE_SCHEMA_VERSION,
    STATE_MIGRATIONS,
    parseStudyState,
    "state",
  );
}

export function migrateConfig(value: unknown): MigrationResult<StudyConfig> {
  return migrate(
    value,
    CURRENT_CONFIG_SCHEMA_VERSION,
    CONFIG_MIGRATIONS,
    parseStudyConfig,
    "config",
  );
}

function migrate<T>(
  original: unknown,
  targetVersion: number,
  migrations: Map<number, Migration>,
  validate: (value: unknown) => T,
  label: string,
): MigrationResult<T> {
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    throw new Error(`Metis ${label} must be a JSON object before it can be migrated.`);
  }
  const beforeVersion = schemaVersionOf(original);
  if (beforeVersion > targetVersion) {
    throw new Error(
      `Vault ${label} schema v${beforeVersion} is newer than this Metis build supports (v${targetVersion}). Refusing to downgrade it.`,
    );
  }

  let current = structuredClone(original) as JsonObject;
  let version = beforeVersion;
  const actions: string[] = [];
  while (version < targetVersion) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new Error(`No ${label} migration is registered from schema v${version} to v${version + 1}.`);
    }
    current = migration(current);
    actions.push(`Migrated ${label} schema v${version} → v${version + 1}.`);
    version += 1;
  }

  return {
    beforeVersion,
    afterVersion: version,
    value: validate(current),
    actions,
  };
}

/**
 * Sources predating schema v5 have no recorded extraction method; it is fully
 * determined by the source kind, because vision extraction did not yet exist.
 */
function legacyExtractionMethod(kind: unknown): ExtractionMethod {
  if (kind === "pdf") return "pdftotext";
  if (kind === "markdown") return "markdown";
  if (kind === "latex") return "latex";
  return "verbatim";
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
