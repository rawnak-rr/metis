import {
  pageForLine,
  parseSingleCitation,
  sliceCitedLines,
  sourceTextLines,
} from "../contracts/citation.js";
import { describeExtraction } from "../contracts/source-types.js";
import {
  MetisError,
  errorPayload,
  type MetisErrorPayload,
} from "../shared/errors.js";
import { messageOf, unique } from "../shared/util.js";
import { StudyStore } from "../vault/store.js";
import { VerifiedSourceReader } from "../ingestion/source-reader.js";

// to ensure citations are small
const MAX_RESOLVED_CITATIONS = 24;

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
  /** PDF page range this citation falls in, when the source is a PDF. */
  pdfPageStart?: number;
  pdfPageEnd?: number;
}

export interface UnresolvedCitation {
  token: string;
  error: MetisErrorPayload;
}

export interface CitationResolution {
  resolved: ResolvedCitation[];
  unresolved: UnresolvedCitation[];
}

/**
 * Reads the exact lines a citation token addresses, with no ranker involved.
 *
 * It lives beside search because that is where callers look for it, but it is
 * deliberately not a search: see the note on `resolveCitations` below.
 */
export class CitationResolver {
  constructor(
    private readonly store: StudyStore,
    private readonly reader: VerifiedSourceReader,
  ) {}

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
    const requested = unique(
      tokens.map((token) => token.trim()).filter(Boolean),
    );
    if (requested.length > MAX_RESOLVED_CITATIONS) {
      throw new MetisError(
        "CITATION_BATCH_TOO_LARGE",
        `Resolve at most ${MAX_RESOLVED_CITATIONS} citations per call; ${requested.length} were requested.`,
      );
    }
    const state = await this.store.readState();
    const sourcesById = new Map(
      state.sources.map((source) => [source.id, source]),
    );
    const linesBySourceId = new Map<string, { lines: string[]; lineToPage?: number[] }>();
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
        let entry = linesBySourceId.get(source.id);
        if (!entry) {
          const derived = await this.reader.readSourceTextWithPages(source);
          entry = { lines: sourceTextLines(derived.text), lineToPage: derived.lineToPage };
          linesBySourceId.set(source.id, entry);
        }
        const pdfPageStart = pageForLine(entry.lineToPage, citation.lineStart);
        const pdfPageEnd = pageForLine(entry.lineToPage, citation.lineEnd);
        resolved.push({
          token: citation.token,
          sourceId: source.id,
          title: source.title,
          lineStart: citation.lineStart,
          lineEnd: citation.lineEnd,
          text: sliceCitedLines(entry.lines, citation),
          sourceChecksum: source.checksum,
          extraction: describeExtraction(source),
          ...(pdfPageStart !== undefined ? { pdfPageStart, pdfPageEnd } : {}),
        });
      } catch (error) {
        unresolved.push({
          token,
          error: errorPayload(
            error instanceof MetisError
              ? error
              : new MetisError("CITATION_MALFORMED", messageOf(error)),
          ),
        });
      }
    }
    return { resolved, unresolved };
  }
}
