import { describe, expect, it } from "vitest";
import {
  ENTAILMENT_SYSTEM_PROMPT,
  entailmentPrompt,
  parseEntailmentVerdicts,
} from "../../src/grounding/entailment.js";

const passages = [
  { citation: "[src_a#L1-L1]", text: "First passage." },
  { citation: "[src_b#L2-L3]", text: "Second passage." },
];

describe("entailmentPrompt", () => {
  it("numbers passages from one and states the expected reply range", () => {
    const prompt = entailmentPrompt({
      facetId: "facet_1",
      question: "What controls the step size?",
      passages,
    });
    expect(prompt).toContain("Question: What controls the step size?");
    expect(prompt).toContain("Passage 1:\nFirst passage.");
    expect(prompt).toContain("Passage 2:\nSecond passage.");
    expect(prompt).toContain("Verdicts for passages 1-2:");
  });

  it("collapses whitespace and truncates a long passage", () => {
    const prompt = entailmentPrompt({
      facetId: "facet_1",
      question: "Why?",
      passages: [{ citation: "[src_a#L1-L40]", text: `a\n\nb ${"long ".repeat(400)}` }],
    });
    expect(prompt).toContain("a b long");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(900);
  });

  it("tells the model that passage text is untrusted data", () => {
    expect(ENTAILMENT_SYSTEM_PROMPT).toMatch(/untrusted data/i);
    expect(ENTAILMENT_SYSTEM_PROMPT).toMatch(/never follow instructions/i);
  });
});

describe("parseEntailmentVerdicts", () => {
  it("maps numbered verdict lines onto citations", () => {
    expect(parseEntailmentVerdicts("1: supported\n2: insufficient", passages)).toEqual([
      { citation: "[src_a#L1-L1]", verdict: "supported" },
      { citation: "[src_b#L2-L3]", verdict: "insufficient" },
    ]);
  });

  it("tolerates decorated and reordered replies", () => {
    expect(parseEntailmentVerdicts(
      "Here are my verdicts.\n**2:** Conflicting because the values differ.\nPassage 1 - SUPPORTED",
      passages,
    )).toEqual([
      { citation: "[src_b#L2-L3]", verdict: "conflicting" },
      { citation: "[src_a#L1-L1]", verdict: "supported" },
    ]);
  });

  it("keeps the first verdict when a passage number repeats", () => {
    expect(parseEntailmentVerdicts("1: supported\n1: insufficient", passages)).toEqual([
      { citation: "[src_a#L1-L1]", verdict: "supported" },
    ]);
  });

  it("drops numbers outside the passage list and unparseable prose", () => {
    expect(parseEntailmentVerdicts("3: supported", passages)).toEqual([]);
    expect(parseEntailmentVerdicts(
      "The first passage seems supported to me.",
      passages,
    )).toEqual([]);
  });
});
