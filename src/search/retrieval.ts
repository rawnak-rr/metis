import type { SearchChunk, SourceRecord } from "../contracts/types.js";
import { sha256, unique } from "../shared/util.js";

export const SEARCH_INDEX_FORMAT_VERSION = 1 as const;
export const SEARCH_INDEX_DERIVATION_VERSION = [
  "text-parser-v2",
  "chunks-14-2-1400",
  "tokenizer-v2",
].join(":");

const SOURCE_CHUNK_LINES = 14;
const SOURCE_CHUNK_OVERLAP_LINES = 2;
const SOURCE_CHUNK_CHARACTERS = 1_400;
const MAX_PERSISTED_CHUNKS = 200_000;

const SIBILANT_STEM = /(?:ss|x|z|ch|sh)$/;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "may", "not", "of", "on", "or", "our", "that", "the",
  "their", "then", "there", "these", "this", "to", "use", "was", "we", "were",
  "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

export interface PersistedSearchChunk {
  chunkNumber: number;
  text: string;
  textChecksum: string;
  lineStart: number;
  lineEnd: number;
  tokenCounts: Record<string, number>;
  tokenCount: number;
  supportUnits: string[][];
}

export interface PersistedSourceSearchIndex {
  formatVersion: typeof SEARCH_INDEX_FORMAT_VERSION;
  derivationVersion: string;
  sourceChecksum: string;
  sourceKind: SourceRecord["kind"];
  chunks: PersistedSearchChunk[];
}

interface IndexedSearchChunk extends Omit<SearchChunk, "score"> {
  chunkNumber: number;
  textChecksum: string;
  tokenCounts: ReadonlyMap<string, number>;
  tokenCount: number;
  supportUnits: string[][];
}

interface IndexedSource {
  id: string;
  checksum: string;
  sourceKind: SourceRecord["kind"];
  chunks: IndexedSearchChunk[];
  tokenCount: number;
}

export interface RankedIndexedChunk extends SearchChunk {
  chunkNumber: number;
  textChecksum: string;
  supportUnits: string[][];
}

export interface SourceIndexBuildResult {
  sourceId: string;
  chunks: number;
  lexicalTokens: number;
}

export interface IndexedQueryResult {
  ranked: RankedIndexedChunk[];
  diagnostics: {
    scopedSources: number;
    corpusChunks: number;
    corpusLexicalTokens: number;
    candidateChunks: number;
    postingsVisited: number;
    queryTokens: number;
    uniqueQueryTokens: number;
    legacyEstimatedTokenVisits: number;
  };
}

/**
 * A disposable, incrementally maintained BM25 index.
 *
 * The index is a routing structure, never an evidence authority. Callers must
 * checksum-verify and rehydrate selected line spans from raw source text before
 * returning them to a model.
 */
export class IncrementalBm25Index {
  private readonly sources = new Map<string, IndexedSource>();
  private readonly chunks = new Map<string, IndexedSearchChunk>();
  private readonly postings = new Map<string, Map<string, number>>();

  hasSource(source: Pick<SourceRecord, "id" | "checksum">): boolean {
    return this.sources.get(source.id)?.checksum === source.checksum;
  }

  sourceCount(): number {
    return this.sources.size;
  }

  chunkCount(): number {
    return this.chunks.size;
  }

  upsertSource(source: SourceRecord, text: string): SourceIndexBuildResult {
    const chunks = buildIndexedChunks(source, text);
    this.replaceSource(source, chunks);
    return indexBuildResult(source, chunks);
  }

  restoreSource(
    source: SourceRecord,
    value: unknown,
  ): SourceIndexBuildResult | undefined {
    const persisted = parsePersistedSourceIndex(source, value);
    if (!persisted) return undefined;
    const chunks = persisted.chunks.map((chunk): IndexedSearchChunk => ({
      id: `${source.id}:${chunk.chunkNumber}`,
      documentId: source.id,
      title: source.title,
      kind: "source",
      text: chunk.text,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      sourceIds: [source.id],
      uri: `study://source/${source.id}`,
      chunkNumber: chunk.chunkNumber,
      textChecksum: chunk.textChecksum,
      tokenCounts: new Map(Object.entries(chunk.tokenCounts)),
      tokenCount: chunk.tokenCount,
      supportUnits: chunk.supportUnits,
    }));
    this.replaceSource(source, chunks);
    return indexBuildResult(source, chunks);
  }

  snapshot(sourceId: string): PersistedSourceSearchIndex | undefined {
    const indexed = this.sources.get(sourceId);
    if (!indexed) return undefined;
    return {
      formatVersion: SEARCH_INDEX_FORMAT_VERSION,
      derivationVersion: SEARCH_INDEX_DERIVATION_VERSION,
      sourceChecksum: indexed.checksum,
      sourceKind: indexed.sourceKind,
      chunks: indexed.chunks.map((chunk) => ({
        chunkNumber: chunk.chunkNumber,
        text: chunk.text,
        textChecksum: chunk.textChecksum,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        tokenCounts: Object.fromEntries(chunk.tokenCounts),
        tokenCount: chunk.tokenCount,
        supportUnits: chunk.supportUnits,
      })),
    };
  }

  removeSourcesExcept(sourceIds: ReadonlySet<string>): void {
    for (const sourceId of this.sources.keys()) {
      if (!sourceIds.has(sourceId)) this.removeSource(sourceId);
    }
  }

  removeSource(sourceId: string): void {
    const existing = this.sources.get(sourceId);
    if (!existing) return;
    for (const chunk of existing.chunks) {
      this.chunks.delete(chunk.id);
      for (const token of chunk.tokenCounts.keys()) {
        const posting = this.postings.get(token);
        posting?.delete(chunk.id);
        if (posting?.size === 0) this.postings.delete(token);
      }
    }
    this.sources.delete(sourceId);
  }

  rank(
    query: string,
    queryTokens: string[],
    sourceIds: string[],
  ): IndexedQueryResult {
    const sourceOrder = new Map(sourceIds.map((sourceId, index) => [
      sourceId,
      index,
    ]));
    const allowedSources = new Set(sourceIds);
    const scopedSources = sourceIds
      .map((sourceId) => this.sources.get(sourceId))
      .filter((source): source is IndexedSource => Boolean(source));
    const corpusChunks = scopedSources
      .reduce((total, source) => total + source.chunks.length, 0);
    const corpusLexicalTokens = scopedSources
      .reduce((total, source) => total + source.tokenCount, 0);
    const uniqueQueryTokens = unique(queryTokens);
    const documentFrequencies = new Map<string, number>();
    const candidateIds = new Set<string>();
    let postingsVisited = 0;

    for (const token of uniqueQueryTokens) {
      const posting = this.postings.get(token);
      let documentFrequency = 0;
      if (posting) {
        for (const chunkId of posting.keys()) {
          postingsVisited += 1;
          const chunk = this.chunks.get(chunkId);
          if (!chunk || !allowedSources.has(chunk.documentId)) continue;
          documentFrequency += 1;
          candidateIds.add(chunkId);
        }
      }
      documentFrequencies.set(token, documentFrequency);
    }

    const lowerQuery = query.toLowerCase();
    const ranked = [...candidateIds].flatMap((chunkId) => {
      const chunk = this.chunks.get(chunkId);
      if (!chunk) return [];
      let score = 0;
      for (const token of queryTokens) {
        const tf = chunk.tokenCounts.get(token) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequencies.get(token) ?? 0;
        const idf = Math.log(
          1 + (corpusChunks - df + 0.5) / (df + 0.5),
        );
        const normalizedTf = (tf * 2.2) / (
          tf + 1.2 * (0.25 + 0.75 * chunk.tokenCount / 160)
        );
        score += idf * normalizedTf;
      }
      if (chunk.text.toLowerCase().includes(lowerQuery)) score += 4;
      const roundedScore = Number(score.toFixed(5));
      return roundedScore > 0
        ? [{
            id: chunk.id,
            documentId: chunk.documentId,
            title: chunk.title,
            kind: chunk.kind,
            text: chunk.text,
            lineStart: chunk.lineStart,
            lineEnd: chunk.lineEnd,
            score: roundedScore,
            sourceIds: chunk.sourceIds,
            uri: chunk.uri,
            chunkNumber: chunk.chunkNumber,
            textChecksum: chunk.textChecksum,
            supportUnits: chunk.supportUnits,
          }]
        : [];
    }).sort((a, b) =>
      b.score - a.score
      || (sourceOrder.get(a.documentId) ?? Number.MAX_SAFE_INTEGER)
        - (sourceOrder.get(b.documentId) ?? Number.MAX_SAFE_INTEGER)
      || a.chunkNumber - b.chunkNumber);

    return {
      ranked,
      diagnostics: {
        scopedSources: scopedSources.length,
        corpusChunks,
        corpusLexicalTokens,
        candidateChunks: ranked.length,
        postingsVisited,
        queryTokens: queryTokens.length,
        uniqueQueryTokens: uniqueQueryTokens.length,
        legacyEstimatedTokenVisits:
          corpusLexicalTokens * (uniqueQueryTokens.length + 1),
      },
    };
  }

  private replaceSource(
    source: SourceRecord,
    chunks: IndexedSearchChunk[],
  ): void {
    this.removeSource(source.id);
    const indexed: IndexedSource = {
      id: source.id,
      checksum: source.checksum,
      sourceKind: source.kind,
      chunks,
      tokenCount: chunks.reduce(
        (total, chunk) => total + chunk.tokenCount,
        0,
      ),
    };
    this.sources.set(source.id, indexed);
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
      for (const [token, frequency] of chunk.tokenCounts) {
        const posting = this.postings.get(token) ?? new Map<string, number>();
        posting.set(chunk.id, frequency);
        this.postings.set(token, posting);
      }
    }
  }
}

/**
 * Words as written, before any stemming. Each caller stems once with the
 * variant its job needs; stacking two stemmers shifts the length guards of
 * the second onto already-shortened tokens.
 */
export function tokenizeRaw(text: string): string[] {
  return (
    text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? []
  )
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""));
}

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token);
}

export function tokenize(text: string): string[] {
  return tokenizeRaw(text)
    .map(stemSearch)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function supportFingerprint(
  supportUnits: string[][],
  queryTokens: ReadonlySet<string>,
): string {
  let best: string[] = [];
  let bestMatches = 0;
  let bestTokenCount = Number.POSITIVE_INFINITY;
  for (const tokens of supportUnits) {
    const matches = unique(tokens)
      .filter((token) => queryTokens.has(token)).length;
    if (
      matches > bestMatches
      || (matches === bestMatches && tokens.length < bestTokenCount)
    ) {
      best = tokens;
      bestMatches = matches;
      bestTokenCount = tokens.length;
    }
  }
  return bestMatches > 0 ? best.join(" ") : "";
}

export function rehydrateChunkText(
  sourceText: string,
  lineStart: number,
  lineEnd: number,
): string {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  let text = lines.slice(lineStart - 1, lineEnd).join("\n").trim();
  if (text.length > SOURCE_CHUNK_CHARACTERS) {
    text = text.slice(0, SOURCE_CHUNK_CHARACTERS).trimEnd();
  }
  return text;
}

function indexBuildResult(
  source: SourceRecord,
  chunks: IndexedSearchChunk[],
): SourceIndexBuildResult {
  return {
    sourceId: source.id,
    chunks: chunks.length,
    lexicalTokens: chunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
  };
}

function buildIndexedChunks(
  source: SourceRecord,
  sourceText: string,
): IndexedSearchChunk[] {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  const output: IndexedSearchChunk[] = [];
  let start = 0;
  let chunkNumber = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + SOURCE_CHUNK_LINES);
    let text = lines.slice(start, end).join("\n").trim();
    while (text.length > SOURCE_CHUNK_CHARACTERS && end > start + 3) {
      end -= 1;
      text = lines.slice(start, end).join("\n").trim();
    }
    if (text.length > SOURCE_CHUNK_CHARACTERS) {
      text = text.slice(0, SOURCE_CHUNK_CHARACTERS).trimEnd();
    }
    if (text) {
      const tokens = tokenize(text);
      const tokenCounts = new Map<string, number>();
      for (const token of tokens) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }
      output.push({
        id: `${source.id}:${chunkNumber}`,
        documentId: source.id,
        title: source.title,
        kind: "source",
        text,
        lineStart: start + 1,
        lineEnd: end,
        sourceIds: [source.id],
        uri: `study://source/${source.id}`,
        chunkNumber,
        textChecksum: sha256(text),
        tokenCounts,
        tokenCount: tokens.length,
        supportUnits: text
          .split(/\n+|[.!?]\s+/)
          .map((unit) => unit.trim())
          .filter(Boolean)
          .map(tokenize),
      });
      chunkNumber += 1;
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - SOURCE_CHUNK_OVERLAP_LINES);
  }
  return output;
}

function parsePersistedSourceIndex(
  source: SourceRecord,
  value: unknown,
): PersistedSourceSearchIndex | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.formatVersion !== SEARCH_INDEX_FORMAT_VERSION
    || value.derivationVersion !== SEARCH_INDEX_DERIVATION_VERSION
    || value.sourceChecksum !== source.checksum
    || value.sourceKind !== source.kind
    || !Array.isArray(value.chunks)
    || value.chunks.length > MAX_PERSISTED_CHUNKS
  ) {
    return undefined;
  }
  const chunks: PersistedSearchChunk[] = [];
  for (const candidate of value.chunks) {
    if (!isRecord(candidate)) return undefined;
    if (
      !Number.isInteger(candidate.chunkNumber)
      || Number(candidate.chunkNumber) < 0
      || typeof candidate.text !== "string"
      || candidate.text.length > SOURCE_CHUNK_CHARACTERS
      || typeof candidate.textChecksum !== "string"
      || candidate.textChecksum !== sha256(candidate.text)
      || !Number.isInteger(candidate.lineStart)
      || Number(candidate.lineStart) < 1
      || !Number.isInteger(candidate.lineEnd)
      || Number(candidate.lineEnd) < Number(candidate.lineStart)
      || !Number.isInteger(candidate.tokenCount)
      || Number(candidate.tokenCount) < 0
      || !isRecord(candidate.tokenCounts)
      || !Array.isArray(candidate.supportUnits)
    ) {
      return undefined;
    }
    const tokenCounts: Record<string, number> = {};
    let tokenTotal = 0;
    for (const [token, frequency] of Object.entries(candidate.tokenCounts)) {
      if (
        !token
        || typeof frequency !== "number"
        || !Number.isInteger(frequency)
        || frequency < 1
      ) {
        return undefined;
      }
      tokenCounts[token] = frequency;
      tokenTotal += frequency;
    }
    if (tokenTotal !== candidate.tokenCount) return undefined;
    const supportUnits: string[][] = [];
    for (const unit of candidate.supportUnits) {
      if (
        !Array.isArray(unit)
        || unit.some((token) => typeof token !== "string")
      ) {
        return undefined;
      }
      supportUnits.push(unit as string[]);
    }
    chunks.push({
      chunkNumber: Number(candidate.chunkNumber),
      text: candidate.text,
      textChecksum: candidate.textChecksum,
      lineStart: Number(candidate.lineStart),
      lineEnd: Number(candidate.lineEnd),
      tokenCounts,
      tokenCount: Number(candidate.tokenCount),
      supportUnits,
    });
  }
  return {
    formatVersion: SEARCH_INDEX_FORMAT_VERSION,
    derivationVersion: SEARCH_INDEX_DERIVATION_VERSION,
    sourceChecksum: source.checksum,
    sourceKind: source.kind,
    chunks,
  };
}

/**
 * Conservative plural stemming for the index and for queries against it. Only
 * unambiguous "-es" endings lose the "e" as well: a stem ending in a single
 * "s" is left alone because "bases" (base) and "buses" (bus) are not
 * distinguishable here, and over-stemming costs precision in every posting.
 */
export function stemSearch(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (
    token.length > 4
    && token.endsWith("s")
    && !token.endsWith("ss")
    && !token.endsWith("us")
    && !token.endsWith("is")
  ) {
    const singular = token.slice(0, -1);
    return singular.endsWith("e") && SIBILANT_STEM.test(singular.slice(0, -1))
      ? singular.slice(0, -1)
      : singular;
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}
