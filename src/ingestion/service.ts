import { chmod, copyFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { SourceRecord } from "../contracts/types.js";
import {
  SUPPORTED_SOURCE_EXTENSIONS,
  describeExtraction,
  isDerivedTextIrreplaceable,
  isDerivedTextPersisted,
  sourceTypeFor,
  type SourceTypeDescriptor,
} from "../contracts/source-types.js";
import {
  MetisError,
  errorPayload,
  type MetisErrorPayload,
} from "../shared/errors.js";
import { CONTEXT_LIMITS } from "../shared/limits.js";
import {
  atomicWrite,
  messageOf,
  newId,
  nowIso,
  sanitizeFilename,
  sha256,
  unique,
} from "../shared/util.js";
import { DERIVED_TEXT_CACHE_DIRECTORY } from "../vault/layout.js";
import { StudyStore } from "../vault/store.js";
import { extractSourceText, maxBytesFor } from "./extract.js";
import { VerifiedSourceReader, preview } from "./source-reader.js";
import { tokenize } from "../shared/lexicon.js";

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

/**
 * Where a newly ingested source is announced to the search index.
 *
 * Ingestion defines this rather than importing the search service, so warming
 * the index stays an effect ingestion requests and never a dependency it owns:
 * the index is derived data that rebuilds itself from state on the next search,
 * so a failure here costs a cold first query and nothing more.
 */
export interface SourceIndexWriter {
  hasSource(source: Pick<SourceRecord, "id" | "checksum">): boolean;
  indexIngestedSource(source: SourceRecord, extractedText: string): Promise<void>;
}

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
/**
 * Bytes into recorded, citable evidence.
 *
 * Ingestion is transactional in both directions: nothing is recorded until text
 * exists, and a failure removes the read-only raw copy and derived text it
 * staged. A batch shares that path per file and the commit across the batch, so
 * one unreadable file is its own coded failure while the state write, wiki index
 * rebuild, and log entry happen once.
 */
export class IngestService {
  constructor(
    private readonly store: StudyStore,
    private readonly reader: VerifiedSourceReader,
    private readonly index: SourceIndexWriter,
  ) {}

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
      const text = await this.reader.readSourceText(existing);
      await this.index.indexIngestedSource(existing, text);
      return {
        source: existing,
        duplicate: true,
        preview: preview(text),
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
    await this.index.indexIngestedSource(prepared.source, prepared.text);
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
      if (!item.source || this.index.hasSource(item.source)) continue;
      try {
        const text = preparedText.get(item.source.id)
          ?? await this.reader.readSourceText(item.source);
        await this.index.indexIngestedSource(item.source, text);
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
        transcriber: this.reader.transcriber,
      });
      if (!extracted.text.trim()) {
        throw new MetisError(
          "EXTRACT_EMPTY_TEXT",
          `No searchable text could be extracted from '${title}', so it cannot be stored as citable evidence.`,
        );
      }

      // Most methods are a pure function of the descriptor, but a PDF's
      // extraction discovers at read time whether it has a text layer, so the
      // method actually used (and its media type, when it fell back to
      // per-page vision) can differ from the static descriptor for `.pdf`.
      const extractionMethod = extracted.method ?? staged.descriptor.method;
      const extractionMediaType = extracted.mediaType ?? staged.descriptor.mediaType;
      const source: SourceRecord = {
        id: sourceId,
        title,
        kind: staged.descriptor.kind,
        relativePath: targetRelative,
        checksum,
        tags: unique(input.tags.map((tag) => tag.trim()).filter(Boolean)),
        ingestedAt: nowIso(),
        extraction: {
          method: extractionMethod,
          ...(extractionMediaType ? { mediaType: extractionMediaType } : {}),
          ...(extracted.model ? { model: extracted.model } : {}),
          ...(isDerivedTextPersisted(extractionMethod) ? { extractedAt: nowIso() } : {}),
        },
        ...(staged.originalPath ? { originalPath: staged.originalPath } : {}),
      };
      derivedTextWritten = await this.reader.persistDerivedText(source, extracted.text);
      if (!derivedTextWritten && isDerivedTextIrreplaceable(source.extraction.method)) {
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
        preview: preview(extracted.text),
        rawCopyAbsolute,
        derivedTextWritten,
      };
    } catch (error) {
      if (rawCopyAbsolute) await discardFile(rawCopyAbsolute);
      if (derivedTextWritten) await this.reader.discardDerivedText(checksum);
      throw ingestionFailure(error);
    }
  }

  /** Undo everything a prepared batch staged, after a failed shared commit. */
  private async discardPrepared(prepared: PreparedSource[]): Promise<void> {
    for (const entry of prepared) {
      await discardFile(entry.rawCopyAbsolute);
      if (entry.derivedTextWritten) {
        await this.reader.discardDerivedText(entry.source.checksum);
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
