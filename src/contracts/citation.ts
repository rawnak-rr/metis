import { MetisError } from "../shared/errors.js";

/**
 * The citation token grammar: `[source_id#L8-L14]`.
 *
 * A token is the kernel's durable public handle on a span of evidence. Wiki
 * validation and citation resolution both parse and bound tokens with the code
 * below, so a token a page is allowed to carry is exactly a token that can be
 * resolved later.
 */
export const WIKI_CITATION_PATTERN = /\[([A-Za-z0-9_-]+)#L(\d+)-L(\d+)\]/g;

/** Lines one token may address, so a citation names a passage, not a document. */
const MAX_CITATION_LINES = 80;

export interface WikiCitation {
  token: string;
  sourceId: string;
  lineStart: number;
  lineEnd: number;
}

export function parseWikiCitations(markdown: string): WikiCitation[] {
  return [...markdown.matchAll(WIKI_CITATION_PATTERN)].map((match) => ({
    token: match[0],
    sourceId: match[1]!,
    lineStart: Number(match[2]),
    lineEnd: Number(match[3]),
  }));
}

export function parseSingleCitation(token: string): WikiCitation {
  const citations = parseWikiCitations(token);
  if (citations.length !== 1 || citations[0]!.token !== token) {
    throw new MetisError(
      "CITATION_MALFORMED",
      `'${token}' is not a citation token. Expected one token of the form [source_id#L8-L14].`,
    );
  }
  return citations[0]!;
}

export function sourceTextLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** 1-based PDF page containing `line`, given a per-line page map. */
export function pageForLine(lineToPage: number[] | undefined, line: number): number | undefined {
  return lineToPage?.[line - 1];
}

/**
 * Bounds and precision rules for a citation, shared by wiki validation and
 * citation resolution so a token that a page may carry is exactly a token that
 * can be resolved later.
 */
export function sliceCitedLines(lines: string[], citation: WikiCitation): string {
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
