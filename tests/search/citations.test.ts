import { describe, expect, it } from "vitest";
import {
  fixture,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

describe("citation resolution", () => {
  const notes = [
    "# Gradient descent",
    "",
    "Gradient descent iteratively updates parameters in the negative gradient direction.",
    "A learning rate controls the update step size.",
    "For a convex differentiable objective, suitable step sizes support convergence.",
  ].join("\n");

  it("returns the same lines however retrieval has since changed", async () => {
    const { metis, grounding } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Gradient Descent Notes",
      content: notes,
    });
    const packet = await grounding.prepareAnswer(
      "What controls the gradient descent step size?",
      "sources_only",
    );
    const token = packet.evidence[0]!.citation;

    const first = await metis.citations.resolveCitations([token]);
    expect(first.unresolved).toEqual([]);
    expect(first.resolved).toEqual([expect.objectContaining({
      token,
      sourceId: ingested.source.id,
      sourceChecksum: ingested.source.checksum,
      title: "Gradient Descent Notes",
    })]);
    expect(first.resolved[0]!.text).toContain("step size");

    // A citation addresses a source and a line range, so growing the corpus
    // cannot move it the way re-running the query could.
    for (const index of [1, 2, 3]) {
      await metis.ingestion.ingest({
        title: `Distractor ${index}`,
        content: `A learning rate controls the update step size in variant ${index}.`,
      });
    }
    const again = await metis.citations.resolveCitations([token]);
    expect(again.resolved[0]!.text).toBe(first.resolved[0]!.text);
  });

  it("reports each unusable token without failing the batch", async () => {
    const { metis, grounding } = await fixture();
    await metis.ingestion.ingest({ title: "Gradient Descent Notes", content: notes });
    const packet = await grounding.prepareAnswer(
      "What controls the gradient descent step size?",
      "sources_only",
    );
    const good = packet.evidence[0]!.citation;
    const sourceId = packet.evidence[0]!.sourceId;

    const resolution = await metis.citations.resolveCitations([
      good,
      "not a citation",
      "[src_missing#L1-L2]",
      `[${sourceId}#L9000-L9001]`,
    ]);
    expect(resolution.resolved.map((item) => item.token)).toEqual([good]);
    expect(resolution.unresolved.map((item) => item.error.code)).toEqual([
      "CITATION_MALFORMED",
      "CITATION_SOURCE_UNKNOWN",
      "CITATION_OUT_OF_BOUNDS",
    ]);
  });

  it("refuses a batch larger than the per-call ceiling", async () => {
    const { metis } = await fixture();
    await expect(metis.citations.resolveCitations(
      Array.from({ length: 25 }, (_, index) => `[src_a#L${index + 1}-L${index + 2}]`),
    )).rejects.toThrow(/at most 24 citations/);
  });
});
