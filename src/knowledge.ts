import { execFile } from "node:child_process";
import { chmod, copyFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CompactConceptCapsule,
  ConceptCapsule,
  ConceptRecord,
  EvidenceExcerpt,
  SearchChunk,
  SourceRecord,
  StudyState,
  WikiPageRecord,
} from "./types.js";
import { GENERATED_WIKI_FORMAT_VERSION, StudyStore } from "./store.js";
import {
  atomicWrite,
  newId,
  nowIso,
  sanitizeFilename,
  sha256,
  slugify,
  unique,
} from "./util.js";
import {
  IncrementalBm25Index,
  rehydrateChunkText,
  supportFingerprint,
  tokenize,
  type RankedIndexedChunk,
} from "./retrieval.js";

export { tokenize } from "./retrieval.js";

const execFileAsync = promisify(execFile);
const WIKI_CITATION_PATTERN = /\[([A-Za-z0-9_-]+)#L(\d+)-L(\d+)\]/g;
const MAX_CITATION_LINES = 80;
export const CONTEXT_LIMITS = {
  conceptMatches: 3,
  sourceResultsDefault: 3,
  sourceResultsMaximum: 6,
  sourceChunkCharacters: 1_400,
  sourceSearchTextCharacters: 4_200,
  sourcePreviewCharacters: 800,
  activeMisconceptions: 2,
} as const;
const GENERIC_SUPPORT_WORDS = new Set([
  "claim", "concept", "evidence", "fact", "information", "note", "page", "source",
]);

const MIME_KIND: Record<string, SourceRecord["kind"]> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
  ".tex": "latex",
  ".csv": "data",
  ".tsv": "data",
  ".json": "data",
  ".yaml": "data",
  ".yml": "data",
};

export interface IngestInput {
  title: string;
  content?: string;
  sourcePath?: string;
  tags?: string[];
}

export interface IngestResult {
  source: SourceRecord;
  duplicate: boolean;
  preview: string;
  suggestedConcepts: string[];
}

export interface WikiLintResult {
  healthy: boolean;
  checkedAt: string;
  pages: number;
  sources: number;
  issues: Array<{
    severity: "error" | "warning" | "info";
    code:
      | "missing_source"
      | "broken_link"
      | "orphan_page"
      | "uncited_page"
      | "invalid_citation"
      | "source_integrity"
      | "stale_page";
    page: string;
    message: string;
  }>;
}

export type KnowledgeRepairMode = "incremental" | "full";

export interface KnowledgeRepairResult {
  mode: KnowledgeRepairMode;
  dryRun: boolean;
  sources: {
    total: number;
    verified: number;
    permissionsRepaired: number;
    descriptorsPreserved: number;
    descriptorsRefreshed: number;
  };
  wiki: {
    pages: number;
    preserved: number;
    metadataRefreshed: number;
    evidenceStubsRebuilt: number;
    brokenLinksRemoved: number;
    missingSourceReferencesRemoved: number;
    conceptsCreated: number;
    learnerReferencesRepaired: number;
    untrackedManagedFilesRemoved: number;
  };
  searchIndex: {
    reused: number;
    rebuilt: number;
    staleEntriesRemoved: number;
    indexedSources: number;
    indexedChunks: number;
  };
}

export type KnowledgeSearchScope = "all" | "sources" | "wiki";

export interface SourceSearchOptions {
  sourceIds?: ReadonlySet<string>;
  maxTextCharacters?: number;
}

interface ConceptIndexEntry {
  page?: WikiPageRecord;
  concept?: ConceptRecord;
  capsule: Omit<ConceptCapsule, "match">;
  primaryKeys: Set<string>;
  aliasKeys: Set<string>;
  searchTokens: Set<string>;
}

interface ConceptLookupIndex {
  entries: ConceptIndexEntry[];
  primary: Map<string, ConceptIndexEntry[]>;
  aliases: Map<string, ConceptIndexEntry[]>;
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
  indexedSourcesCurrent: number;
  indexedChunksCurrent: number;
}

interface SearchSyncDiagnostics {
  memoryIndexHits: number;
  diskIndexHits: number;
  sourcesIndexed: number;
  chunksIndexed: number;
  sourceLexicalTokensIndexed: number;
}

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
  indexedSourcesCurrent: 0,
  indexedChunksCurrent: 0,
};

export class KnowledgeService {
  private readonly sourceTextCache = new Map<string, {
    checksum: string;
    text: string;
  }>();
  private readonly retrievalIndex = new IncrementalBm25Index();
  private retrievalDiagnostics: RetrievalDiagnostics = {
    ...EMPTY_RETRIEVAL_DIAGNOSTICS,
  };

  constructor(private readonly store: StudyStore) {}

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

  async repairKnowledge(options: {
    mode?: KnowledgeRepairMode;
    dryRun?: boolean;
  } = {}): Promise<KnowledgeRepairResult> {
    const mode = options.mode ?? "incremental";
    const dryRun = options.dryRun ?? false;
    const state = structuredClone(await this.store.readState());
    const relationships = reconcileKnowledgeRelationships(state);
    if (!dryRun && relationships.changed) await this.store.writeState(state);

    let descriptorsPreserved = 0;
    let descriptorsRefreshed = 0;
    let permissionsRepaired = 0;
    for (const source of state.sources) {
      const verified = await this.readVerifiedSourceBytes(source);
      if (((await stat(verified.absolute)).mode & 0o222) !== 0) {
        permissionsRepaired += 1;
        if (!dryRun) await chmod(verified.absolute, 0o444);
      }
      const current = mode === "incremental"
        && await this.sourceDescriptorCurrent(source);
      if (current) {
        descriptorsPreserved += 1;
        continue;
      }
      descriptorsRefreshed += 1;
      if (!dryRun) {
        const sourceText = await this.readSourceText(source);
        await this.store.writeSourcePage(source, this.preview(sourceText));
      }
    }

    let preserved = 0;
    let metadataRefreshed = 0;
    let evidenceStubsRebuilt = 0;
    for (const page of state.wikiPages) {
      const pageRelativePath = path.posix.join(
        "wiki",
        "concepts",
        `${page.slug}.md`,
      );
      let markdown = "";
      let valid = false;
      try {
        markdown = await this.store.readText(pageRelativePath);
        await this.validateWikiMarkdown(markdown, page.sourceIds, state.sources);
        valid = true;
      } catch {
        valid = false;
      }

      if (!valid) {
        evidenceStubsRebuilt += 1;
        if (!dryRun) {
          const rebuilt = await this.recoveryWikiMarkdown(
            page,
            state.sources,
          );
          const updatedPage = {
            ...page,
            summary: rebuilt.summary,
            updatedAt: nowIso(),
          };
          await this.store.mutateManaged(
            (next) => {
              const index = next.wikiPages.findIndex((candidate) =>
                candidate.slug === updatedPage.slug);
              if (index < 0) {
                throw new Error(`Cannot repair missing wiki state for '${updatedPage.slug}'.`);
              }
              next.wikiPages[index] = updatedPage;
            },
            () => ({
              wikiPages: [{ page: updatedPage, markdown: rebuilt.markdown }],
            }),
          );
          Object.assign(page, updatedPage);
        }
        continue;
      }

      if (mode === "full" || !wikiMetadataCurrent(markdown, page)) {
        metadataRefreshed += 1;
        if (!dryRun) {
          await this.store.writeWikiPage(page, stripFrontmatter(markdown));
        }
      } else {
        preserved += 1;
      }
    }

    const untrackedManagedFilesRemoved = await this.pruneUntrackedWikiFiles(
      state,
      dryRun,
    );
    if (!dryRun) await this.store.rebuildWikiIndex();
    const searchIndex = await this.repairSearchIndex(state.sources, mode, dryRun);
    return {
      mode,
      dryRun,
      sources: {
        total: state.sources.length,
        verified: state.sources.length,
        permissionsRepaired,
        descriptorsPreserved,
        descriptorsRefreshed,
      },
      wiki: {
        pages: state.wikiPages.length,
        preserved,
        metadataRefreshed,
        evidenceStubsRebuilt,
        brokenLinksRemoved: relationships.brokenLinksRemoved,
        missingSourceReferencesRemoved:
          relationships.missingSourceReferencesRemoved,
        conceptsCreated: relationships.conceptsCreated,
        learnerReferencesRepaired:
          relationships.learnerReferencesRepaired,
        untrackedManagedFilesRemoved,
      },
      searchIndex,
    };
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const title = input.title.trim();
    if (!title) throw new Error("Source title cannot be empty.");
    if ((input.content === undefined) === (input.sourcePath === undefined)) {
      throw new Error("Provide exactly one of content or sourcePath.");
    }

    let bytes: Buffer;
    let extractedText: string;
    let extension: string;
    let originalPath: string | undefined;
    let inputAbsolute: string | undefined;
    if (input.sourcePath !== undefined) {
      inputAbsolute = await this.store.resolveExisting(input.sourcePath);
      extension = path.extname(input.sourcePath).toLowerCase();
      if (!(extension in MIME_KIND)) {
        throw new Error(`Unsupported source type '${extension || "(none)"}'. Supported: ${Object.keys(MIME_KIND).join(", ")}`);
      }
      bytes = await readFile(inputAbsolute);
      extractedText = extension === ".pdf"
        ? await this.extractPdf(inputAbsolute)
        : bytes.toString("utf8");
      originalPath = input.sourcePath;
    } else {
      extension = ".md";
      extractedText = input.content ?? "";
      bytes = Buffer.from(extractedText, "utf8");
    }

    const checksum = sha256(bytes);
    const current = await this.store.readState();
    const existing = current.sources.find((source) => source.checksum === checksum);
    if (existing) {
      await this.readVerifiedSourceBytes(existing);
      await this.indexIngestedSource(existing, extractedText);
      return {
        source: existing,
        duplicate: true,
        preview: this.preview(extractedText),
        suggestedConcepts: this.suggestConcepts(extractedText),
      };
    }

    const sourceId = newId("src");
    const targetName = `${sourceId}-${sanitizeFilename(title, "source")}${extension}`;
    const targetRelative = path.posix.join("raw", targetName);
    const targetAbsolute = await this.store.resolveForWrite(targetRelative);
    if (inputAbsolute !== undefined) {
      await copyFile(inputAbsolute, targetAbsolute);
    } else {
      await atomicWrite(targetAbsolute, extractedText);
    }
    const storedBytes = await readFile(targetAbsolute);
    if (sha256(storedBytes) !== checksum) {
      throw new Error("Source copy verification failed before ingestion was committed.");
    }
    await chmod(targetAbsolute, 0o444);

    const source: SourceRecord = {
      id: sourceId,
      title,
      kind: MIME_KIND[extension] ?? "text",
      relativePath: targetRelative,
      checksum,
      tags: unique((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
      ingestedAt: nowIso(),
      ...(originalPath ? { originalPath } : {}),
    };
    const preview = this.preview(extractedText);
    await this.store.mutateManaged(
      (state) => {
        state.sources.push(source);
      },
      () => ({
        sourcePages: [{ source, preview }],
        rebuildWikiIndex: true,
        log: {
          operation: "ingest",
          title: source.title,
          details: [
            `Source ID: \`${source.id}\``,
            `Stored immutable raw copy at \`${source.relativePath}\``,
            `Checksum: \`${source.checksum}\``,
          ],
        },
      }),
    );
    await this.indexIngestedSource(source, extractedText);
    return {
      source,
      duplicate: false,
      preview,
      suggestedConcepts: this.suggestConcepts(extractedText),
    };
  }

  async upsertWikiPage(input: {
    title: string;
    summary: string;
    markdown: string;
    sourceIds: string[];
    aliases?: string[];
    links?: string[];
    tags?: string[];
    slug?: string;
  }): Promise<WikiPageRecord> {
    if (input.title.trim().length > 200) {
      throw new Error("Wiki titles must be at most 200 characters.");
    }
    if (input.summary.trim().length > 500) {
      throw new Error("Wiki summaries must be at most 500 characters.");
    }
    if ((input.aliases ?? []).some((alias) => alias.trim().length > 120)) {
      throw new Error("Wiki aliases must be at most 120 characters each.");
    }
    const state = await this.store.readState();
    const sourceIds = unique(input.sourceIds);
    const missingSources = sourceIds.filter((id) => !state.sources.some((source) => source.id === id));
    if (missingSources.length > 0) {
      throw new Error(`Unknown source IDs: ${missingSources.join(", ")}`);
    }
    if (sourceIds.length === 0) {
      throw new Error("A wiki page must cite at least one ingested source.");
    }
    const slug = slugify(input.slug?.trim() || input.title);
    const links = unique((input.links ?? []).map(slugify).filter((link) => link !== slug));
    const page: WikiPageRecord = {
      slug,
      title: input.title.trim(),
      summary: input.summary.trim(),
      aliases: unique((input.aliases ?? [])
        .map((alias) => alias.trim())
        .filter(Boolean)
        .filter((alias) => normalizeLookupKey(alias) !== normalizeLookupKey(input.title))),
      sourceIds,
      links,
      tags: unique((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
      updatedAt: nowIso(),
    };
    if (!page.title || !page.summary || !input.markdown.trim()) {
      throw new Error("Wiki title, summary, and markdown body are required.");
    }
    await this.validateWikiMarkdown(input.markdown, sourceIds, state.sources);

    await this.store.mutateManaged(
      (next) => {
        const index = next.wikiPages.findIndex((candidate) => candidate.slug === slug);
        if (index >= 0) next.wikiPages[index] = page;
        else next.wikiPages.push(page);

        let concept = next.concepts.find((candidate) => candidate.id === slug);
        if (!concept) {
          concept = {
            id: slug,
            title: page.title,
            notes: [],
            sourceIds,
          };
          next.concepts.push(concept);
        } else {
          concept.title = page.title;
          concept.sourceIds = unique([...concept.sourceIds, ...sourceIds]);
        }
      },
      () => ({
        wikiPages: [{ page, markdown: input.markdown }],
        rebuildWikiIndex: true,
        log: {
          operation: "wiki",
          title: page.title,
          details: [
            `Page: \`wiki/concepts/${page.slug}.md\``,
            `Evidence: ${page.sourceIds.map((id) => `\`${id}\``).join(", ")}`,
            `Links: ${page.links.length > 0 ? page.links.map((link) => `[[${link}]]`).join(", ") : "none"}`,
          ],
        },
      }),
    );
    return page;
  }

  async lookupConcepts(
    query: string,
    limit: number = CONTEXT_LIMITS.conceptMatches,
  ): Promise<ConceptCapsule[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Concept lookup query cannot be empty.");
    const state = await this.store.readState();
    const queryKey = normalizeLookupKey(normalizedQuery);
    const queryTokens = new Set(lookupTokens(normalizedQuery));
    const index = this.buildConceptIndex(state);
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

  async sourceIdsForConcepts(keys: string[]): Promise<Set<string>> {
    const requested = new Set(keys);
    const state = await this.store.readState();
    return new Set([
      ...state.wikiPages
        .filter((page) => requested.has(page.slug))
        .flatMap((page) => page.sourceIds),
      ...state.concepts
        .filter((concept) => requested.has(concept.id))
        .flatMap((concept) => concept.sourceIds),
    ]);
  }

  async search(
    query: string,
    limit: number = CONTEXT_LIMITS.sourceResultsDefault,
    scope: KnowledgeSearchScope = "sources",
    options: SourceSearchOptions = {},
  ): Promise<SearchChunk[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Search query cannot be empty.");
    if (scope === "wiki") {
      const concepts = await this.lookupConcepts(normalizedQuery, limit);
      return concepts.map((concept, index) => ({
        id: `concept:${concept.key}`,
        documentId: concept.key,
        title: concept.title,
        kind: "wiki",
        text: concept.summary,
        lineStart: 1,
        lineEnd: 1,
        score: concept.match === "exact"
          ? 100
          : concept.match === "alias"
            ? 80
            : Math.max(1, 50 - index),
        sourceIds: concept.sourceIds,
        uri: `study://wiki/${concept.key}`,
      }));
    }
    const queryTokens = tokenize(normalizedQuery);
    if (queryTokens.length === 0) return [];
    const state = await this.store.readState();
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
    const verifiedTexts = new Map<string, string>();
    const verifiedSources = new Set<string>();
    const hydrated: SearchChunk[] = [];
    const invalidCacheSources = new Set<string>();
    for (const candidate of selected) {
      const source = sourcesById.get(candidate.documentId);
      if (!source) continue;
      let verifiedText = verifiedTexts.get(source.id);
      if (verifiedText === undefined) {
        verifiedText = await this.readSourceText(source);
        verifiedTexts.set(source.id, verifiedText);
        verifiedSources.add(source.id);
      }
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
        const verifiedText = verifiedTexts.get(sourceId)!;
        const build = this.retrievalIndex.upsertSource(source, verifiedText);
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
      verifiedSources: verifiedSources.size,
      returnedChunks: hydrated.length,
    });
    return hydrated;
  }

  private async indexIngestedSource(
    source: SourceRecord,
    extractedText: string,
  ): Promise<void> {
    this.sourceTextCache.set(source.id, {
      checksum: source.checksum,
      text: extractedText,
    });
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
      const text = await this.readSourceText(source);
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
    return path.posix.join(
      ".metis",
      "cache",
      "search-v1",
      `${source.checksum}.json`,
    );
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
      indexedSourcesCurrent: this.retrievalIndex.sourceCount(),
      indexedChunksCurrent: this.retrievalIndex.chunkCount(),
    };
  }

  evidenceExcerpts(hits: SearchChunk[]): EvidenceExcerpt[] {
    return hits
      .filter((hit) => hit.kind === "source")
      .map((hit) => ({
        citation: `[${hit.documentId}#L${hit.lineStart}-L${hit.lineEnd}]`,
        sourceId: hit.documentId,
        title: hit.title.slice(0, 200),
        text: hit.text,
      }));
  }

  private async sourceDescriptorCurrent(source: SourceRecord): Promise<boolean> {
    try {
      const markdown = await this.store.readText(path.posix.join(
        "wiki",
        "sources",
        `${source.id}.md`,
      ));
      return markdown.includes(`metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`)
        && markdown.includes(`id: ${JSON.stringify(source.id)}`)
        && markdown.includes(`SHA-256: \`${source.checksum}\``)
        && markdown.includes(`Raw file: [${source.relativePath}]`);
    } catch {
      return false;
    }
  }

  private async recoveryWikiMarkdown(
    page: WikiPageRecord,
    sources: SourceRecord[],
  ): Promise<{ markdown: string; summary: string }> {
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const queryTokens = new Set(tokenize(`${page.title} ${page.summary}`));
    const blocks: string[] = [
      `# ${page.title}`,
      "",
      "## Recovered verbatim evidence",
      "",
    ];
    let summary = "";
    for (const sourceId of page.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) {
        throw new Error(
          `Cannot rebuild '${page.slug}': source '${sourceId}' is unavailable.`,
        );
      }
      const sourceText = await this.readSourceText(source);
      const excerpt = bestRecoveryExcerpt(sourceText, queryTokens);
      if (!excerpt) {
        throw new Error(
          `Cannot rebuild '${page.slug}': source '${sourceId}' has no extractable text.`,
        );
      }
      const citation = `[${source.id}#L${excerpt.lineStart}-L${excerpt.lineEnd}]`;
      if (!summary) {
        summary = `Recovered evidence: ${excerpt.text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 480)}`;
      }
      const quoted = excerpt.text
        .replace(WIKI_CITATION_PATTERN, "[$1 line $2-$3]")
        .split("\n")
        .map((line) => `> ${line}`);
      quoted[quoted.length - 1] = `${quoted.at(-1)} ${citation}`;
      blocks.push(
        `### ${source.title}`,
        "",
        ...quoted,
        "",
      );
    }
    const markdown = blocks.join("\n").trimEnd();
    await this.validateWikiMarkdown(markdown, page.sourceIds, sources);
    return { markdown: `${markdown}\n`, summary };
  }

  private async repairSearchIndex(
    sources: SourceRecord[],
    mode: KnowledgeRepairMode,
    dryRun: boolean,
  ): Promise<KnowledgeRepairResult["searchIndex"]> {
    if (mode === "full") {
      this.retrievalIndex.removeSourcesExcept(new Set());
    } else {
      this.retrievalIndex.removeSourcesExcept(
        new Set(sources.map((source) => source.id)),
      );
    }

    let reused = 0;
    let rebuilt = 0;
    for (const source of sources) {
      if (mode === "incremental" && this.retrievalIndex.hasSource(source)) {
        reused += 1;
        continue;
      }
      if (mode === "incremental" && await this.restorePersistedSourceIndex(source)) {
        reused += 1;
        continue;
      }
      rebuilt += 1;
      if (dryRun) continue;
      const text = await this.readSourceText(source);
      this.retrievalIndex.upsertSource(source, text);
      await this.persistSourceIndex(source);
    }

    const expectedEntries = new Set(
      sources.map((source) => `${source.checksum}.json`),
    );
    const cacheRoot = await this.store.resolveExisting(
      ".metis/cache/search-v1",
    );
    const cacheEntries = await readdir(cacheRoot, { withFileTypes: true });
    const staleEntries = cacheEntries.filter((entry) =>
      (entry.isFile() || entry.isSymbolicLink())
      && !expectedEntries.has(entry.name));
    if (!dryRun) {
      for (const entry of staleEntries) {
        await unlink(await this.store.resolveForWrite(path.posix.join(
          ".metis",
          "cache",
          "search-v1",
          entry.name,
        )));
      }
    }

    return {
      reused,
      rebuilt,
      staleEntriesRemoved: staleEntries.length,
      indexedSources: dryRun
        ? reused
        : this.retrievalIndex.sourceCount(),
      indexedChunks: this.retrievalIndex.chunkCount(),
    };
  }

  private async pruneUntrackedWikiFiles(
    state: StudyState,
    dryRun: boolean,
  ): Promise<number> {
    const managedDirectories = [
      {
        relativePath: path.posix.join("wiki", "concepts"),
        expected: new Set(state.wikiPages.map((page) => `${page.slug}.md`)),
      },
      {
        relativePath: path.posix.join("wiki", "sources"),
        expected: new Set(state.sources.map((source) => `${source.id}.md`)),
      },
    ];
    let removed = 0;
    for (const directory of managedDirectories) {
      const absolute = await this.store.resolveExisting(directory.relativePath);
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (
          (!entry.isFile() && !entry.isSymbolicLink())
          || !entry.name.endsWith(".md")
          || directory.expected.has(entry.name)
        ) {
          continue;
        }
        removed += 1;
        if (!dryRun) {
          await unlink(await this.store.resolveForWrite(path.posix.join(
            directory.relativePath,
            entry.name,
          )));
        }
      }
    }
    return removed;
  }

  async readSourceText(source: SourceRecord): Promise<string> {
    const { absolute, bytes } = await this.readVerifiedSourceBytes(source);
    const cached = this.sourceTextCache.get(source.id);
    if (cached?.checksum === source.checksum) return cached.text;
    const text = source.kind === "pdf"
      ? await this.extractPdf(absolute)
      : bytes.toString("utf8");
    if (source.kind === "pdf") await this.readVerifiedSourceBytes(source);
    this.sourceTextCache.set(source.id, {
      checksum: source.checksum,
      text,
    });
    return text;
  }

  async lintWiki(options: { log?: boolean } = {}): Promise<WikiLintResult> {
    const state = await this.store.readState();
    const slugs = new Set(state.wikiPages.map((page) => page.slug));
    const sourceIds = new Set(state.sources.map((source) => source.id));
    const inbound = new Map(state.wikiPages.map((page) => [page.slug, 0]));
    const issues: WikiLintResult["issues"] = [];
    for (const source of state.sources) {
      try {
        await this.readVerifiedSourceBytes(source);
      } catch (error) {
        issues.push({
          severity: "error",
          code: "source_integrity",
          page: source.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const page of state.wikiPages) {
      if (page.sourceIds.length === 0) {
        issues.push({
          severity: "error",
          code: "uncited_page",
          page: page.slug,
          message: "Page has no source provenance.",
        });
      }
      for (const sourceId of page.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          issues.push({
            severity: "error",
            code: "missing_source",
            page: page.slug,
            message: `References unknown source '${sourceId}'.`,
          });
        }
      }
      for (const link of page.links) {
        if (!slugs.has(link)) {
          issues.push({
            severity: "warning",
            code: "broken_link",
            page: page.slug,
            message: `Links to missing concept page '${link}'.`,
          });
        } else {
          inbound.set(link, (inbound.get(link) ?? 0) + 1);
        }
      }
      if (page.sourceIds.length > 0 && page.sourceIds.every((sourceId) => sourceIds.has(sourceId))) {
        try {
          const markdown = await this.store.readText(
            path.posix.join("wiki", "concepts", `${page.slug}.md`),
          );
          await this.validateWikiMarkdown(markdown, page.sourceIds, state.sources);
        } catch (error) {
          issues.push({
            severity: "error",
            code: "invalid_citation",
            page: page.slug,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const newestEvidence = state.sources
        .filter((source) => page.sourceIds.includes(source.id))
        .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))[0];
      if (newestEvidence && newestEvidence.ingestedAt > page.updatedAt) {
        issues.push({
          severity: "warning",
          code: "stale_page",
          page: page.slug,
          message: `Cited source '${newestEvidence.id}' is newer than the compiled page.`,
        });
      }
    }
    if (state.wikiPages.length > 1) {
      for (const page of state.wikiPages) {
        if ((inbound.get(page.slug) ?? 0) === 0 && page.links.length === 0) {
          issues.push({
            severity: "info",
            code: "orphan_page",
            page: page.slug,
            message: "Page has no incoming or outgoing concept links.",
          });
        }
      }
    }
    const result: WikiLintResult = {
      healthy: !issues.some((issue) => issue.severity === "error"),
      checkedAt: nowIso(),
      pages: state.wikiPages.length,
      sources: state.sources.length,
      issues,
    };
    if (options.log !== false) {
      await this.store.appendLog("lint", "Wiki health check", [
        `Pages: ${result.pages}`,
        `Sources: ${result.sources}`,
        `Issues: ${issues.length}`,
        `Errors: ${issues.filter((issue) => issue.severity === "error").length}`,
      ]);
    }
    return result;
  }

  private buildConceptIndex(state: StudyState): ConceptLookupIndex {
    const pagesBySlug = new Map(state.wikiPages.map((page) => [page.slug, page]));
    const conceptsById = new Map(state.concepts.map((concept) => [concept.id, concept]));
    const keys = unique([
      ...state.wikiPages.map((page) => page.slug),
      ...state.concepts.map((concept) => concept.id),
    ]);
    const now = Date.now();
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

  private async readVerifiedSourceBytes(source: SourceRecord): Promise<{
    absolute: string;
    bytes: Buffer;
  }> {
    const absolute = await this.store.resolveExisting(source.relativePath);
    const bytes = await readFile(absolute);
    const actualChecksum = sha256(bytes);
    if (actualChecksum !== source.checksum) {
      throw new Error(
        `Source integrity check failed for '${source.id}': expected ${source.checksum}, received ${actualChecksum}. The immutable raw copy may have been modified.`,
      );
    }
    return { absolute, bytes };
  }

  private async validateWikiMarkdown(
    markdown: string,
    declaredSourceIds: string[],
    sources: SourceRecord[],
  ): Promise<void> {
    const body = stripFrontmatter(markdown);
    const citations = parseWikiCitations(body);
    if (citations.length === 0) {
      throw new Error("Wiki pages must contain at least one inline source citation in the form [source_id#L1-L4].");
    }

    const excerptsByToken = new Map<string, string>();
    const citedSourceIds = new Set<string>();
    const sourceLines = new Map<string, string[]>();
    for (const citation of citations) {
      if (!declaredSourceIds.includes(citation.sourceId)) {
        throw new Error(
          `Citation ${citation.token} references a source not declared in sourceIds.`,
        );
      }
      const source = sources.find((candidate) => candidate.id === citation.sourceId);
      if (!source) {
        throw new Error(`Citation ${citation.token} references an unknown source.`);
      }
      let lines = sourceLines.get(source.id);
      if (!lines) {
        lines = (await this.readSourceText(source)).replace(/\r\n/g, "\n").split("\n");
        sourceLines.set(source.id, lines);
      }
      if (
        citation.lineStart < 1
        || citation.lineEnd < citation.lineStart
        || citation.lineEnd > lines.length
      ) {
        throw new Error(
          `Citation ${citation.token} points outside source '${source.id}', which has ${lines.length} line${lines.length === 1 ? "" : "s"}.`,
        );
      }
      if (citation.lineEnd - citation.lineStart + 1 > MAX_CITATION_LINES) {
        throw new Error(
          `Citation ${citation.token} spans more than ${MAX_CITATION_LINES} lines; cite a more precise passage.`,
        );
      }
      excerptsByToken.set(
        citation.token,
        lines.slice(citation.lineStart - 1, citation.lineEnd).join("\n"),
      );
      citedSourceIds.add(citation.sourceId);
    }

    const uncitedSources = declaredSourceIds.filter((sourceId) => !citedSourceIds.has(sourceId));
    if (uncitedSources.length > 0) {
      throw new Error(
        `Every declared source must be cited in the page body. Missing: ${uncitedSources.join(", ")}`,
      );
    }

    for (const block of wikiClaimBlocks(body)) {
      const blockCitations = parseWikiCitations(block);
      const claim = stripCitationAndMarkdownSyntax(block);
      const claimTokens = lexicalSupportTokens(claim);
      if (claimTokens.length === 0) continue;
      if (blockCitations.length === 0) {
        throw new Error(
          `Every factual prose block needs an inline source citation. Uncited block: "${claim.slice(0, 120)}"`,
        );
      }
      const evidence = blockCitations
        .map((citation) => excerptsByToken.get(citation.token) ?? "")
        .join("\n");
      const evidenceTokens = new Set(lexicalSupportTokens(evidence));
      const overlap = claimTokens.filter((token) => evidenceTokens.has(token)).length;
      const requiredOverlap = Math.min(
        claimTokens.length,
        Math.max(2, Math.ceil(claimTokens.length / 2)),
      );
      if (overlap < requiredOverlap) {
        throw new Error(
          `The cited passage does not lexically support this wiki block (${overlap}/${requiredOverlap} required distinctive terms matched): "${claim.slice(0, 120)}"`,
        );
      }
    }
  }

  private async extractPdf(absolutePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("pdftotext", ["-layout", "-nopgbrk", absolutePath, "-"], {
        maxBuffer: 20 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      throw new Error(`Could not extract PDF text. Install Poppler's pdftotext. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private preview(text: string): string {
    const cleaned = text.trim();
    if (cleaned.length <= CONTEXT_LIMITS.sourcePreviewCharacters) return cleaned;
    return `${cleaned.slice(0, CONTEXT_LIMITS.sourcePreviewCharacters).trimEnd()}\n\n_[Preview truncated; search reads the complete source.]_`;
  }

  private suggestConcepts(text: string): string[] {
    const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)]
      .map((match) => match[1]?.trim())
      .filter((heading): heading is string => Boolean(heading));
    const frequencies = new Map<string, number>();
    for (const token of tokenize(text)) {
      if (token.length < 5) continue;
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    const keywords = [...frequencies.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([token]) => token);
    return unique([...headings.slice(0, 6), ...keywords]).slice(0, 8);
  }
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

interface WikiCitation {
  token: string;
  sourceId: string;
  lineStart: number;
  lineEnd: number;
}

function parseWikiCitations(markdown: string): WikiCitation[] {
  return [...markdown.matchAll(WIKI_CITATION_PATTERN)].map((match) => ({
    token: match[0],
    sourceId: match[1]!,
    lineStart: Number(match[2]),
    lineEnd: Number(match[3]),
  }));
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function wikiClaimBlocks(markdown: string): string[] {
  return stripFrontmatter(markdown)
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block
      .split("\n")
      .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
      .join("\n")
      .trim())
    .filter((block) => {
      if (!block) return false;
      if (/^(?:```|~~~)/.test(block)) return false;
      if (/^(?:\$\$|\\\[)/.test(block)) return false;
      if (/^(?:evidence|related|see also|sources?)\s*:/i.test(block)) return false;
      return true;
    });
}

function stripCitationAndMarkdownSyntax(markdown: string): string {
  return markdown
    .replace(WIKI_CITATION_PATTERN, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g, "$1")
    .replace(/[`*_>#|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lexicalSupportTokens(text: string): string[] {
  return unique(tokenize(text)
    .map(normalizeSupportToken)
    .filter((token) => token.length > 1 && !GENERIC_SUPPORT_WORDS.has(token)));
}

function normalizeSupportToken(token: string): string {
  if (token.length > 7 && token.endsWith("ingly")) return token.slice(0, -5);
  if (token.length > 6 && token.endsWith("edly")) return token.slice(0, -4);
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("ly")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function reconcileKnowledgeRelationships(state: StudyState): {
  changed: boolean;
  brokenLinksRemoved: number;
  missingSourceReferencesRemoved: number;
  conceptsCreated: number;
  learnerReferencesRepaired: number;
} {
  const before = JSON.stringify(state);
  const sourceIds = new Set(state.sources.map((source) => source.id));
  const slugs = new Set(state.wikiPages.map((page) => page.slug));
  let brokenLinksRemoved = 0;
  let missingSourceReferencesRemoved = 0;
  let conceptsCreated = 0;
  let learnerReferencesRepaired = 0;

  for (const page of state.wikiPages) {
    page.aliases = unique(page.aliases);
    page.tags = unique(page.tags);
    const knownSources = unique(page.sourceIds.filter((id) => sourceIds.has(id)));
    missingSourceReferencesRemoved += page.sourceIds.length - knownSources.length;
    if (knownSources.length === 0) {
      throw new Error(
        `Cannot repair wiki page '${page.slug}': none of its source records remain.`,
      );
    }
    page.sourceIds = knownSources;
    const validLinks = unique(page.links.filter((link) =>
      link !== page.slug && slugs.has(link)));
    brokenLinksRemoved += page.links.length - validLinks.length;
    page.links = validLinks;

    let concept = state.concepts.find((candidate) => candidate.id === page.slug);
    if (!concept) {
      concept = {
        id: page.slug,
        title: page.title,
        notes: [],
        sourceIds: [...page.sourceIds],
      };
      state.concepts.push(concept);
      conceptsCreated += 1;
    } else {
      concept.title = page.title;
      concept.sourceIds = unique([
        ...concept.sourceIds.filter((id) => sourceIds.has(id)),
        ...page.sourceIds,
      ]);
    }
  }

  for (const concept of state.concepts) {
    const repaired = unique(concept.sourceIds.filter((id) => sourceIds.has(id)));
    if (repaired.length !== concept.sourceIds.length) {
      learnerReferencesRepaired += concept.sourceIds.length - repaired.length;
      concept.sourceIds = repaired;
    }
  }
  return {
    changed: before !== JSON.stringify(state),
    brokenLinksRemoved,
    missingSourceReferencesRemoved,
    conceptsCreated,
    learnerReferencesRepaired,
  };
}

function wikiMetadataCurrent(markdown: string, page: WikiPageRecord): boolean {
  return markdown.includes(`metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`)
    && markdown.includes(`title: ${JSON.stringify(page.title)}`)
    && markdown.includes(
      `aliases: [${page.aliases.map((value) => JSON.stringify(value)).join(", ")}]`,
    )
    && markdown.includes(
      `sources: [${page.sourceIds.map((value) => JSON.stringify(value)).join(", ")}]`,
    )
    && markdown.includes(
      `links: [${page.links.map((value) => JSON.stringify(value)).join(", ")}]`,
    );
}

function bestRecoveryExcerpt(
  sourceText: string,
  queryTokens: ReadonlySet<string>,
): { lineStart: number; lineEnd: number; text: string } | undefined {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  let best: {
    lineStart: number;
    lineEnd: number;
    text: string;
    score: number;
  } | undefined;
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start]?.trim()) continue;
    let end = start;
    let characters = 0;
    while (end < lines.length && end < start + 8) {
      const nextLength = lines[end]!.length + (end > start ? 1 : 0);
      if (end > start && characters + nextLength > 1_400) break;
      characters += nextLength;
      end += 1;
    }
    while (end > start + 1 && !lines[end - 1]?.trim()) end -= 1;
    let text = lines.slice(start, end).join("\n").trim();
    if (text.length > 1_400) text = text.slice(0, 1_400).trimEnd();
    if (!text) continue;
    const score = unique(tokenize(text))
      .filter((token) => queryTokens.has(token)).length;
    if (
      !best
      || score > best.score
      || (score > 0 && score === best.score && text.length < best.text.length)
    ) {
      best = {
        lineStart: start + 1,
        lineEnd: end,
        text,
        score,
      };
    }
  }
  return best && {
    lineStart: best.lineStart,
    lineEnd: best.lineEnd,
    text: best.text,
  };
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart <= secondEnd && secondStart <= firstEnd;
}
