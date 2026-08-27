/**
 * The lexical tokenizer: how Metis turns text into comparable terms.
 *
 * Four folders tokenize for different reasons - the BM25 index and its queries,
 * concept lookup keys, wiki claim support, and concept suggestion at ingestion -
 * so the tokenizer sits below all of them. Its behaviour is part of the search
 * index derivation version, so changing anything here invalidates every
 * persisted index by design.
 */
const SIBILANT_STEM = /(?:ss|x|z|ch|sh)$/;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "may", "not", "of", "on", "or", "our", "that", "the",
  "their", "then", "there", "these", "this", "to", "use", "was", "we", "were",
  "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

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
