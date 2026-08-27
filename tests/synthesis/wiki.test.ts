import { describe, expect, it } from "vitest";
import {
  fixture,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

describe("wiki validation and lint", () => {
  it("reports broken links and orphan structure without corrupting pages", async () => {
    const { metis } = await fixture();
    const source = await metis.ingestion.ingest({
      title: "Evidence",
      content: "Grounded text is useful factual evidence.",
    });
    await metis.wiki.upsertWikiPage({
      title: "A",
      summary: "A page",
      markdown: `# A\n\nGrounded text is useful. [${source.source.id}#L1-L1]`,
      sourceIds: [source.source.id],
      links: ["Missing Page"],
    });
    const lint = await metis.wiki.lintWiki();
    expect(lint.healthy).toBe(true);
    expect(lint.issues).toContainEqual(expect.objectContaining({
      code: "broken_link",
      page: "a",
    }));
  });

  it("validates wiki citation spans, inline coverage, and lexical support", async () => {
    const { metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Cell Biology",
      content: "Mitochondria produce ATP through cellular respiration.",
    });
    const sourceId = ingested.source.id;

    await expect(metis.wiki.upsertWikiPage({
      title: "Missing Citation",
      summary: "A deliberately invalid page.",
      markdown: "# Missing Citation\n\nMitochondria produce ATP.",
      sourceIds: [sourceId],
    })).rejects.toThrow(/inline source citation/i);

    await expect(metis.wiki.upsertWikiPage({
      title: "Invalid Span",
      summary: "A deliberately invalid page.",
      markdown: `# Invalid Span\n\nMitochondria produce ATP. [${sourceId}#L2-L4]`,
      sourceIds: [sourceId],
    })).rejects.toThrow(/outside source/i);

    await expect(metis.wiki.upsertWikiPage({
      title: "Unsupported Claim",
      summary: "A deliberately invalid page.",
      markdown: `# Unsupported Claim\n\nMitochondria orbit Jupiter and glow bright green. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    })).rejects.toThrow(/does not lexically support/i);

    await expect(metis.wiki.upsertWikiPage({
      title: "Mitochondria",
      summary: "Cellular energy production.",
      markdown: `# Mitochondria\n\nMitochondria produce ATP during cellular respiration. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    })).resolves.toEqual(expect.objectContaining({ slug: "mitochondria" }));

    // The gate compares stems, so a claim may inflect its terms differently
    // from the excerpt it cites.
    await expect(metis.wiki.upsertWikiPage({
      title: "Respiration",
      summary: "Inflected restatement of the same cited evidence.",
      markdown: `# Respiration\n\nA mitochondrion produces ATP by respiring cellularly. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    })).resolves.toEqual(expect.objectContaining({ slug: "respiration" }));
  });

  it("reports sentence-level fabrication without rejecting the pooled block", async () => {
    const { metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Adam Notes",
      content: "Adam optimizer computes adaptive learning rates for each parameter from first and second moment estimates.",
    });
    const sourceId = ingested.source.id;

    await expect(metis.wiki.upsertWikiPage({
      title: "Adam",
      summary: "Adaptive optimizer notes.",
      markdown: [
        "# Adam",
        "",
        `Adam optimizer computes adaptive learning rates for each parameter. It was shown to outperform every method in 2019. [${sourceId}#L1-L1]`,
      ].join("\n"),
      sourceIds: [sourceId],
    })).resolves.toEqual(expect.objectContaining({ slug: "adam" }));

    const lint = await metis.wiki.lintWiki({ log: false });
    expect(lint.healthy).toBe(true);
    expect(lint.issues).toContainEqual(expect.objectContaining({
      severity: "info",
      code: "unsupported_claim",
      page: "adam",
      message: expect.stringMatching(/0\/3.*2019.*outperform every method/i),
    }));
  });

  it("does not report supported or connective sentences", async () => {
    const { metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Adam Notes",
      content: "Adam optimizer computes adaptive learning rates for each parameter from first and second moment estimates.",
    });
    const sourceId = ingested.source.id;
    const connectives = [
      "This distinction has two practical consequences.",
      "In other words, both knobs interact.",
      "Therefore tuning matters.",
    ];
    for (const [index, connective] of connectives.entries()) {
      await metis.wiki.upsertWikiPage({
        title: `Adam Glue ${index + 1}`,
        summary: "Adaptive optimizer notes with connective prose.",
        markdown: [
          `# Adam Glue ${index + 1}`,
          "",
          `Adam optimizer computes adaptive learning rates for each parameter. ${connective} [${sourceId}#L1-L1]`,
        ].join("\n"),
        sourceIds: [sourceId],
      });
    }

    const lint = await metis.wiki.lintWiki({ log: false });
    expect(lint.issues.filter((issue) => issue.code === "unsupported_claim"))
      .toEqual([]);
  });

});
