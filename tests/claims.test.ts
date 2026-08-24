import { describe, expect, it } from "vitest";
import {
  assessClaim,
  classifyClaim,
  lexicalSupportTokens,
  splitClaimUnits,
  type ClaimUnit,
} from "../src/claims.js";

describe("splitClaimUnits", () => {
  it("splits sentences while preserving abbreviations, decimals, and initials", () => {
    expect(splitClaimUnits(
      "The value is 0.5 in Fig. 3, e.g. for A. Smith. The next claim follows.",
    ).map((unit) => unit.text)).toEqual([
      "The value is 0.5 in Fig. 3, e.g. for A. Smith.",
      "The next claim follows.",
    ]);
  });

  it("splits a sentence whose last character is a digit", () => {
    expect(splitClaimUnits(
      "The learning rate is 0.001. Momentum defaults to 0.9. Adam beats SGD in 2019.",
    ).map((unit) => unit.text)).toEqual([
      "The learning rate is 0.001.",
      "Momentum defaults to 0.9.",
      "Adam beats SGD in 2019.",
    ]);
  });

  it("keeps sentence punctuation inside inline code and math", () => {
    expect(splitClaimUnits(
      "Use ``client.run? `now` `` for $x.y$ and \\(a.b\\). Then continue.",
    ).map((unit) => unit.text)).toEqual([
      "Use client.run? now for $x.y$ and \\(a.b\\).",
      "Then continue.",
    ]);
  });

  it("turns unterminated list items into units and strips quote prefixes", () => {
    expect(splitClaimUnits([
      "> - First listed claim",
      "> - Second listed claim",
      "> - Third listed claim [src_1#L1-L2]",
    ].join("\n"))).toEqual([
      { text: "First listed claim", index: 0 },
      { text: "Second listed claim", index: 1 },
      { text: "Third listed claim", index: 2 },
    ]);
  });
});

describe("claim assessment", () => {
  const unit = (text: string): ClaimUnit => ({ text, index: 0 });

  it.each([
    "This distinction has two practical consequences.",
    "In other words, both knobs interact.",
    "Therefore tuning matters.",
  ])("classifies short connective prose: %s", (text) => {
    expect(classifyClaim(unit(text))).toBe("connective");
  });

  it.each([
    "Adam was shown to outperform every method in 2019.",
    "Adam beats SGD.",
    "Therefore tuning in 2019 matters.",
    "This explains Bayesian optimization.",
    "This alpha beta gamma delta epsilon zeta.",
  ])("keeps specific unsupported prose checkable: %s", (text) => {
    expect(classifyClaim(unit(text))).toBe("checkable");
  });

  it("applies lexical support before the connective exception", () => {
    const claim = unit("Therefore tuning matters.");
    const supported = assessClaim(
      claim,
      new Set(lexicalSupportTokens("Careful tuning matters in practice.")),
    );
    expect(supported).toEqual(expect.objectContaining({
      kind: "checkable",
      status: "supported",
      matched: 2,
      required: 2,
    }));
  });

  it("reports unmatched distinctive tokens for unsupported claims", () => {
    const assessment = assessClaim(
      unit("Adam was shown to outperform every method in 2019."),
      new Set<string>(),
    );
    expect(assessment).toEqual(expect.objectContaining({
      kind: "checkable",
      status: "unsupported",
      matched: 0,
      required: 3,
    }));
    expect(assessment.unmatched).toEqual(expect.arrayContaining([
      "adam",
      "outperform",
      "2019",
    ]));
  });
});
