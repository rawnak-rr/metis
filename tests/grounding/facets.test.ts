import { describe, expect, it } from "vitest";
import type {
  EntailmentRequest,
  EntailmentVerdict,
} from "../../src/grounding/entailment.js";
import {
  fixture,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

describe("grounded answer facets", () => {
  it("reports support separately for each required answer facet", async () => {
    const { metis, grounding } = await fixture();
    await metis.ingestion.ingest({
      title: "Short Optimization Note",
      content: [
        "Gradient descent updates parameters iteratively.",
        "The learning rate controls the gradient descent step size.",
      ].join("\n"),
    });

    const packet = await grounding.prepareAnswer(
      "What controls the gradient descent step size, and what happens when it is too large?",
      "sources_only",
      3,
      undefined,
      [
        "What controls the gradient descent step size?",
        "What happens when the gradient descent learning rate is too large?",
        "What mechanism fixes nitrogen in legume root nodules?",
      ],
    );

    expect(packet.coverage).toBe("partial");
    expect(packet.facets).toEqual([
      expect.objectContaining({
        id: "facet_1",
        status: "supported",
        citations: expect.arrayContaining([expect.stringMatching(/^\[.+#L\d+-L\d+\]$/)]),
      }),
      expect.objectContaining({
        id: "facet_2",
        status: "partially_supported",
      }),
      expect.objectContaining({
        id: "facet_3",
        status: "unsupported",
        citations: [],
      }),
    ]);
    expect(packet.evidence).toHaveLength(1);

    const automatic = await grounding.prepareAnswer(
      "What controls the gradient descent step size, and what happens when it is too large?",
      "sources_only",
      3,
    );
    expect(automatic.facets).toHaveLength(2);
    expect(automatic.facets[0]?.status).toBe("supported");
    expect(automatic.facets[1]?.status).toBe("unsupported");
    expect(automatic.coverage).toBe("partial");
  });

  it("keeps a relevant passage the lexical check cannot confirm in the packet", async () => {
    const { metis, grounding } = await fixture();
    // The decoy repeats the question's wording and outranks the passage that
    // actually answers it, so token coverage alone would keep the answer out.
    const decoy = await metis.ingestion.ingest({
      title: "Safety Manual Index",
      content: "Thermal runaway mechanisms in the loop are documented in the safety manual.",
    });
    const answer = await metis.ingestion.ingest({
      title: "Passive Cooling Note",
      content: "Passive convection removes decay heat and keeps the reactor coolant subcooled.",
    });

    const packet = await grounding.prepareAnswer(
      "Which mechanism prevents thermal runaway in the reactor coolant loop?",
      "sources_only",
      3,
    );

    expect(packet.evidence).toHaveLength(2);
    expect(packet.evidence[0]).toEqual(expect.objectContaining({
      sourceId: decoy.source.id,
    }));
    expect(packet.evidence[0]).not.toHaveProperty("lexicalSupport");
    expect(packet.evidence[1]).toEqual(expect.objectContaining({
      sourceId: answer.source.id,
      lexicalSupport: "related",
    }));
    expect(packet.facets[0]).toEqual(expect.objectContaining({
      status: "partially_supported",
      citations: [`[${decoy.source.id}#L1-L1]`],
      borderlineCitations: [`[${answer.source.id}#L1-L1]`],
    }));
  });

  it("lets an entailment verdict decide a facet token coverage misreads", async () => {
    const { metis, grounding } = await fixture();
    const decoy = await metis.ingestion.ingest({
      title: "Safety Manual Index",
      content: "Thermal runaway mechanisms in the loop are documented in the safety manual.",
    });
    const answer = await metis.ingestion.ingest({
      title: "Passive Cooling Note",
      content: "Passive convection removes decay heat and keeps the reactor coolant subcooled.",
    });
    const question = "Which mechanism prevents thermal runaway in the reactor coolant loop?";
    const seen: EntailmentRequest[] = [];
    grounding.useEntailmentJudge({
      async judge(requests) {
        seen.push(...requests);
        return requests.map((request) => ({
          facetId: request.facetId,
          verdicts: request.passages.map((passage) => ({
            citation: passage.citation,
            verdict: (passage.citation.includes(answer.source.id)
              ? "supported"
              : "insufficient") as EntailmentVerdict,
          })),
        }));
      },
    });

    const packet = await grounding.prepareAnswer(question, "sources_only", 3);

    // Only packet passages are judged, highest retrieval score first.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.question).toBe(question);
    expect(seen[0]!.passages.map((passage) => passage.citation)).toEqual([
      `[${decoy.source.id}#L1-L1]`,
      `[${answer.source.id}#L1-L1]`,
    ]);
    expect(packet.facets).toEqual([{
      id: "facet_1",
      question,
      status: "supported",
      citations: [`[${answer.source.id}#L1-L1]`],
      statusMethod: "entailment",
      borderlineCitations: [`[${decoy.source.id}#L1-L1]`],
    }]);
    expect(packet.coverage).toBe("sufficient");
  });

  it("keeps the lexical status when the entailment judge fails", async () => {
    const { metis, grounding } = await fixture();
    const decoy = await metis.ingestion.ingest({
      title: "Safety Manual Index",
      content: "Thermal runaway mechanisms in the loop are documented in the safety manual.",
    });
    await metis.ingestion.ingest({
      title: "Passive Cooling Note",
      content: "Passive convection removes decay heat and keeps the reactor coolant subcooled.",
    });
    grounding.useEntailmentJudge({
      judge: () => Promise.reject(new Error("sampling refused")),
    });

    const packet = await grounding.prepareAnswer(
      "Which mechanism prevents thermal runaway in the reactor coolant loop?",
      "sources_only",
      3,
    );

    expect(packet.facets[0]).toEqual(expect.objectContaining({
      status: "partially_supported",
      citations: [`[${decoy.source.id}#L1-L1]`],
    }));
    expect(packet.facets[0]).not.toHaveProperty("statusMethod");
    expect(packet.evidence).toHaveLength(2);
  });

  it("marks incompatible numeric evidence as a conflicting facet", async () => {
    const { metis, grounding } = await fixture();
    await metis.ingestion.ingest({
      title: "Protocol Zephyr A",
      content: "Protocol Zephyr requires a 15-minute observation interval.",
    });
    await metis.ingestion.ingest({
      title: "Protocol Zephyr B",
      content: "Protocol Zephyr requires a 30-minute observation interval.",
    });

    const packet = await grounding.prepareAnswer(
      "What observation interval does Protocol Zephyr require?",
      "sources_only",
      3,
    );

    expect(packet.coverage).toBe("partial");
    expect(packet.facets[0]).toEqual(expect.objectContaining({
      status: "conflicting",
      citations: expect.arrayContaining([
        expect.stringMatching(/^\[.+#L\d+-L\d+\]$/),
      ]),
    }));
    expect(packet.facets[0]!.citations).toHaveLength(2);
    expect(packet.warnings).toContain("possible_numeric_conflict");
  });
});
