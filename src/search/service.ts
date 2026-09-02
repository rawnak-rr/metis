import path from "node:path";
import type {
  ConceptCapsule,
  EvidenceExcerpt,
  SearchChunk,
  SourceRecord,
  StudyState,
} from "../contracts/types.js";
import { tokenize } from "../shared/lexicon.js";
import { CONTEXT_LIMITS } from "../shared/limits.js";
import { atomicWrite, sha256 } from "../shared/util.js";
import { SEARCH_INDEX_CACHE_DIRECTORY } from "../vault/layout.js";
import { StudyStore } from "../vault/store.js";
import { VerifiedSourceReader } from "../ingestion/source-reader.js";
import {
  buildConceptIndex,
  lookupConceptsIn,
  sourceIdsForConceptsIn,
  type ConceptLookupIndex,
} from "./concepts.js";
import {
  IncrementalBm25Index,
  rehydrateChunkText,
  supportFingerprint,
  type RankedIndexedChunk,
} from "./retrieval.js";

export interface SourceSearchOptions {
  sourceIds?: ReadonlySet<string>;
  maxTextCharacters?: number;
}

/** Concept lookup and source search bound to one loaded state snapshot. */
export interface RetrievalSession {
  lookupConcepts(query: string, limit?: number): ConceptCapsule[];
  sourceIdsForConcepts(keys: string[]): Set<string>;
  search(
    query: string,
    limit?: number,
    options?: SourceSearchOptions,
  ): Promise<SearchChunk[]>;
}

export interface RetrievalDiagnostics {
  searches: number;
  memoryIndexHits: number;
  diskIndexHits: number;
  sourcesIndexed: number;
  chunksIndexed: number;
  sourceLexicalTokensIndexed: number;
  postingsVisited: number;
  candidateChunksScored: number;
  legacyEstimatedTokenVisits: number;
  indexedTokenWork: number;
  verifiedSources: number;
  returnedChunks: number;
  conceptIndexBuilds: number;
  indexedSourcesCurrent: number;
  indexedChunksCurrent: number;
}

type SearchSyncDiagnostics = Pick<
  RetrievalDiagnostics,
  | "memoryIndexHits"
  | "diskIndexHits"
  | "sourcesIndexed"
  | "chunksIndexed"
  | "sourceLexicalTokensIndexed"
>;

const EMPTY_RETRIEVAL_DIAGNOSTICS: RetrievalDiagnostics = {
  searches: 0,
  memoryIndexHits: 0,
  diskIndexHits: 0,
  sourcesIndexed: 0,
  chunksIndexed: 0,
  sourceLexicalTokensIndexed: 0,
  postingsVisited: 0,
  candidateChunksScored: 0,
  legacyEstimatedTokenVisits: 0,
  indexedTokenWork: 0,
  verifiedSources: 0,
  returnedChunks: 0,
  conceptIndexBuilds: 0,
  indexedSourcesCurrent: 0,
  indexedChunksCurrent: 0,
};

/**
 * Source text verified once for the life of one retrieval session.
 *
 * Every read re-hashes the raw copy before its text is trusted, and one
 * question fans out into a search per facet and a second unscoped search
 * whenever routing comes back thin. Verifying per search therefore re-reads
 * and re-hashes the same file several times to answer one question. The scope
 * keeps the guarantee at the boundary that matters, which is the answer: every
 * source behind it is verified while it is being built, and read once.
 */
class VerifiedTextScope {
  private readonly texts = new Map<string, Promise<string>>();
  /** Raw copies actually read and hashed, for retrieval diagnostics. */
  reads = 0;

  constructor(private readonly reader: VerifiedSourceReader) {}

  read(source: SourceRecord): Promise<string> {
    const pending = this.texts.get(source.id);
    if (pending) return pending;
    this.reads += 1;
    const text = this.reader.readSourceText(source);
    this.texts.set(source.id, text);
    return text;
  }
}

/**
 * Concept lookup and BM25 source search over checksum-verified evidence.
 *
 * The inverted index is derived data: it is updated only for new or changed
 * sources, restored from `.metis/cache/search-v1/` on restart, and rebuilt from
 * verified raw bytes whenever an entry is absent or fails its checksum. Cached
 * text is never returned to a caller; a selected line span is always rehydrated
 * through the reader, so a search result cannot outlive the evidence it names.
 */
export class SearchService {
  private readonly retrievalIndex = new IncrementalBm25Index();
  private conceptIndex: { revision: string; index: ConceptLookupIndex }
    | undefined;
  private retrievalDiagnostics: RetrievalDiagnostics = {
    ...EMPTY_RETRIEVAL_DIAGNOSTICS,
  };

  constructor(
    private readonly store: StudyStore,
    private readonly reader: VerifiedSourceReader,
  ) {}

  getRetrievalDiagnostics(): RetrievalDiagnostics {
    return {
      ...this.retrievalDiagnostics,
      indexedSourcesCurrent: this.retrievalIndex.sourceCount(),
      indexedChunksCurrent: this.retrievalIndex.chunkCount(),
    };
  }

  resetRetrievalDiagnostics(): void {
    this.retrievalDiagnostics = {
      ...EMPTY_RETRIEVAL_DIAGNOSTICS,
      indexedSourcesCurrent: this.retrievalIndex.sourceCount(),
      indexedChunksCurrent: this.retrievalIndex.chunkCount(),
    };
  }

  /**
   * Opens concept lookup and source search over a single state snapshot, one
   * concept index, and one verification scope, so multi-facet retrieval neither
   * reloads the vault nor re-hashes a raw copy per facet.
   */
  async openRetrieval(): Promise<RetrievalSession> {
    const { state, index } = await this.openConceptIndex();
    const verified = new VerifiedTextScope(this.reader);
    return {
      lookupConcepts: (query, limit = CONTEXT_LIMITS.conceptMatches) =>
        lookupConceptsIn(index, query, limit),
      sourceIdsForConcepts: (keys) => sourceIdsForConceptsIn(state, keys),
      search: (
        query,
        limit = CONTEXT_LIMITS.sourceResultsDefault,
        options = {},
      ) => this.searchSources(state, query, limit, options, verified),
    };
  }

  async lookupConcepts(
    query: string,
    limit: number = CONTEXT_LIMITS.conceptMatches,
  ): Promise<ConceptCapsule[]> {
    const { index } = await this.openConceptIndex();
    return lookupConceptsIn(index, query, limit);
  }

  /**
   * The concept index for the current state, built at most once per revision.
   *
   * The index is derived wholly from state, so an unchanged state file may
   * reuse it. Callers only read the index and the capsules it hands out, and a
   * capsule carries no reference a caller could write through, so one instance
   * is safe to share across lookups and across retrieval sessions.
   */
  private async openConceptIndex(): Promise<{
    state: StudyState;
    index: ConceptLookupIndex;
  }> {
    const { state, revision } = await this.store.readStateSnapshot();
    if (this.conceptIndex?.revision !== revision) {
      this.conceptIndex = { revision, index: buildConceptIndex(state) };
      this.retrievalDiagnostics = {
        ...this.retrievalDiagnostics,
        conceptIndexBuilds: this.retrievalDiagnostics.conceptIndexBuilds + 1,
      };
    }
    return { state, index: this.conceptIndex.index };
  }

  async sourceIdsForConcepts(keys: string[]): Promise<Set<string>> {
    return sourceIdsForConceptsIn(await this.store.readState(), keys);
  }

  async search(
    query: string,
    limit: number = CONTEXT_LIMITS.sourceResultsDefault,
    options: SourceSearchOptions = {},
  ): Promise<SearchChunk[]> {
    return this.searchSources(
      await this.store.readState(),
      query,
      limit,
      options,
      new VerifiedTextScope(this.reader),
    );
  }

  private async searchSources(
    state: StudyState,
    query: string,
    limit: number,
    options: SourceSearchOptions,
    verified: VerifiedTextScope,
  ): Promise<SearchChunk[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Search query cannot be empty.");
    const queryTokens = tokenize(normalizedQuery);
    if (queryTokens.length === 0) return [];
    const sourceIds = options.sourceIds;
    const scopedSources = state.sources
      .filter((source) => !sourceIds || sourceIds.has(source.id));
    const sync = await this.ensureSourcesIndexed(state.sources, scopedSources);
    return this.searchIndexedSources(
      normalizedQuery,
      queryTokens,
      scopedSources,
      limit,
      options,
      verified,
      sync,
      false,
    );
  }

  private async searchIndexedSources(
    normalizedQuery: string,
    queryTokens: string[],
    scopedSources: SourceRecord[],
    limit: number,
    options: SourceSearchOptions,
    verified: VerifiedTextScope,
    sync: SearchSyncDiagnostics,
    repaired: boolean,
  ): Promise<SearchChunk[]> {
    const indexed = this.retrievalIndex.rank(
      normalizedQuery,
      queryTokens,
      scopedSources.map((source) => source.id),
    );
    const selected: RankedIndexedChunk[] = [];
    const resultLimit = Math.max(
      1,
      Math.min(limit, CONTEXT_LIMITS.sourceResultsMaximum),
    );
    const textBudget = Math.max(
      CONTEXT_LIMITS.sourceChunkCharacters,
      Math.min(
        options.maxTextCharacters ?? CONTEXT_LIMITS.sourceSearchTextCharacters,
        CONTEXT_LIMITS.sourceSearchTextCharacters,
      ),
    );
    let selectedTextCharacters = 0;
    const selectedSupportFingerprints = new Set<string>();
    const queryTokenSet = new Set(queryTokens);
    for (const candidate of indexed.ranked) {
      if (selected.some((accepted) =>
        accepted.documentId === candidate.documentId
        && rangesOverlap(
          accepted.lineStart,
          accepted.lineEnd,
          candidate.lineStart,
          candidate.lineEnd,
      ))) {
        continue;
      }
      const candidateSupportFingerprint = supportFingerprint(
        candidate.supportUnits,
        queryTokenSet,
      );
      const scopedFingerprint = candidateSupportFingerprint
        ? `${candidate.documentId}:${candidateSupportFingerprint}`
        : "";
      if (
        scopedFingerprint
        && selectedSupportFingerprints.has(scopedFingerprint)
      ) {
        continue;
      }
      if (
        selected.length > 0
        && selectedTextCharacters + candidate.text.length > textBudget
      ) {
        continue;
      }
      selected.push(candidate);
      if (scopedFingerprint) {
        selectedSupportFingerprints.add(scopedFingerprint);
      }
      selectedTextCharacters += candidate.text.length;
      if (selected.length >= resultLimit) break;
    }
    const sourcesById = new Map(
      scopedSources.map((source) => [source.id, source]),
    );
    const verifiedBefore = verified.reads;
    const hydrated: SearchChunk[] = [];
    const invalidCacheSources = new Set<string>();
    for (const candidate of selected) {
      const source = sourcesById.get(candidate.documentId);
      if (!source) continue;
      const verifiedText = await verified.read(source);
      const text = rehydrateChunkText(
        verifiedText,
        candidate.lineStart,
        candidate.lineEnd,
      );
      if (sha256(text) !== candidate.textChecksum) {
        invalidCacheSources.add(source.id);
        continue;
      }
      hydrated.push({
        id: candidate.id,
        documentId: candidate.documentId,
        title: candidate.title,
        kind: candidate.kind,
        text,
        lineStart: candidate.lineStart,
        lineEnd: candidate.lineEnd,
        score: candidate.score,
        sourceIds: candidate.sourceIds,
        uri: candidate.uri,
      });
    }

    if (invalidCacheSources.size > 0) {
      if (repaired) {
        throw new Error(
          `Search index repair failed for source IDs: ${
            [...invalidCacheSources].join(", ")
          }.`,
        );
      }
      let repairedChunks = 0;
      let repairedTokens = 0;
      for (const sourceId of invalidCacheSources) {
        const source = sourcesById.get(sourceId)!;
        const build = this.retrievalIndex.upsertSource(
          source,
          await verified.read(source),
        );
        repairedChunks += build.chunks;
        repairedTokens += build.lexicalTokens;
        await this.persistSourceIndex(source).catch(() => undefined);
      }
      return this.searchIndexedSources(
        normalizedQuery,
        queryTokens,
        scopedSources,
        limit,
        options,
        verified,
        {
          ...sync,
          sourcesIndexed: sync.sourcesIndexed + invalidCacheSources.size,
          chunksIndexed: sync.chunksIndexed + repairedChunks,
          sourceLexicalTokensIndexed:
            sync.sourceLexicalTokensIndexed + repairedTokens,
        },
        true,
      );
    }

    this.recordRetrievalDiagnostics({
      ...sync,
      postingsVisited: indexed.diagnostics.postingsVisited,
      candidateChunksScored: indexed.diagnostics.candidateChunks,
      legacyEstimatedTokenVisits:
        indexed.diagnostics.legacyEstimatedTokenVisits,
      verifiedSources: verified.reads - verifiedBefore,
      returnedChunks: hydrated.length,
    });
    return hydrated;
  }

  /** True when this source's current bytes are already indexed in memory. */
  hasSource(source: Pick<SourceRecord, "id" | "checksum">): boolean {
    return this.retrievalIndex.hasSource(source);
  }

  async indexIngestedSource(
    source: SourceRecord,
    extractedText: string,
    lineToPage?: number[],
  ): Promise<void> {
    this.reader.cacheText(source, extractedText, lineToPage);
    this.retrievalIndex.upsertSource(source, extractedText);
    await this.persistSourceIndex(source).catch(() => undefined);
  }

  private async ensureSourcesIndexed(
    allSources: SourceRecord[],
    scopedSources: SourceRecord[],
  ): Promise<SearchSyncDiagnostics> {
    this.retrievalIndex.removeSourcesExcept(
      new Set(allSources.map((source) => source.id)),
    );
    const diagnostics: SearchSyncDiagnostics = {
      memoryIndexHits: 0,
      diskIndexHits: 0,
      sourcesIndexed: 0,
      chunksIndexed: 0,
      sourceLexicalTokensIndexed: 0,
    };
    for (const source of scopedSources) {
      if (this.retrievalIndex.hasSource(source)) {
        diagnostics.memoryIndexHits += 1;
        continue;
      }
      if (await this.restorePersistedSourceIndex(source)) {
        diagnostics.diskIndexHits += 1;
        continue;
      }
      const text = await this.reader.readSourceText(source);
      const build = this.retrievalIndex.upsertSource(source, text);
      diagnostics.sourcesIndexed += 1;
      diagnostics.chunksIndexed += build.chunks;
      diagnostics.sourceLexicalTokensIndexed += build.lexicalTokens;
      await this.persistSourceIndex(source).catch(() => undefined);
    }
    return diagnostics;
  }

  private async restorePersistedSourceIndex(
    source: SourceRecord,
  ): Promise<boolean> {
    try {
      const text = await this.store.readText(this.searchIndexRelativePath(source));
      const value = JSON.parse(text) as unknown;
      return Boolean(this.retrievalIndex.restoreSource(source, value));
    } catch {
      return false;
    }
  }

  private async persistSourceIndex(source: SourceRecord): Promise<void> {
    const snapshot = this.retrievalIndex.snapshot(source.id);
    if (!snapshot) return;
    const target = await this.store.resolveForWrite(
      this.searchIndexRelativePath(source),
    );
    await atomicWrite(target, `${JSON.stringify(snapshot)}\n`);
  }

  private searchIndexRelativePath(source: SourceRecord): string {
    return path.posix.join(SEARCH_INDEX_CACHE_DIRECTORY, `${source.checksum}.json`);
  }

  private recordRetrievalDiagnostics(
    update: SearchSyncDiagnostics & {
      postingsVisited: number;
      candidateChunksScored: number;
      legacyEstimatedTokenVisits: number;
      verifiedSources: number;
      returnedChunks: number;
    },
  ): void {
    this.retrievalDiagnostics = {
      searches: this.retrievalDiagnostics.searches + 1,
      memoryIndexHits:
        this.retrievalDiagnostics.memoryIndexHits + update.memoryIndexHits,
      diskIndexHits:
        this.retrievalDiagnostics.diskIndexHits + update.diskIndexHits,
      sourcesIndexed:
        this.retrievalDiagnostics.sourcesIndexed + update.sourcesIndexed,
      chunksIndexed:
        this.retrievalDiagnostics.chunksIndexed + update.chunksIndexed,
      sourceLexicalTokensIndexed:
        this.retrievalDiagnostics.sourceLexicalTokensIndexed
        + update.sourceLexicalTokensIndexed,
      postingsVisited:
        this.retrievalDiagnostics.postingsVisited + update.postingsVisited,
      candidateChunksScored:
        this.retrievalDiagnostics.candidateChunksScored
        + update.candidateChunksScored,
      legacyEstimatedTokenVisits:
        this.retrievalDiagnostics.legacyEstimatedTokenVisits
        + update.legacyEstimatedTokenVisits,
      indexedTokenWork:
        this.retrievalDiagnostics.indexedTokenWork
        + update.sourceLexicalTokensIndexed
        + update.postingsVisited,
      verifiedSources:
        this.retrievalDiagnostics.verifiedSources + update.verifiedSources,
      returnedChunks:
        this.retrievalDiagnostics.returnedChunks + update.returnedChunks,
      conceptIndexBuilds: this.retrievalDiagnostics.conceptIndexBuilds,
      indexedSourcesCurrent: this.retrievalIndex.sourceCount(),
      indexedChunksCurrent: this.retrievalIndex.chunkCount(),
    };
  }
}

/** Evidence excerpts, each carrying the citation token that reproduces it. */
export function evidenceExcerpts(hits: SearchChunk[]): EvidenceExcerpt[] {
  return hits
    .filter((hit) => hit.kind === "source")
    .map((hit) => ({
      citation: `[${hit.documentId}#L${hit.lineStart}-L${hit.lineEnd}]`,
      sourceId: hit.documentId,
      title: hit.title.slice(0, 200),
      text: hit.text,
    }));
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart <= secondEnd && secondStart <= firstEnd;
}
