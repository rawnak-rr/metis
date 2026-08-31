import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKernel } from "../../src/kernel.js";
import {
  fixture,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

describe("search index and evidence selection", () => {
  it("detects raw-source tampering before returning evidence", async () => {
    const { root, metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Trusted Evidence",
      content: "The original evidence remains attributable.",
    });
    const rawPath = path.join(root, ingested.source.relativePath);

    await chmod(rawPath, 0o644);
    await writeFile(rawPath, "Tampered evidence should never be retrieved.", "utf8");

    await expect(metis.sources.readSourceText(ingested.source))
      .rejects.toThrow(/integrity check failed/i);
    await expect(metis.search.search("tampered evidence"))
      .rejects.toThrow(/integrity check failed/i);
  });

  it("builds a checksum-keyed index at ingestion and reuses it incrementally", async () => {
    const { root, store, metis } = await fixture();
    const first = await metis.ingestion.ingest({
      title: "Option Delta",
      content: [
        "Delta measures how an option value changes with its underlying asset.",
        "A delta hedge offsets that first-order exposure.",
      ].join("\n"),
    });
    const cachePath = path.join(
      root,
      ".metis",
      "cache",
      "search-v1",
      `${first.source.checksum}.json`,
    );
    const persisted = JSON.parse(await readFile(cachePath, "utf8")) as {
      sourceChecksum: string;
      chunks: unknown[];
    };
    expect(persisted.sourceChecksum).toBe(first.source.checksum);
    expect(persisted.chunks.length).toBeGreaterThan(0);

    metis.search.resetRetrievalDiagnostics();
    const firstResults = await metis.search.search("How does a delta hedge offset exposure?");
    const warm = metis.search.getRetrievalDiagnostics();
    expect(firstResults[0]?.text).toContain("delta hedge");
    expect(warm).toEqual(expect.objectContaining({
      searches: 1,
      memoryIndexHits: 1,
      diskIndexHits: 0,
      sourcesIndexed: 0,
      sourceLexicalTokensIndexed: 0,
      indexedSourcesCurrent: 1,
    }));
    expect(warm.legacyEstimatedTokenVisits).toBeGreaterThan(warm.indexedTokenWork);

    const second = await metis.ingestion.ingest({
      title: "Gamma Exposure",
      content: "Gamma measures how delta changes as the underlying asset changes.",
    });
    metis.search.resetRetrievalDiagnostics();
    const secondResults = await metis.search.search("How does gamma change delta?");
    const incrementallyWarm = metis.search.getRetrievalDiagnostics();
    expect(secondResults[0]?.documentId).toBe(second.source.id);
    expect(incrementallyWarm.memoryIndexHits).toBe(2);
    expect(incrementallyWarm.sourcesIndexed).toBe(0);
    expect(incrementallyWarm.indexedSourcesCurrent).toBe(2);

    const restarted = createKernel(store);
    restarted.search.resetRetrievalDiagnostics();
    const restartedResults = await restarted.search.search("How does gamma change delta?");
    const persistedReuse = restarted.search.getRetrievalDiagnostics();
    expect(restartedResults).toEqual(secondResults);
    expect(persistedReuse.diskIndexHits).toBe(2);
    expect(persistedReuse.sourcesIndexed).toBe(0);
    expect(persistedReuse.sourceLexicalTokensIndexed).toBe(0);
  });

  it("rebuilds an incompatible derived index without changing raw evidence", async () => {
    const { root, store, metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Rebuildable Index",
      content: "Convex objectives have globally optimal local minima.",
    });
    const rawBefore = await readFile(
      path.join(root, ingested.source.relativePath),
      "utf8",
    );
    const cachePath = path.join(
      root,
      ".metis",
      "cache",
      "search-v1",
      `${ingested.source.checksum}.json`,
    );
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      derivationVersion: string;
    };
    cache.derivationVersion = "obsolete-index-format";
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");

    const restarted = createKernel(store);
    restarted.search.resetRetrievalDiagnostics();
    const results = await restarted.search.search("globally optimal convex minimum");
    const diagnostics = restarted.search.getRetrievalDiagnostics();
    expect(results[0]?.text).toContain("Convex objectives");
    expect(diagnostics.diskIndexHits).toBe(0);
    expect(diagnostics.sourcesIndexed).toBe(1);
    expect(diagnostics.sourceLexicalTokensIndexed).toBeGreaterThan(0);
    await expect(readFile(
      path.join(root, ingested.source.relativePath),
      "utf8",
    )).resolves.toBe(rawBefore);
  });

  it("deduplicates overlapping chunks before judging evidence coverage", async () => {
    const { metis, grounding } = await fixture();
    const lines = Array.from(
      { length: 40 },
      (_, index) => index === 24
        ? "A quasar flux capacitor is mentioned exactly once."
        : `Filler line ${index + 1}.`,
    );
    const ingested = await metis.ingestion.ingest({
      title: "One Overlapping Document",
      content: lines.join("\n"),
    });

    const results = await metis.search.search("quasar flux capacitor", 8);
    const matchingSourceChunks = results.filter((item) =>
      item.documentId === ingested.source.id
      && item.text.includes("quasar flux capacitor"));
    expect(matchingSourceChunks).toHaveLength(1);

    const packet = await grounding.prepareAnswer(
      "quasar flux capacitor",
      "sources_only",
      8,
    );
    expect(packet.evidence.filter((item) => item.sourceId === ingested.source.id))
      .toHaveLength(1);
    expect(packet.coverage).toBe("partial");
  });

  it("does not count a repeated support sentence twice when spans do not overlap", async () => {
    const { metis, grounding } = await fixture();
    const repeated = "A lunar eigenvector compass is calibrated exactly once.";
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 5 || index === 42
        ? repeated
        : `Unrelated filler line ${index + 1}.`);
    await metis.ingestion.ingest({
      title: "Separated Duplicate Evidence",
      content: lines.join("\n"),
    });

    const results = await metis.search.search("lunar eigenvector compass", 6);
    expect(results.filter((item) => item.text.includes(repeated))).toHaveLength(1);
    const packet = await grounding.prepareAnswer(
      "lunar eigenvector compass",
      "sources_only",
      6,
    );
    expect(packet.coverage).toBe("partial");
  });
  it("builds the concept index once per state revision", async () => {
    const { store, metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Convexity Notes",
      content: [
        "A convex objective has a single global minimum.",
        "Every local minimum of a convex objective is global.",
      ].join("\n"),
    });
    await metis.wiki.upsertWikiPage({
      title: "Convex Objective",
      summary: "An objective whose local minima are all global.",
      markdown: [
        "# Convex Objective",
        "",
        `Local minima are global. [${ingested.source.id}#L1-L2]`,
      ].join("\n"),
      sourceIds: [ingested.source.id],
      aliases: ["convexity"],
      links: [],
      tags: ["optimization"],
    });

    metis.search.resetRetrievalDiagnostics();
    const first = await metis.search.lookupConcepts("convexity", 5);
    expect(first[0]).toEqual(expect.objectContaining({
      key: "convex-objective",
      match: "alias",
    }));
    expect(metis.search.getRetrievalDiagnostics().conceptIndexBuilds).toBe(1);

    const repeated = await metis.search.lookupConcepts("convexity", 5);
    const session = await metis.search.openRetrieval();
    expect(repeated).toEqual(first);
    expect(session.lookupConcepts("convexity", 5)).toEqual(first);
    expect(metis.search.getRetrievalDiagnostics().conceptIndexBuilds).toBe(1);

    await metis.wiki.upsertWikiPage({
      title: "Global Minimum",
      summary: "The lowest value an objective attains anywhere.",
      markdown: [
        "# Global Minimum",
        "",
        `Every local minimum of a convex objective is global. [${ingested.source.id}#L1-L2]`,
      ].join("\n"),
      sourceIds: [ingested.source.id],
      aliases: [],
      links: ["convex-objective"],
      tags: [],
    });
    const afterWrite = await metis.search.lookupConcepts("global minimum", 5);
    expect(afterWrite[0]?.key).toBe("global-minimum");
    expect(metis.search.getRetrievalDiagnostics().conceptIndexBuilds).toBe(2);
    expect((await store.readState()).wikiPages).toHaveLength(2);
  });
  it("verifies each raw copy once per question, not once per search", async () => {
    const { metis, grounding } = await fixture();
    await metis.ingestion.ingest({
      title: "Convex Optimization Lecture",
      content: [
        "A convex objective curves upward everywhere on its domain.",
        "Every local minimum of a convex objective is also a global minimum.",
        "That property is what makes convex problems tractable.",
        "",
        "Gradient descent steps against the objective gradient.",
        "On a convex objective gradient descent converges to the global minimum.",
        "The learning rate controls how far each descent step moves.",
        "A learning rate that is too large makes gradient descent diverge.",
      ].join("\n"),
    });

    const reads = vi.spyOn(metis.sources, "readSourceText");
    try {
      metis.search.resetRetrievalDiagnostics();
      const packet = await grounding.prepareAnswer(
        "What is a convex objective, and why does gradient descent converge on it?",
        "sources_only",
        3,
      );
      expect(packet.facets.length).toBeGreaterThan(1);
      const diagnostics = metis.search.getRetrievalDiagnostics();
      expect(diagnostics.searches).toBeGreaterThan(1);

      const readSourceIds = reads.mock.calls.map(([source]) => source.id);
      expect(readSourceIds.length).toBeGreaterThan(0);
      expect(new Set(readSourceIds).size).toBe(readSourceIds.length);
      expect(diagnostics.verifiedSources).toBe(readSourceIds.length);
    } finally {
      reads.mockRestore();
    }
  });
});
