import { describe, expect, it } from "vitest";
import { lexicalSupportTokens, stemSupport } from "../../src/ingestion/knowledge.js";
import { stemSearch, tokenize, tokenizeRaw } from "../../src/search/retrieval.js";

describe("tokenizeRaw", () => {
  it("splits words without stemming or stopword removal", () => {
    expect(tokenizeRaw("The gradients are steep.")).toEqual([
      "the",
      "gradients",
      "are",
      "steep",
    ]);
  });

  it("trims leading and trailing quotes and hyphens", () => {
    expect(tokenizeRaw("'delta-hedging' --rebalance")).toEqual([
      "delta-hedging",
      "rebalance",
    ]);
  });
});

describe("stemSearch", () => {
  it("folds a regular plural onto its singular", () => {
    for (const [plural, singular] of [
      ["gradients", "gradient"],
      ["models", "model"],
      ["derivatives", "derivative"],
      ["hedges", "hedge"],
    ] as const) {
      expect(stemSearch(plural)).toBe(stemSearch(singular));
    }
  });

  it("folds -es plurals of sibilant stems, which used to keep a dangling e", () => {
    for (const [plural, singular] of [
      ["classes", "class"],
      ["processes", "process"],
      ["boxes", "box"],
      ["matches", "match"],
      ["bushes", "bush"],
    ] as const) {
      expect(stemSearch(plural)).toBe(singular);
      expect(stemSearch(singular)).toBe(singular);
    }
  });

  it("rewrites -ies to -y", () => {
    expect(stemSearch("policies")).toBe("policy");
    expect(stemSearch("studies")).toBe("study");
  });

  it("leaves singulars that merely end in s untouched", () => {
    for (const word of ["analysis", "basis", "status", "class", "process"]) {
      expect(stemSearch(word)).toBe(word);
    }
  });

  it("keeps the final e when the stem ends in a single s, which is ambiguous", () => {
    // "bases" is base+s; "buses" is bus+es. Nothing here can tell them apart,
    // so the conservative reading wins and the "e" stays.
    expect(stemSearch("bases")).toBe("base");
  });

  it("is idempotent", () => {
    for (const word of ["classes", "policies", "gradients", "hedges", "process"]) {
      expect(stemSearch(stemSearch(word))).toBe(stemSearch(word));
    }
  });
});

describe("tokenize", () => {
  it("stems and drops stopwords", () => {
    expect(tokenize("The gradients of these classes")).toEqual([
      "gradient",
      "class",
    ]);
  });

  it("matches a query token against the indexed plural", () => {
    expect(tokenize("process")).toEqual(tokenize("processes"));
  });
});

describe("stemSupport", () => {
  it("collides every inflection of one verb", () => {
    const forms = ["hedge", "hedged", "hedges", "hedging"];
    const stems = new Set(forms.map(stemSupport));
    expect(stems.size).toBe(1);
  });

  it("collides a gerund with its plural", () => {
    expect(stemSupport("ratings")).toBe(stemSupport("rating"));
    expect(stemSupport("rating")).toBe(stemSupport("rated"));
  });

  it("strips adverb endings", () => {
    expect(stemSupport("increasingly")).toBe(stemSupport("increasing"));
  });

  it("is idempotent", () => {
    for (const word of ["hedged", "ratings", "increasingly", "converged", "models"]) {
      expect(stemSupport(stemSupport(word))).toBe(stemSupport(word));
    }
  });

  it("applies once, not on top of the search stemmer", () => {
    // stemSupport reads raw words; feeding it search-stemmed input shifts its
    // length guards and was the source of the old mismatches.
    expect(stemSupport("classes")).toBe(stemSupport("class"));
  });
});

describe("lexicalSupportTokens", () => {
  it("matches a claim against differently inflected evidence", () => {
    const claim = lexicalSupportTokens("A delta hedge reduces option risk.");
    const evidence = new Set(
      lexicalSupportTokens("Delta hedging reduced the risks of these options."),
    );
    for (const token of claim) expect(evidence.has(token)).toBe(true);
  });

  it("drops stopwords and generic scaffolding words", () => {
    expect(lexicalSupportTokens("This is the evidence for that claim")).toEqual([]);
  });

  it("deduplicates", () => {
    const tokens = lexicalSupportTokens("gradient gradients gradient");
    expect(tokens).toEqual([...new Set(tokens)]);
  });
});
