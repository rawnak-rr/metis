import { WIKI_CITATION_PATTERN } from "../contracts/citation.js";
import { isStopWord, tokenizeRaw } from "../shared/lexicon.js";
import { unique } from "../shared/util.js";
const GENERIC_SUPPORT_WORDS = new Set([
  "claim", "concept", "evidence", "fact", "information", "note", "page", "source",
]);
const CONNECTIVE_STARTS = [
  "as a result",
  "for example",
  "in contrast",
  "in other words",
  "in short",
  "however",
  "it",
  "so",
  "that",
  "these",
  "they",
  "this",
  "those",
  "therefore",
] as const;
const MAX_CONNECTIVE_TOKENS = 5;
const KNOWN_ABBREVIATIONS = new Set([
  "cf.",
  "dr.",
  "e.g.",
  "etc.",
  "fig.",
  "i.e.",
  "jr.",
  "mr.",
  "mrs.",
  "ms.",
  "no.",
  "prof.",
  "sr.",
  "st.",
  "vs.",
]);

export interface ClaimUnit {
  text: string;
  index: number;
}

export type ClaimKind = "checkable" | "connective";

export interface ClaimAssessment {
  claim: ClaimUnit;
  kind: ClaimKind;
  status: "supported" | "unsupported";
  matched: number;
  required: number;
  unmatched: string[];
}

/**
 * Split one already-filtered wiki block into sentence-sized claims. List
 * items form separate units even when they omit terminal punctuation.
 */
export function splitClaimUnits(block: string): ClaimUnit[] {
  const segments: string[] = [];
  let paragraph: string[] = [];
  let listItem: string[] | undefined;
  const flushParagraph = (): void => {
    if (paragraph.length > 0) segments.push(paragraph.join(" "));
    paragraph = [];
  };
  const flushListItem = (): void => {
    if (listItem && listItem.length > 0) segments.push(listItem.join(" "));
    listItem = undefined;
  };

  for (const rawLine of block.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/^\s*(?:>\s*)+/, "").trim();
    if (!line) continue;
    const listMatch = line.match(/^(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      flushListItem();
      listItem = [listMatch[1]!];
    } else if (listItem) {
      listItem.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushListItem();

  const units = segments.flatMap(splitSentences)
    .map(stripCitationAndMarkdownSyntax)
    .filter(Boolean);
  return units.map((text, index) => ({ text, index }));
}

export function classifyClaim(unit: ClaimUnit): ClaimKind {
  const normalized = unit.text.toLowerCase();
  const startsWithConnective = CONNECTIVE_STARTS.some((start) =>
    normalized === start
    || normalized.startsWith(`${start} `)
    || normalized.startsWith(`${start},`));
  if (!startsWithConnective) return "checkable";

  const writtenTokens = unit.text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  if (writtenTokens.some((token) => /\d/u.test(token))) return "checkable";
  if (writtenTokens.some((token, index) =>
    /^[A-Z]{2,}$/u.test(token)
    || (index > 0 && /^\p{Lu}/u.test(token)))) {
    return "checkable";
  }
  return lexicalSupportTokens(unit.text).length <= MAX_CONNECTIVE_TOKENS
    ? "connective"
    : "checkable";
}

export function assessClaim(
  unit: ClaimUnit,
  evidenceTokens: ReadonlySet<string>,
): ClaimAssessment {
  const claimTokens = lexicalSupportTokens(unit.text);
  const matched = claimTokens.filter((token) => evidenceTokens.has(token)).length;
  const required = Math.min(
    claimTokens.length,
    Math.max(2, Math.ceil(claimTokens.length / 2)),
  );
  return {
    claim: unit,
    kind: matched >= required ? "checkable" : classifyClaim(unit),
    status: matched >= required ? "supported" : "unsupported",
    matched,
    required,
    unmatched: claimTokens.filter((token) => !evidenceTokens.has(token)),
  };
}

export function lexicalSupportTokens(text: string): string[] {
  return unique(tokenizeRaw(text)
    .filter((word) => !isStopWord(word) && !GENERIC_SUPPORT_WORDS.has(word))
    .map(stemSupport)
    .filter((token) => token.length > 1));
}

/**
 * Aggressive stemming for lexical evidence comparison, which asks whether a
 * claim and its cited excerpt talk about the same things. Inflected forms
 * should collide here even at some cost in precision, so plurals are removed
 * before verb endings ("ratings" -> "rating" -> "rat") and a trailing silent
 * "e" goes last so "hedge", "hedged", "hedges", and "hedging" all agree.
 */
export function stemSupport(token: string): string {
  let stem = token;
  if (stem.length > 4 && stem.endsWith("es")) stem = stem.slice(0, -2);
  else if (
    stem.length > 3
    && stem.endsWith("s")
    // A doubled or vowel-preceded "s" usually belongs to the stem itself
    // ("class", "increas"); stripping it would break idempotence.
    && !/(?:ss|[aeiou]s)$/.test(stem)
  ) {
    stem = stem.slice(0, -1);
  }
  if (stem.length > 7 && stem.endsWith("ingly")) stem = stem.slice(0, -5);
  else if (stem.length > 6 && stem.endsWith("edly")) stem = stem.slice(0, -4);
  else if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith("ly")) stem = stem.slice(0, -2);
  return stem.length > 3 && stem.endsWith("e") ? stem.slice(0, -1) : stem;
}

function splitSentences(text: string): string[] {
  const output: string[] = [];
  let start = 0;
  let inlineCodeTicks = 0;
  let inlineMath = false;
  let parenthesizedMath = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "`" && !inlineMath && !parenthesizedMath) {
      const tickCount = countRun(text, index, "`");
      if (inlineCodeTicks === 0) inlineCodeTicks = tickCount;
      else if (inlineCodeTicks === tickCount) inlineCodeTicks = 0;
      index += tickCount - 1;
      continue;
    }
    if (inlineCodeTicks === 0 && text.startsWith("\\(", index)) {
      parenthesizedMath = true;
      index += 1;
      continue;
    }
    if (parenthesizedMath && text.startsWith("\\)", index)) {
      parenthesizedMath = false;
      index += 1;
      continue;
    }
    if (character === "$" && inlineCodeTicks === 0 && !parenthesizedMath) {
      if (inlineMath || text.indexOf("$", index + 1) >= 0) inlineMath = !inlineMath;
      continue;
    }
    if (inlineCodeTicks > 0 || inlineMath || parenthesizedMath) continue;
    if (![".", "!", "?"].includes(character)) continue;
    const next = text[index + 1];
    if (next !== undefined && !/\s/u.test(next)) continue;
    if (character === "." && isProtectedPeriod(text, index)) continue;

    const sentence = text.slice(start, index + 1).trim();
    if (sentence) output.push(sentence);
    while (index + 1 < text.length && /\s/u.test(text[index + 1]!)) index += 1;
    start = index + 1;
  }

  const remainder = text.slice(start).trim();
  if (remainder) output.push(remainder);
  return output;
}

function countRun(text: string, start: number, character: string): number {
  let end = start + 1;
  while (text[end] === character) end += 1;
  return end - start;
}

/**
 * A period that ends an abbreviation or an initial rather than a sentence.
 * Decimal points need no guard here: `splitSentences` only considers a period
 * followed by whitespace, and "0.5" has a digit there.
 */
function isProtectedPeriod(text: string, index: number): boolean {
  const prefix = text.slice(0, index + 1);
  const token = prefix.match(/(?:^|\s)(\S+)$/)?.[1]?.toLowerCase() ?? "";
  if (KNOWN_ABBREVIATIONS.has(token)) return true;
  if (/^\p{L}\.$/u.test(token)) return true;
  return /^(?:\p{L}\.){2,}$/u.test(token);
}

export function stripCitationAndMarkdownSyntax(markdown: string): string {
  return markdown
    .replace(WIKI_CITATION_PATTERN, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g, "$1")
    .replace(/[`*_>#|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
