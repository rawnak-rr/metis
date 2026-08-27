import { chmod, copyFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  CompactConceptCapsule,
  ConceptCapsule,
  ConceptRecord,
  EvidenceExcerpt,
  SearchChunk,
  SourceRecord,
  StudyState,
  WikiPageRecord,
} from "../contracts/types.js";
import {
  DERIVED_TEXT_CACHE_DIRECTORY,
  GENERATED_WIKI_FORMAT_VERSION,
  SEARCH_INDEX_CACHE_DIRECTORY,
  StudyStore,
} from "../vault/store.js";
import {
  atomicWrite,
  messageOf,
  newId,
  nowIso,
  sanitizeFilename,
  sha256,
  slugify,
  stripFrontmatter,
  unique,
} from "../shared/util.js";
import {
  IncrementalBm25Index,
  rehydrateChunkText,
  supportFingerprint,
  tokenize,
  type RankedIndexedChunk,
} from "../search/retrieval.js";
import {
  WIKI_CITATION_PATTERN,
  assessClaim,
  lexicalSupportTokens,
  splitClaimUnits,
  stripCitationAndMarkdownSyntax,
  type ClaimAssessment,
} from "../synthesis/claims.js";
import { MetisError, errorPayload, type MetisErrorPayload } from "../shared/errors.js";
import {
  SUPPORTED_SOURCE_EXTENSIONS,
  describeExtraction,
  descriptorForSource,
  extractSourceText,
  isDerivedTextPersisted,
  maxBytesFor,
  sourceTypeFor,
  type SourceTypeDescriptor,
} from "./extract.js";
import { defaultVisionTranscriber, type VisionTranscriber } from "./vision.js";

export { tokenize } from "../search/retrieval.js";
export { lexicalSupportTokens, stemSupport } from "../synthesis/claims.js";

/**
 * Version 2 records a checksum of the derived text itself. Version 1 entries
 * remain readable so an existing vault keeps its transcripts, but they carry no
 * integrity guarantee and `metis_repair` upgrades them in place.
 */
const DERIVED_TEXT_FORMAT_VERSION = 2 as const;
const LEGACY_DERIVED_TEXT_FORMAT_VERSION = 1 as const;
const MAX_CITATION_LINES = 80;
/** Citation tokens resolvable in one `resolveCitations` call. */
const MAX_RESOLVED_CITATIONS = 24;
/** Ceiling on one batch, so a mistaken vault-wide scan fails fast and loudly. */
const MAX_BATCH_SOURCES = 200;
/**
 * Extractions in flight per batch. Each one holds a whole source in memory and
 * `pdftotext` is a subprocess, so this trades throughput for a bounded
 * footprint rather than maximising parallelism.
 */
const BATCH_EXTRACTION_CONCURRENCY = 4;
/** Vault-relative directories Metis generates, never scanned for evidence. */
const MANAGED_VAULT_DIRECTORIES = new Set(["raw", "wiki", ".metis"]);
export const CONTEXT_LIMITS = {
  conceptMatches: 3,
  sourceResultsDefault: 3,
  sourceResultsMaximum: 6,
  sourceChunkCharacters: 1_400,
  sourceSearchTextCharacters: 4_200,
  sourcePreviewCharacters: 800,
  activeMisconceptions: 2,
  batchSuggestedConcepts: 12,
  batchLogDetailLines: 20,
} as const;
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

export interface IngestManyInput {
  /** Explicit vault-relative files; mutually exclusive with `directory`. */
  sourcePaths?: string[];
  /** Vault-relative directory to scan; mutually exclusive with `sourcePaths`. */
  directory?: string;
  recursive?: boolean;
  /** Restrict a directory scan to these extensions, with or without the dot. */
  extensions?: string[];
  /** Applied to every source ingested by this batch. */
  tags?: string[];
}

export interface IngestManyItem {
  sourcePath: string;
  status: "ingested" | "duplicate" | "failed";
  /** The new record, or the existing one an identical file resolved to. */
  source?: SourceRecord;
  error?: MetisErrorPayload;
}

export interface IngestManyResult {
  requested: number;
  ingested: number;
  duplicates: number;
  failed: number;
  /**
   * Unsupported files a directory scan filtered out. Counted rather than
   * itemised, so scanning a directory of mixed content stays bounded.
   */
  skipped: number;
  items: IngestManyItem[];
  suggestedConcepts: string[];
}

/** One source staged through extraction, not yet recorded in state. */
interface PreparedSource {
  source: SourceRecord;
  text: string;
  preview: string;
  rawCopyAbsolute: string;
  derivedTextWritten: boolean;
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
      | "unsupported_claim"
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
  derivedText: {
    /** Sources whose text cannot be recomputed from the raw bytes. */
    expected: number;
    /** Entries whose text matched its recorded checksum. */
    verified: number;
    /** Pre-checksum entries rewritten with one. */
    upgraded: number;
    /** Pre-checksum entries left as they are, in a dry run. */
    unverified: number;
    /**
     * Sources with no usable entry. Their line citations cannot be resolved,
     * and for an image transcript nothing but a backup can recover them.
     */
    missingSourceIds: string[];
    staleEntriesRemoved: number;
  };
}

export interface ResolvedCitation {
  token: string;
  sourceId: string;
  title: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  /** The raw source's digest, verified immediately before this read. */
  sourceChecksum: string;
  /** How the cited text was derived, so a transcript stays distinguishable. */
  extraction: string;
}

export interface UnresolvedCitation {
  token: string;
  error: MetisErrorPayload;
}

export interface CitationResolution {
  resolved: ResolvedCitation[];
  unresolved: UnresolvedCitation[];
}

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

type WikiValidationLevel = "structural" | "strict";

interface WikiValidationContext {
  body: string;
  excerptsByToken: ReadonlyMap<string, string>;
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

  private readonly vision: VisionTranscriber;

  constructor(
    private readonly store: StudyStore,
    vision: VisionTranscriber = defaultVisionTranscriber(),
  ) {
    this.vision = vision;
  }

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
        await this.validateWikiMarkdown(
          markdown,
          page.sourceIds,
          state.sources,
          "structural",
        );
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
    const derivedText = await this.repairDerivedText(state.sources, dryRun);
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
      derivedText,
    };
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const title = input.title.trim();
    if (!title) {
      throw new MetisError("INGEST_TITLE_EMPTY", "Source title cannot be empty.");
    }
    if ((input.content === undefined) === (input.sourcePath === undefined)) {
      throw new MetisError(
        "INGEST_INPUT_AMBIGUOUS",
        "Provide exactly one of content or sourcePath.",
      );
    }

    const staged = input.sourcePath === undefined
      ? stageInlineContent(input.content ?? "", title)
      : await this.stageVaultFile(input.sourcePath, title);

    const checksum = sha256(staged.bytes);
    const current = await this.store.readState();
    const existing = current.sources.find((source) => source.checksum === checksum);
    if (existing) {
      // Identical bytes already carry verified text; never pay for extraction,
      // and never re-transcribe an image, to answer a duplicate ingestion.
      const text = await this.readSourceText(existing);
      await this.indexIngestedSource(existing, text);
      return {
        source: existing,
        duplicate: true,
        preview: this.preview(text),
        suggestedConcepts: this.suggestConcepts(text),
      };
    }

    const prepared = await this.prepareSource({
      title,
      staged,
      checksum,
      tags: input.tags ?? [],
    });
    try {
      await this.store.mutateManaged(
        (state) => {
          state.sources.push(prepared.source);
        },
        () => ({
          sourcePages: [{ source: prepared.source, preview: prepared.preview }],
          rebuildWikiIndex: true,
          log: {
            operation: "ingest",
            title: prepared.source.title,
            details: [
              `Source ID: \`${prepared.source.id}\``,
              `Stored immutable raw copy at \`${prepared.source.relativePath}\``,
              `Checksum: \`${prepared.source.checksum}\``,
              `Text extraction: \`${describeExtraction(prepared.source)}\``,
            ],
          },
        }),
      );
    } catch (error) {
      // Nothing is committed until state is written, so a failed commit must
      // leave no read-only orphan under raw/ and no derived text behind.
      await this.discardPrepared([prepared]);
      throw ingestionFailure(error);
    }
    await this.indexIngestedSource(prepared.source, prepared.text);
    return {
      source: prepared.source,
      duplicate: false,
      preview: prepared.preview,
      suggestedConcepts: this.suggestConcepts(prepared.text),
    };
  }

  /**
   * Ingest many vault files in one call.
   *
   * Extraction is per item and independent: one unreadable file is reported as
   * a failure without disturbing the rest. The state commit is shared, so the
   * batch pays one state write, one wiki index rebuild, and one log entry
   * instead of one of each per file, and a failed commit rolls the whole batch
   * back rather than leaving some sources recorded and others staged.
   */
  async ingestMany(input: IngestManyInput): Promise<IngestManyResult> {
    if ((input.sourcePaths === undefined) === (input.directory === undefined)) {
      throw new MetisError(
        "INGEST_INPUT_AMBIGUOUS",
        "Provide exactly one of sourcePaths or directory.",
      );
    }

    const scan = input.directory === undefined
      ? { paths: normalizeBatchPaths(input.sourcePaths ?? []), skipped: 0 }
      : await this.scanIngestDirectory(input);
    // A directory scan skips Metis-managed directories; an explicit work list
    // has to be held to the same rule, or a generated wiki page can be handed
    // back in as fresh evidence.
    const managed = scan.paths.filter(isManagedVaultPath);
    if (managed.length > 0) {
      throw new MetisError(
        "INGEST_SOURCE_MANAGED",
        `${managed.length} path(s) are inside a Metis-managed directory (${[...MANAGED_VAULT_DIRECTORIES].join(", ")}), which holds immutable raw copies and generated pages. Ingesting them would re-ingest Metis's own output as fresh evidence.`,
        { detail: `First: '${managed[0]}'` },
      );
    }
    if (scan.paths.length === 0) {
      throw new MetisError(
        "INGEST_BATCH_EMPTY",
        input.directory === undefined
          ? "No source paths were provided."
          : `No supported source files were found under '${input.directory}'. Supported: ${SUPPORTED_SOURCE_EXTENSIONS.join(", ")}`,
        scan.skipped > 0
          ? { detail: `${scan.skipped} file(s) were skipped as unsupported types.` }
          : {},
      );
    }
    if (scan.paths.length > MAX_BATCH_SOURCES) {
      throw new MetisError(
        "INGEST_BATCH_TOO_LARGE",
        `This batch has ${scan.paths.length} files, above the ${MAX_BATCH_SOURCES}-file limit. Ingest it in smaller batches.`,
      );
    }

    const current = await this.store.readState();
    const committed = new Map(
      current.sources.map((source) => [source.checksum, source]),
    );
    // Guards against two byte-identical files inside one batch: the first to
    // claim a checksum becomes the record, and the rest await its outcome. The
    // claim is registered before the first await, because extraction of two
    // identical files would otherwise interleave and record both.
    const staging = new Map<string, Promise<SourceRecord>>();
    const prepared: PreparedSource[] = [];
    const items = new Array<IngestManyItem>(scan.paths.length);

    try {
      await mapWithConcurrency(
        scan.paths,
        BATCH_EXTRACTION_CONCURRENCY,
        async (sourcePath, index) => {
          try {
            const title = batchTitleFor(sourcePath);
            const staged = await this.stageVaultFile(sourcePath, title);
            const checksum = sha256(staged.bytes);
            const committedDuplicate = committed.get(checksum);
            if (committedDuplicate) {
              items[index] = {
                sourcePath,
                status: "duplicate",
                source: committedDuplicate,
              };
              return;
            }
            const claimed = staging.get(checksum);
            if (claimed) {
              // Identical bytes are already being staged by this batch; its
              // record is this file's record too. If that staging fails, this
              // file fails with it, since extracting it would fail the same way.
              items[index] = {
                sourcePath,
                status: "duplicate",
                source: await claimed,
              };
              return;
            }
            const claim = new DeferredSource();
            staging.set(checksum, claim.promise);
            let entry: PreparedSource;
            try {
              entry = await this.prepareSource({
                title,
                staged,
                checksum,
                tags: input.tags ?? [],
              });
            } catch (error) {
              // Release the claim so a later identical file may retry a
              // transient failure rather than inheriting this one.
              staging.delete(checksum);
              claim.reject(error);
              throw error;
            }
            claim.resolve(entry.source);
            prepared.push(entry);
            items[index] = {
              sourcePath,
              status: "ingested",
              source: entry.source,
            };
          } catch (error) {
            // prepareSource already discarded whatever it staged, so one bad
            // file costs nothing beyond its own result entry.
            items[index] = {
              sourcePath,
              status: "failed",
              error: errorPayload(error),
            };
          }
        },
      );

      if (prepared.length > 0) {
        await this.store.mutateManaged(
          (state) => {
            for (const entry of prepared) state.sources.push(entry.source);
          },
          () => ({
            sourcePages: prepared.map((entry) => ({
              source: entry.source,
              preview: entry.preview,
            })),
            rebuildWikiIndex: true,
            log: batchLogEntry(input, items, prepared),
          }),
        );
      }
    } catch (error) {
      await this.discardPrepared(prepared);
      throw ingestionFailure(error);
    }

    // The batch is committed from here on, so nothing below may throw: failing
    // the call would report total failure for sources already written to state,
    // the wiki, and the log, and the caller would re-run the batch only to be
    // told everything is a duplicate. The index is rebuilt from state on load,
    // so a failure is recorded on its item and the result still stands. A
    // duplicate is indexed too, exactly as a single duplicate ingestion is.
    const preparedText = new Map(
      prepared.map((entry) => [entry.source.id, entry.text]),
    );
    for (const item of items) {
      if (!item.source || this.retrievalIndex.hasSource(item.source)) continue;
      try {
        const text = preparedText.get(item.source.id)
          ?? await this.readSourceText(item.source);
        await this.indexIngestedSource(item.source, text);
      } catch (error) {
        item.error = errorPayload(error);
      }
    }

    const concepts = unique(prepared.flatMap((entry) =>
      this.suggestConcepts(entry.text))).slice(0, CONTEXT_LIMITS.batchSuggestedConcepts);
    return {
      requested: scan.paths.length,
      ingested: prepared.length,
      duplicates: items.filter((item) => item.status === "duplicate").length,
      failed: items.filter((item) => item.status === "failed").length,
      skipped: scan.skipped,
      items,
      suggestedConcepts: concepts,
    };
  }

  /**
   * Stage one source through to text that is ready to commit: an immutable
   * verified raw copy, extracted text, and persisted derived text where the
   * derivation cannot be repeated. Throws a coded failure after removing
   * everything it staged, so no caller can leave an orphan behind.
   */
  private async prepareSource(input: {
    title: string;
    staged: StagedSource;
    checksum: string;
    tags: string[];
  }): Promise<PreparedSource> {
    const { title, staged, checksum } = input;
    const sourceId = newId("src");
    const targetRelative = path.posix.join(
      "raw",
      `${sourceId}-${sanitizeFilename(title, "source")}${staged.extension}`,
    );
    let rawCopyAbsolute: string | undefined;
    let derivedTextWritten = false;
    try {
      const targetAbsolute = await resolveIngestTarget(this.store, targetRelative);
      if (staged.absolutePath === undefined) {
        await atomicWrite(targetAbsolute, staged.bytes.toString("utf8"));
      } else {
        await copyFile(staged.absolutePath, targetAbsolute);
      }
      rawCopyAbsolute = targetAbsolute;

      const storedBytes = await readFile(targetAbsolute);
      if (sha256(storedBytes) !== checksum) {
        throw new MetisError(
          "INGEST_COPY_VERIFICATION_FAILED",
          "Source copy verification failed before ingestion was committed.",
        );
      }
      await chmod(targetAbsolute, 0o444);

      const extracted = await extractSourceText({
        descriptor: staged.descriptor,
        bytes: storedBytes,
        absolutePath: targetAbsolute,
        title,
        transcriber: this.vision,
      });
      if (!extracted.text.trim()) {
        throw new MetisError(
          "EXTRACT_EMPTY_TEXT",
          `No searchable text could be extracted from '${title}', so it cannot be stored as citable evidence.`,
        );
      }

      const source: SourceRecord = {
        id: sourceId,
        title,
        kind: staged.descriptor.kind,
        relativePath: targetRelative,
        checksum,
        tags: unique(input.tags.map((tag) => tag.trim()).filter(Boolean)),
        ingestedAt: nowIso(),
        extraction: {
          method: staged.descriptor.method,
          ...(staged.descriptor.mediaType
            ? { mediaType: staged.descriptor.mediaType }
            : {}),
          ...(extracted.model ? { model: extracted.model } : {}),
          ...(isDerivedTextPersisted(staged.descriptor.method)
            ? { extractedAt: nowIso() }
            : {}),
        },
        ...(staged.originalPath ? { originalPath: staged.originalPath } : {}),
      };
      derivedTextWritten = await this.persistDerivedText(source, extracted.text);
      if (!derivedTextWritten && source.extraction.method === "vision") {
        // A transcript is the only record of an image's text, and re-running the
        // model would not reproduce it, so abandon rather than store evidence
        // whose line citations cannot be recovered.
        throw new MetisError(
          "INGEST_COMMIT_FAILED",
          `The transcript for '${title}' could not be persisted under ${DERIVED_TEXT_CACHE_DIRECTORY}, so ingestion was abandoned.`,
        );
      }

      return {
        source,
        text: extracted.text,
        preview: this.preview(extracted.text),
        rawCopyAbsolute,
        derivedTextWritten,
      };
    } catch (error) {
      if (rawCopyAbsolute) await discardFile(rawCopyAbsolute);
      if (derivedTextWritten) await this.discardDerivedText(checksum);
      throw ingestionFailure(error);
    }
  }

  /** Undo everything a prepared batch staged, after a failed shared commit. */
  private async discardPrepared(prepared: PreparedSource[]): Promise<void> {
    for (const entry of prepared) {
      await discardFile(entry.rawCopyAbsolute);
      if (entry.derivedTextWritten) {
        await this.discardDerivedText(entry.source.checksum);
      }
    }
  }

  /**
   * List the supported source files under a vault directory.
   *
   * Metis-managed directories are never scanned: `raw/` holds the immutable
   * copies of already-ingested sources and `wiki/` holds generated pages, so
   * including them would re-ingest Metis's own output as fresh evidence.
   */
  private async scanIngestDirectory(
    input: IngestManyInput,
  ): Promise<{ paths: string[]; skipped: number }> {
    const root = (input.directory ?? "").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (isManagedVaultPath(root)) {
      throw new MetisError(
        "INGEST_DIRECTORY_MANAGED",
        `'${input.directory}' is a Metis-managed directory holding already-ingested raw copies and generated pages, so scanning it would re-ingest Metis's own output. Point the scan at the directory your unprocessed files live in.`,
      );
    }
    const allowed = input.extensions === undefined
      ? undefined
      : new Set(input.extensions.map((extension) =>
        (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase()));
    const rootAbsolute = await resolveIngestSource(
      this.store,
      root === "" ? "." : root,
      "directory",
      input.directory,
    );
    // Without this, a file passed as `directory` reaches readdir and surfaces a
    // raw ENOTDIR as UNEXPECTED_ERROR instead of a coded request failure.
    if (!(await stat(rootAbsolute)).isDirectory()) {
      throw new MetisError(
        "INGEST_SOURCE_NOT_A_DIRECTORY",
        `Vault-relative path '${input.directory}' is a file, not a directory. Pass it as sourcePaths to ingest it.`,
      );
    }

    const paths: string[] = [];
    let skipped = 0;
    const walk = async (relative: string): Promise<void> => {
      const absolute = await this.store.resolveExisting(relative === "" ? "." : relative);
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = relative === "" ? entry.name : path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
          if (
            !input.recursive
            || entry.name.startsWith(".")
            || isManagedVaultPath(child)
          ) {
            continue;
          }
          await walk(child);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".")) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (allowed !== undefined && !allowed.has(extension)) continue;
        if (!sourceTypeFor(extension)) {
          // A directory scan is a filter, not an assertion that every file in
          // it is evidence, so an unsupported type is skipped, not failed.
          skipped += 1;
          continue;
        }
        paths.push(child);
      }
    };
    await walk(root);
    return { paths: normalizeBatchPaths(paths), skipped };
  }

  /** Resolve, size-check, and classify a vault-relative ingestion input. */
  private async stageVaultFile(
    sourcePath: string,
    title: string,
  ): Promise<StagedSource> {
    const extension = path.extname(sourcePath).toLowerCase();
    const descriptor = sourceTypeFor(extension);
    if (!descriptor) {
      throw new MetisError(
        "INGEST_UNSUPPORTED_TYPE",
        `Unsupported source type '${extension || "(none)"}'. Supported: ${SUPPORTED_SOURCE_EXTENSIONS.join(", ")}`,
      );
    }
    const absolutePath = await resolveIngestSource(this.store, sourcePath, "file");
    const details = await stat(absolutePath);
    if (!details.isFile()) {
      throw new MetisError(
        "INGEST_SOURCE_NOT_A_FILE",
        `Vault-relative path '${sourcePath}' is not a regular file.`,
      );
    }
    const limit = maxBytesFor(descriptor);
    if (details.size > limit) {
      throw new MetisError(
        "INGEST_SOURCE_TOO_LARGE",
        `Source '${title}' is ${details.size} bytes, above the ${limit}-byte limit for ${descriptor.kind} sources. Split it into smaller documents.`,
      );
    }
    return {
      bytes: await readFile(absolutePath),
      extension,
      descriptor,
      absolutePath,
      originalPath: sourcePath,
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
    await this.validateWikiMarkdown(
      input.markdown,
      sourceIds,
      state.sources,
      "strict",
    );

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

  /**
   * Opens concept lookup and source search over a single state snapshot and one
   * concept index, so multi-facet retrieval does not reload the vault per facet.
   */
  async openRetrieval(): Promise<RetrievalSession> {
    const state = await this.store.readState();
    const index = this.buildConceptIndex(state);
    return {
      lookupConcepts: (query, limit = CONTEXT_LIMITS.conceptMatches) =>
        this.lookupConceptsIn(index, query, limit),
      sourceIdsForConcepts: (keys) => sourceIdsForConceptsIn(state, keys),
      search: (
        query,
        limit = CONTEXT_LIMITS.sourceResultsDefault,
        options = {},
      ) => this.searchSources(state, query, limit, options),
    };
  }

  async lookupConcepts(
    query: string,
    limit: number = CONTEXT_LIMITS.conceptMatches,
  ): Promise<ConceptCapsule[]> {
    const index = this.buildConceptIndex(await this.store.readState());
    return this.lookupConceptsIn(index, query, limit);
  }

  private lookupConceptsIn(
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

  async sourceIdsForConcepts(keys: string[]): Promise<Set<string>> {
    return sourceIdsForConceptsIn(await this.store.readState(), keys);
  }

  async search(
    query: string,
    limit: number = CONTEXT_LIMITS.sourceResultsDefault,
    options: SourceSearchOptions = {},
  ): Promise<SearchChunk[]> {
    return this.searchSources(await this.store.readState(), query, limit, options);
  }

  private async searchSources(
    state: StudyState,
    query: string,
    limit: number,
    options: SourceSearchOptions,
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
    await this.validateWikiMarkdown(
      markdown,
      page.sourceIds,
      sources,
      "structural",
    );
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

    const staleEntriesRemoved = await this.pruneDerivedCache(
      SEARCH_INDEX_CACHE_DIRECTORY,
      new Set(sources.map((source) => `${source.checksum}.json`)),
      dryRun,
    );

    return {
      reused,
      rebuilt,
      staleEntriesRemoved,
      indexedSources: dryRun
        ? reused
        : this.retrievalIndex.sourceCount(),
      indexedChunks: this.retrievalIndex.chunkCount(),
    };
  }

  /**
   * Derived text is only expected for sources whose extraction is expensive or
   * non-deterministic; every other entry in the cache is stale.
   */
  private async repairDerivedText(
    sources: SourceRecord[],
    dryRun: boolean,
  ): Promise<KnowledgeRepairResult["derivedText"]> {
    const persisted = sources
      .filter((source) => isDerivedTextPersisted(source.extraction.method));
    const expected = new Set(persisted.map((source) => `${source.checksum}.json`));
    const staleEntriesRemoved = await this.pruneDerivedCache(
      DERIVED_TEXT_CACHE_DIRECTORY,
      expected,
      dryRun,
    );
    // Counting the entries state expects would report a healthy cache for one
    // that is entirely absent, so each entry is read and checked instead.
    let verified = 0;
    let upgraded = 0;
    let unverified = 0;
    const missingSourceIds: string[] = [];
    for (const source of persisted) {
      const stored = await this.readDerivedText(source);
      if (!stored) {
        missingSourceIds.push(source.id);
        continue;
      }
      if (stored.verified) {
        verified += 1;
        continue;
      }
      if (dryRun) {
        unverified += 1;
        continue;
      }
      if (await this.persistDerivedText(source, stored.text)) {
        upgraded += 1;
      } else {
        unverified += 1;
      }
    }
    return {
      expected: persisted.length,
      verified,
      upgraded,
      unverified,
      missingSourceIds,
      staleEntriesRemoved,
    };
  }

  private async pruneDerivedCache(
    relativeDirectory: string,
    expectedEntries: ReadonlySet<string>,
    dryRun: boolean,
  ): Promise<number> {
    const cacheRoot = await this.store.resolveExisting(relativeDirectory);
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    const stale = entries.filter((entry) =>
      (entry.isFile() || entry.isSymbolicLink())
      && !expectedEntries.has(entry.name));
    if (!dryRun) {
      for (const entry of stale) {
        await unlink(await this.store.resolveForWrite(
          path.posix.join(relativeDirectory, entry.name),
        ));
      }
    }
    return stale.length;
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

  /**
   * Read the exact lines a citation token addresses.
   *
   * This is deliberately not a search: a token resolves through the source's
   * identity and line range alone, so the same token returns the same text
   * regardless of what else has been ingested since. That is what makes a
   * citation usable as a durable stand-in for the excerpt it names, and it is
   * why the ranker is not involved. Every read re-verifies the raw source's
   * checksum, so a token cannot resolve against modified evidence.
   *
   * One bad token is reported in `unresolved` rather than failing the batch,
   * because a caller rehydrating a page wants the excerpts it can still get.
   */
  async resolveCitations(tokens: string[]): Promise<CitationResolution> {
    const requested = unique(tokens.map((token) => token.trim()).filter(Boolean));
    if (requested.length > MAX_RESOLVED_CITATIONS) {
      throw new MetisError(
        "CITATION_BATCH_TOO_LARGE",
        `Resolve at most ${MAX_RESOLVED_CITATIONS} citations per call; ${requested.length} were requested.`,
      );
    }
    const state = await this.store.readState();
    const sourcesById = new Map(state.sources.map((source) => [source.id, source]));
    const linesBySourceId = new Map<string, string[]>();
    const resolved: ResolvedCitation[] = [];
    const unresolved: UnresolvedCitation[] = [];

    for (const token of requested) {
      try {
        const citation = parseSingleCitation(token);
        const source = sourcesById.get(citation.sourceId);
        if (!source) {
          throw new MetisError(
            "CITATION_SOURCE_UNKNOWN",
            `Citation ${token} references source '${citation.sourceId}', which is not in this vault.`,
          );
        }
        let lines = linesBySourceId.get(source.id);
        if (!lines) {
          lines = sourceTextLines(await this.readSourceText(source));
          linesBySourceId.set(source.id, lines);
        }
        resolved.push({
          token: citation.token,
          sourceId: source.id,
          title: source.title,
          lineStart: citation.lineStart,
          lineEnd: citation.lineEnd,
          text: sliceCitedLines(lines, citation),
          sourceChecksum: source.checksum,
          extraction: describeExtraction(source),
        });
      } catch (error) {
        unresolved.push({
          token,
          error: errorPayload(error instanceof MetisError
            ? error
            : new MetisError("CITATION_MALFORMED", messageOf(error))),
        });
      }
    }
    return { resolved, unresolved };
  }

  async readSourceText(source: SourceRecord): Promise<string> {
    // Integrity is verified before any cached text is trusted, so tampering with
    // a raw copy can never be masked by an earlier read.
    const { absolute, bytes } = await this.readVerifiedSourceBytes(source);
    const cached = this.sourceTextCache.get(source.id);
    if (cached?.checksum === source.checksum) return cached.text;
    const descriptor = descriptorForSource(source);
    const persistent = isDerivedTextPersisted(descriptor.method);
    if (persistent) {
      const stored = await this.readDerivedText(source);
      if (stored !== undefined) {
        this.sourceTextCache.set(source.id, {
          checksum: source.checksum,
          text: stored.text,
        });
        return stored.text;
      }
      if (descriptor.method === "vision") {
        // Re-running the model would produce a different transcript, so every
        // line citation into this source would silently address different text.
        // Failing loudly keeps a dead citation distinguishable from a moved one.
        throw new MetisError(
          "DERIVED_TEXT_UNRECOVERABLE",
          `The stored transcript for '${source.id}' is missing or failed its integrity check, and an image transcript cannot be reproduced. Restore ${DERIVED_TEXT_CACHE_DIRECTORY} from a Metis backup; re-transcribing would move every line citation into this source.`,
        );
      }
    }
    const extracted = await extractSourceText({
      descriptor,
      bytes,
      absolutePath: absolute,
      title: source.title,
      transcriber: this.vision,
    });
    if (persistent) await this.persistDerivedText(source, extracted.text);
    this.sourceTextCache.set(source.id, {
      checksum: source.checksum,
      text: extracted.text,
    });
    return extracted.text;
  }

  /**
   * Persist text whose derivation is expensive (PDF) or non-deterministic
   * (vision), so repeated reads are cheap and image line citations stay stable.
   * Returns whether a file was written.
   */
  private async persistDerivedText(
    source: SourceRecord,
    text: string,
  ): Promise<boolean> {
    if (!isDerivedTextPersisted(source.extraction.method)) return false;
    try {
      await atomicWrite(
        await this.store.resolveForWrite(derivedTextRelativePath(source.checksum)),
        `${JSON.stringify({
          formatVersion: DERIVED_TEXT_FORMAT_VERSION,
          sourceChecksum: source.checksum,
          textChecksum: sha256(text),
          method: source.extraction.method,
          ...(source.extraction.model ? { model: source.extraction.model } : {}),
          extractedAt: source.extraction.extractedAt ?? nowIso(),
          text,
        })}\n`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read stored derived text. A current entry is only returned when the text
   * matches its own recorded checksum, so a truncated or edited cache file is
   * indistinguishable from an absent one. A legacy entry predates that checksum
   * and is returned unverified rather than discarded, because discarding it
   * would strand the citations that depend on it.
   */
  private async readDerivedText(
    source: SourceRecord,
  ): Promise<{ text: string; verified: boolean } | undefined> {
    try {
      const raw = await this.store.readText(derivedTextRelativePath(source.checksum));
      const value = JSON.parse(raw) as {
        formatVersion?: unknown;
        sourceChecksum?: unknown;
        textChecksum?: unknown;
        method?: unknown;
        text?: unknown;
      };
      if (
        value.sourceChecksum !== source.checksum
        || value.method !== source.extraction.method
        || typeof value.text !== "string"
      ) {
        return undefined;
      }
      if (value.formatVersion === DERIVED_TEXT_FORMAT_VERSION) {
        if (value.textChecksum !== sha256(value.text)) return undefined;
        return { text: value.text, verified: true };
      }
      if (value.formatVersion === LEGACY_DERIVED_TEXT_FORMAT_VERSION) {
        return { text: value.text, verified: false };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async discardDerivedText(checksum: string): Promise<void> {
    try {
      await unlink(await this.store.resolveForWrite(derivedTextRelativePath(checksum)));
    } catch {
      // A missing or unreadable cache entry needs no cleanup.
    }
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
          const validation = await this.validateWikiMarkdown(
            markdown,
            page.sourceIds,
            state.sources,
            "structural",
          );
          try {
            this.validateWikiLexicalBlocks(validation);
          } catch (error) {
            issues.push({
              severity: "error",
              code: "invalid_citation",
              page: page.slug,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          for (const assessment of this.assessWikiClaims(validation)) {
            if (assessment.status !== "unsupported" || assessment.kind !== "checkable") {
              continue;
            }
            const unmatched = assessment.unmatched.slice(0, 8).join(", ");
            const more = assessment.unmatched.length > 8 ? ", ..." : "";
            issues.push({
              severity: "info",
              code: "unsupported_claim",
              page: page.slug,
              message: `The cited passage does not lexically support this wiki claim (${assessment.matched}/${assessment.required} required distinctive terms matched; unmatched: ${unmatched}${more}): "${assessment.claim.text.slice(0, 120)}"`,
            });
          }
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
      throw new MetisError(
        "SOURCE_INTEGRITY_FAILED",
        `Source integrity check failed for '${source.id}': expected ${source.checksum}, received ${actualChecksum}. The immutable raw copy may have been modified.`,
      );
    }
    return { absolute, bytes };
  }

  private async validateWikiMarkdown(
    markdown: string,
    declaredSourceIds: string[],
    sources: SourceRecord[],
    level: WikiValidationLevel,
  ): Promise<WikiValidationContext> {
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
        lines = sourceTextLines(await this.readSourceText(source));
        sourceLines.set(source.id, lines);
      }
      excerptsByToken.set(citation.token, sliceCitedLines(lines, citation));
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
    }

    const validation = { body, excerptsByToken };
    if (level === "strict") this.validateWikiLexicalBlocks(validation);
    return validation;
  }

  private validateWikiLexicalBlocks(validation: WikiValidationContext): void {
    for (const block of wikiClaimBlocks(validation.body)) {
      const blockCitations = parseWikiCitations(block);
      const claim = stripCitationAndMarkdownSyntax(block);
      const claimTokens = lexicalSupportTokens(claim);
      if (claimTokens.length === 0) continue;
      const evidence = blockCitations
        .map((citation) => validation.excerptsByToken.get(citation.token) ?? "")
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

  private assessWikiClaims(validation: WikiValidationContext): ClaimAssessment[] {
    return wikiClaimBlocks(validation.body).flatMap((block) => {
      const evidence = parseWikiCitations(block)
        .map((citation) => validation.excerptsByToken.get(citation.token) ?? "")
        .join("\n");
      const evidenceTokens = new Set(lexicalSupportTokens(evidence));
      return splitClaimUnits(block)
        .filter((unit) => lexicalSupportTokens(unit.text).length > 0)
        .map((unit) => assessClaim(unit, evidenceTokens));
    });
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

interface StagedSource {
  bytes: Buffer;
  extension: string;
  descriptor: SourceTypeDescriptor;
  absolutePath?: string;
  originalPath?: string;
}

/** Inline content is stored as Markdown, the format wiki synthesis expects. */
function stageInlineContent(content: string, title: string): StagedSource {
  if (!content.trim()) {
    throw new MetisError(
      "INGEST_CONTENT_EMPTY",
      `Inline content for '${title}' is empty, so there is nothing to store as evidence.`,
    );
  }
  const bytes = Buffer.from(content, "utf8");
  const descriptor = sourceTypeFor(".md")!;
  const limit = maxBytesFor(descriptor);
  if (bytes.byteLength > limit) {
    throw new MetisError(
      "INGEST_SOURCE_TOO_LARGE",
      `Inline content for '${title}' is ${bytes.byteLength} bytes, above the ${limit}-byte limit.`,
    );
  }
  return { bytes, extension: ".md", descriptor };
}

/** True for a Metis-generated directory, or anything inside one. */
function isManagedVaultPath(relativePath: string): boolean {
  const first = relativePath.split("/")[0] ?? "";
  return MANAGED_VAULT_DIRECTORIES.has(first);
}

/**
 * A claim on one checksum within a batch, so byte-identical files resolve to
 * the same record without extracting twice. The rejection handler is attached
 * eagerly: a claim nothing else waited on must not surface as an unhandled
 * rejection.
 */
class DeferredSource {
  readonly promise: Promise<SourceRecord>;
  resolve!: (source: SourceRecord) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<SourceRecord>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.catch(() => undefined);
  }
}

/** Dedupe and canonicalise a batch work list without changing its order. */
function normalizeBatchPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const trimmed = candidate.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Title one batched source from its filename, since a batch cannot carry a
 * title per file. Separators become spaces so `chain-rule.md` reads as a title
 * rather than a slug.
 */
function batchTitleFor(sourcePath: string): string {
  const base = path.posix.basename(sourcePath, path.extname(sourcePath));
  const humanized = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (humanized || base || "source").slice(0, 200);
}

/** Run a bounded number of tasks at a time, preserving input indices. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await task(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}

/** One log entry per batch, listing outcomes up to a bounded line count. */
function batchLogEntry(
  input: IngestManyInput,
  items: IngestManyItem[],
  prepared: PreparedSource[],
): { operation: string; title: string; details: string[] } {
  const duplicates = items.filter((item) => item.status === "duplicate").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const scope = input.directory === undefined
    ? `${items.length} path(s)`
    : `\`${input.directory}\`${input.recursive ? " (recursive)" : ""}`;
  const details = [
    `Ingested ${prepared.length}, duplicate ${duplicates}, failed ${failed}`,
  ];
  const reported = items.filter((item) => item.status !== "duplicate");
  for (const item of reported.slice(0, CONTEXT_LIMITS.batchLogDetailLines)) {
    details.push(item.status === "ingested" && item.source
      ? `\`${item.sourcePath}\` → \`${item.source.id}\` (${describeExtraction(item.source)}, \`${item.source.checksum}\`)`
      : `\`${item.sourcePath}\` failed: \`${item.error?.code ?? "UNEXPECTED_ERROR"}\``);
  }
  if (reported.length > CONTEXT_LIMITS.batchLogDetailLines) {
    details.push(`… and ${reported.length - CONTEXT_LIMITS.batchLogDetailLines} more`);
  }
  return { operation: "ingest_batch", title: `Batch ingestion of ${scope}`, details };
}

async function resolveIngestTarget(
  store: StudyStore,
  relativePath: string,
): Promise<string> {
  try {
    return await store.resolveForWrite(relativePath);
  } catch (error) {
    throw new MetisError(
      "INGEST_PATH_OUTSIDE_VAULT",
      messageOf(error),
      { cause: error },
    );
  }
}

async function resolveIngestSource(
  store: StudyStore,
  relativePath: string,
  kind: "file" | "directory",
  reportedPath = relativePath,
): Promise<string> {
  try {
    return await store.resolveExisting(relativePath);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new MetisError(
        "INGEST_SOURCE_NOT_FOUND",
        `No ${kind} exists at vault-relative path '${reportedPath}'.`,
        { cause: error },
      );
    }
    throw new MetisError("INGEST_PATH_OUTSIDE_VAULT", messageOf(error), { cause: error });
  }
}

function derivedTextRelativePath(checksum: string): string {
  return path.posix.join(DERIVED_TEXT_CACHE_DIRECTORY, `${checksum}.json`);
}

/** A read-only raw copy has to be made writable before it can be discarded. */
async function discardFile(absolutePath: string): Promise<void> {
  try {
    await chmod(absolutePath, 0o644);
  } catch {
    // The copy may not exist yet; unlink below reports the real outcome.
  }
  try {
    await unlink(absolutePath);
  } catch {
    // Nothing to remove.
  }
}

/** Preserve coded failures; give every other ingestion failure a stable code. */
function ingestionFailure(error: unknown): unknown {
  if (error instanceof MetisError) return error;
  return new MetisError(
    "INGEST_COMMIT_FAILED",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function sourceIdsForConceptsIn(
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

interface WikiCitation {
  token: string;
  sourceId: string;
  lineStart: number;
  lineEnd: number;
}

function sourceTextLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Bounds and precision rules for a citation, shared by wiki validation and
 * `resolveCitations` so a token that a page may carry is exactly a token that
 * can be resolved later.
 */
function sliceCitedLines(lines: string[], citation: WikiCitation): string {
  if (
    citation.lineStart < 1
    || citation.lineEnd < citation.lineStart
    || citation.lineEnd > lines.length
  ) {
    throw new MetisError(
      "CITATION_OUT_OF_BOUNDS",
      `Citation ${citation.token} points outside source '${citation.sourceId}', which has ${lines.length} line${lines.length === 1 ? "" : "s"}.`,
    );
  }
  if (citation.lineEnd - citation.lineStart + 1 > MAX_CITATION_LINES) {
    throw new MetisError(
      "CITATION_TOO_BROAD",
      `Citation ${citation.token} spans more than ${MAX_CITATION_LINES} lines; cite a more precise passage.`,
    );
  }
  return lines.slice(citation.lineStart - 1, citation.lineEnd).join("\n");
}

function parseSingleCitation(token: string): WikiCitation {
  const citations = parseWikiCitations(token);
  if (citations.length !== 1 || citations[0]!.token !== token) {
    throw new MetisError(
      "CITATION_MALFORMED",
      `'${token}' is not a citation token. Expected one token of the form [source_id#L8-L14].`,
    );
  }
  return citations[0]!;
}

function parseWikiCitations(markdown: string): WikiCitation[] {
  return [...markdown.matchAll(WIKI_CITATION_PATTERN)].map((match) => ({
    token: match[0],
    sourceId: match[1]!,
    lineStart: Number(match[2]),
    lineEnd: Number(match[3]),
  }));
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
