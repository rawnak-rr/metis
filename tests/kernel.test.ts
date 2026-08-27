import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixture,
  useTemporaryVaults,
} from "./support/vault.js";

useTemporaryVaults();

describe("kernel end to end", () => {
  it("ingests immutable evidence, compiles a wiki page, and retrieves line citations", async () => {
    const { root, store, metis, grounding } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Gradient Descent Notes",
      tags: ["optimization"],
      content: [
        "# Gradient descent",
        "",
        "Gradient descent iteratively updates parameters in the negative gradient direction.",
        "A learning rate controls the update step size.",
        "For a convex differentiable objective, suitable step sizes support convergence.",
      ].join("\n"),
    });

    expect(ingested.duplicate).toBe(false);
    expect(ingested.source.checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(path.join(root, ingested.source.relativePath), "utf8"))
      .resolves.toContain("negative gradient direction");

    const duplicate = await metis.ingestion.ingest({
      title: "Same bytes",
      content: [
        "# Gradient descent",
        "",
        "Gradient descent iteratively updates parameters in the negative gradient direction.",
        "A learning rate controls the update step size.",
        "For a convex differentiable objective, suitable step sizes support convergence.",
      ].join("\n"),
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.source.id).toBe(ingested.source.id);

    await metis.wiki.upsertWikiPage({
      title: "Gradient Descent",
      summary: "An iterative first-order optimization method.",
      markdown: [
        "# Gradient Descent",
        "",
        `Parameters move against the objective gradient. [${ingested.source.id}#L3-L5]`,
      ].join("\n"),
      sourceIds: [ingested.source.id],
      aliases: ["steepest descent"],
      links: [],
      tags: ["optimization"],
    });

    const results = await metis.search.search("What controls the gradient descent step size?", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.text.includes("learning rate"))).toBe(true);
    expect(results.every((result) => result.kind === "source")).toBe(true);
    expect(results[0]!.lineStart).toBeGreaterThan(0);
    const wikiResults = await metis.search.lookupConcepts("steepest descent", 5);
    expect(wikiResults[0]).toEqual(expect.objectContaining({
      key: "gradient-descent",
      match: "alias",
    }));

    const packet = await grounding.prepareAnswer("What controls the gradient descent step size?", "sources_only");
    expect(packet.groundingMode).toBe("sources_only");
    expect(packet.coverage).toBe("sufficient");
    expect(packet.facets).toEqual([
      expect.objectContaining({
        id: "facet_1",
        status: "supported",
      }),
    ]);
    expect(packet.evidence[0]!.citation).toMatch(/^\[.+#L\d+-L\d+\]$/);
    expect(packet.evidence.every((item) => item.sourceId === ingested.source.id)).toBe(true);
    expect(packet).not.toHaveProperty("answerContract");

    const followUp = await grounding.prepareAnswer(
      "Which parameter controls the gradient descent update step size?",
      "sources_only",
      3,
      packet.packetId,
    );
    expect(followUp.reusedEvidence).toEqual(expect.objectContaining({
      fromPacketId: packet.packetId,
    }));
    expect(followUp.reusedEvidence?.citations.length).toBeGreaterThan(0);
    expect(followUp.evidence.length).toBeLessThan(packet.evidence.length);

    const state = await store.readState();
    expect(state.sources).toHaveLength(1);
    expect(state.wikiPages).toHaveLength(1);
    expect(state.concepts[0]?.id).toBe("gradient-descent");
  });
});
