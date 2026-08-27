import type {
  CompactConceptCapsule,
  ConceptCapsule,
  ConceptRecord,
  StudyState,
  WikiPageRecord,
} from "../contracts/types.js";
import { CONTEXT_LIMITS } from "../shared/limits.js";
import { unique } from "../shared/util.js";
import { tokenize } from "../shared/lexicon.js";

/**
 * The keyed concept index.
 *
 * For model access the wiki is a persistent intermediate representation, so
 * exact and alias lookup resolves through a `Map` and never scans page prose.
 * Only the fuzzy fallback ranks candidate entries.
 */
interface ConceptIndexEntry {
  page?: WikiPageRecord;
  concept?: ConceptRecord;
  capsule: Omit<ConceptCapsule, "match">;
  primaryKeys: Set<string>;
  aliasKeys: Set<string>;
  searchTokens: Set<string>;
}

export interface ConceptLookupIndex {
  entries: ConceptIndexEntry[];
  primary: Map<string, ConceptIndexEntry[]>;
  aliases: Map<string, ConceptIndexEntry[]>;
}

export function buildConceptIndex(state: StudyState): ConceptLookupIndex {
  const pagesBySlug = new Map(state.wikiPages.map((page) => [page.slug, page]));
  const conceptsById = new Map(state.concepts.map((concept) => [concept.id, concept]));
  const keys = unique([
    ...state.wikiPages.map((page) => page.slug),
    ...state.concepts.map((concept) => concept.id),
  ]);
  const entries = keys.map((key) => {
    const page = pagesBySlug.get(key);
    const concept = conceptsById.get(key);
    const title = page?.title ?? concept?.title ?? key;
    const sourceIds = unique([
      ...(page?.sourceIds ?? []),
      ...(concept?.sourceIds ?? []),
    ]);
    const primaryValues = unique([
      key,
      page?.slug ?? "",
      page?.title ?? "",
      concept?.id ?? "",
      concept?.title ?? "",
    ].filter(Boolean));
    const aliasValues = unique([
      ...(page?.aliases ?? []),
      ...(page?.tags ?? []),
    ]);
    const related = page?.links ?? [];
    const capsule: Omit<ConceptCapsule, "match"> = {
      key,
      title,
      summary: (page?.summary ?? "No compiled wiki summary is available yet.")
        .slice(0, 500),
      aliases: (page?.aliases ?? []).slice(0, 8)
        .map((alias) => alias.slice(0, 120)),
      related: related.slice(0, 8)
        .map((link) => link.slice(0, 200)),
      tags: (page?.tags ?? []).slice(0, 8)
        .map((tag) => tag.slice(0, 100)),
      sourceIds: sourceIds.slice(0, 8),
    };
    const primaryKeys = new Set(primaryValues
      .map(normalizeLookupKey)
      .filter(Boolean));
    const aliasKeys = new Set(aliasValues
      .map(normalizeLookupKey)
      .filter(Boolean));
    const searchTokens = new Set([
      ...primaryValues,
      ...aliasValues,
      page?.summary ?? "",
      ...related,
    ].flatMap(lookupTokens));
    return {
      page,
      concept,
      capsule,
      primaryKeys,
      aliasKeys,
      searchTokens,
    };
  });
  const primary = new Map<string, ConceptIndexEntry[]>();
  const aliases = new Map<string, ConceptIndexEntry[]>();
  const add = (
    target: Map<string, ConceptIndexEntry[]>,
    lookupKey: string,
    entry: ConceptIndexEntry,
  ): void => {
    const bucket = target.get(lookupKey) ?? [];
    bucket.push(entry);
    target.set(lookupKey, bucket);
  };
  for (const entry of entries) {
    for (const lookupKey of entry.primaryKeys) add(primary, lookupKey, entry);
    for (const lookupKey of entry.aliasKeys) add(aliases, lookupKey, entry);
  }
  return { entries, primary, aliases };
}

export function lookupConceptsIn(
  index: ConceptLookupIndex,
  query: string,
  limit: number,
): ConceptCapsule[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("Concept lookup query cannot be empty.");
  const queryKey = normalizeLookupKey(normalizedQuery);
  const queryTokens = new Set(lookupTokens(normalizedQuery));
  const directPrimary = index.primary.get(queryKey) ?? [];
  const directAliases = directPrimary.length === 0
    ? index.aliases.get(queryKey) ?? []
    : [];
  const direct = (directPrimary.length > 0 ? directPrimary : directAliases)
    .filter((entry, position, entries) =>
      entries.findIndex((candidate) =>
        candidate.capsule.key === entry.capsule.key) === position)
    .sort((a, b) => a.capsule.title.localeCompare(b.capsule.title))
    .slice(0, Math.max(1, Math.min(limit, CONTEXT_LIMITS.conceptMatches)))
    .map((entry) => ({
      ...entry.capsule,
      match: directPrimary.length > 0
        ? "exact" as const
        : "alias" as const,
    }));
  if (direct.length > 0) return direct;

  const ranked = index.entries.flatMap((entry) => {
    let score = 0;
    let match: ConceptCapsule["match"] = "fuzzy";
    const containedPrimary = [...entry.primaryKeys]
      .find((key) => key.length >= 3 && (queryKey.includes(key) || key.includes(queryKey)));
    const containedAlias = [...entry.aliasKeys]
      .find((key) => key.length >= 3 && (queryKey.includes(key) || key.includes(queryKey)));
    if (containedPrimary) {
      score = 800 + Math.min(100, containedPrimary.length);
      match = "exact";
    } else if (containedAlias) {
      score = 700 + Math.min(100, containedAlias.length);
      match = "alias";
    } else if (queryTokens.size > 0) {
      const matchingTokens = [...queryTokens]
        .filter((token) => entry.searchTokens.has(token)).length;
      if (matchingTokens > 0) {
        score = matchingTokens / queryTokens.size * 500
          + matchingTokens * 10;
        const relatedTokens = new Set(entry.capsule.related.flatMap(lookupTokens));
        if ([...queryTokens].every((token) => relatedTokens.has(token))) {
          match = "related";
          score = Math.max(score, 250);
        }
      }
    }
    return score > 0 ? [{ entry, score, match }] : [];
  }).sort((a, b) =>
    b.score - a.score
    || a.entry.capsule.title.localeCompare(b.entry.capsule.title));

  return ranked
    .slice(0, Math.max(1, Math.min(limit, CONTEXT_LIMITS.conceptMatches)))
    .map(({ entry, match }) => ({ ...entry.capsule, match }));
}

export function sourceIdsForConceptsIn(
  state: StudyState,
  keys: string[],
): Set<string> {
  const requested = new Set(keys);
  return new Set([
    ...state.wikiPages
      .filter((page) => requested.has(page.slug))
      .flatMap((page) => page.sourceIds),
    ...state.concepts
      .filter((concept) => requested.has(concept.id))
      .flatMap((concept) => concept.sourceIds),
  ]);
}

export function compactConceptCapsule(
  capsule: ConceptCapsule,
): CompactConceptCapsule {
  return {
    key: capsule.key,
    title: capsule.title,
    summary: capsule.summary,
    match: capsule.match,
    ...(capsule.related.length > 0 ? { related: capsule.related } : {}),
  };
}

function normalizeLookupKey(value: string): string {
  return unique(tokenize(value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()))
    .join(" ");
}

function lookupTokens(value: string): string[] {
  return normalizeLookupKey(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);
}
