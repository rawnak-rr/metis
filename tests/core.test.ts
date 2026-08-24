import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeService } from "../src/knowledge.js";
import { GroundingService } from "../src/grounding.js";
import { RepairService } from "../src/repair.js";
import { syncMetisSkills } from "../src/skills.js";
import { StudyStore } from "../src/store.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-test-"));
  temporaryDirectories.push(root);
  const store = new StudyStore(root);
  await store.initialize("Test Vault");
  const knowledge = new KnowledgeService(store);
  const grounding = new GroundingService(store, knowledge);
  return { root, store, knowledge, grounding };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("knowledge and grounding", () => {
  it("ingests immutable evidence, compiles a wiki page, and retrieves line citations", async () => {
    const { root, store, knowledge, grounding } = await fixture();
    const ingested = await knowledge.ingest({
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

    const duplicate = await knowledge.ingest({
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

    await knowledge.upsertWikiPage({
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

    const results = await knowledge.search("What controls the gradient descent step size?", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.text.includes("learning rate"))).toBe(true);
    expect(results.every((result) => result.kind === "source")).toBe(true);
    expect(results[0]!.lineStart).toBeGreaterThan(0);
    const wikiResults = await knowledge.lookupConcepts("steepest descent", 5);
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

  it("reports support separately for each required answer facet", async () => {
    const { knowledge, grounding } = await fixture();
    await knowledge.ingest({
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

  it("marks incompatible numeric evidence as a conflicting facet", async () => {
    const { knowledge, grounding } = await fixture();
    await knowledge.ingest({
      title: "Protocol Zephyr A",
      content: "Protocol Zephyr requires a 15-minute observation interval.",
    });
    await knowledge.ingest({
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

  it("reports broken links and orphan structure without corrupting pages", async () => {
    const { knowledge } = await fixture();
    const source = await knowledge.ingest({
      title: "Evidence",
      content: "Grounded text is useful factual evidence.",
    });
    await knowledge.upsertWikiPage({
      title: "A",
      summary: "A page",
      markdown: `# A\n\nGrounded text is useful. [${source.source.id}#L1-L1]`,
      sourceIds: [source.source.id],
      links: ["Missing Page"],
    });
    const lint = await knowledge.lintWiki();
    expect(lint.healthy).toBe(true);
    expect(lint.issues).toContainEqual(expect.objectContaining({
      code: "broken_link",
      page: "a",
    }));
  });

  it("detects raw-source tampering before returning evidence", async () => {
    const { root, knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Trusted Evidence",
      content: "The original evidence remains attributable.",
    });
    const rawPath = path.join(root, ingested.source.relativePath);

    await chmod(rawPath, 0o644);
    await writeFile(rawPath, "Tampered evidence should never be retrieved.", "utf8");

    await expect(knowledge.readSourceText(ingested.source))
      .rejects.toThrow(/integrity check failed/i);
    await expect(knowledge.search("tampered evidence"))
      .rejects.toThrow(/integrity check failed/i);
  });

  it("builds a checksum-keyed index at ingestion and reuses it incrementally", async () => {
    const { root, store, knowledge } = await fixture();
    const first = await knowledge.ingest({
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

    knowledge.resetRetrievalDiagnostics();
    const firstResults = await knowledge.search("How does a delta hedge offset exposure?");
    const warm = knowledge.getRetrievalDiagnostics();
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

    const second = await knowledge.ingest({
      title: "Gamma Exposure",
      content: "Gamma measures how delta changes as the underlying asset changes.",
    });
    knowledge.resetRetrievalDiagnostics();
    const secondResults = await knowledge.search("How does gamma change delta?");
    const incrementallyWarm = knowledge.getRetrievalDiagnostics();
    expect(secondResults[0]?.documentId).toBe(second.source.id);
    expect(incrementallyWarm.memoryIndexHits).toBe(2);
    expect(incrementallyWarm.sourcesIndexed).toBe(0);
    expect(incrementallyWarm.indexedSourcesCurrent).toBe(2);

    const restarted = new KnowledgeService(store);
    restarted.resetRetrievalDiagnostics();
    const restartedResults = await restarted.search("How does gamma change delta?");
    const persistedReuse = restarted.getRetrievalDiagnostics();
    expect(restartedResults).toEqual(secondResults);
    expect(persistedReuse.diskIndexHits).toBe(2);
    expect(persistedReuse.sourcesIndexed).toBe(0);
    expect(persistedReuse.sourceLexicalTokensIndexed).toBe(0);
  });

  it("rebuilds an incompatible derived index without changing raw evidence", async () => {
    const { root, store, knowledge } = await fixture();
    const ingested = await knowledge.ingest({
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

    const restarted = new KnowledgeService(store);
    restarted.resetRetrievalDiagnostics();
    const results = await restarted.search("globally optimal convex minimum");
    const diagnostics = restarted.getRetrievalDiagnostics();
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
    const { knowledge, grounding } = await fixture();
    const lines = Array.from(
      { length: 40 },
      (_, index) => index === 24
        ? "A quasar flux capacitor is mentioned exactly once."
        : `Filler line ${index + 1}.`,
    );
    const ingested = await knowledge.ingest({
      title: "One Overlapping Document",
      content: lines.join("\n"),
    });

    const results = await knowledge.search("quasar flux capacitor", 8);
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
    const { knowledge, grounding } = await fixture();
    const repeated = "A lunar eigenvector compass is calibrated exactly once.";
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 5 || index === 42
        ? repeated
        : `Unrelated filler line ${index + 1}.`);
    await knowledge.ingest({
      title: "Separated Duplicate Evidence",
      content: lines.join("\n"),
    });

    const results = await knowledge.search("lunar eigenvector compass", 6);
    expect(results.filter((item) => item.text.includes(repeated))).toHaveLength(1);
    const packet = await grounding.prepareAnswer(
      "lunar eigenvector compass",
      "sources_only",
      6,
    );
    expect(packet.coverage).toBe("partial");
  });

  it("validates wiki citation spans, inline coverage, and lexical support", async () => {
    const { knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Cell Biology",
      content: "Mitochondria produce ATP through cellular respiration.",
    });
    const sourceId = ingested.source.id;

    await expect(knowledge.upsertWikiPage({
      title: "Missing Citation",
      summary: "A deliberately invalid page.",
      markdown: "# Missing Citation\n\nMitochondria produce ATP.",
      sourceIds: [sourceId],
    })).rejects.toThrow(/inline source citation/i);

    await expect(knowledge.upsertWikiPage({
      title: "Invalid Span",
      summary: "A deliberately invalid page.",
      markdown: `# Invalid Span\n\nMitochondria produce ATP. [${sourceId}#L2-L4]`,
      sourceIds: [sourceId],
    })).rejects.toThrow(/outside source/i);

    await expect(knowledge.upsertWikiPage({
      title: "Unsupported Claim",
      summary: "A deliberately invalid page.",
      markdown: `# Unsupported Claim\n\nMitochondria orbit Jupiter and glow bright green. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    })).rejects.toThrow(/does not lexically support/i);

    await expect(knowledge.upsertWikiPage({
      title: "Mitochondria",
      summary: "Cellular energy production.",
      markdown: `# Mitochondria\n\nMitochondria produce ATP during cellular respiration. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    })).resolves.toEqual(expect.objectContaining({ slug: "mitochondria" }));

    // The gate compares stems, so a claim may inflect its terms differently
    // from the excerpt it cites.
    await expect(knowledge.upsertWikiPage({
      title: "Respiration",
      summary: "Inflected restatement of the same cited evidence.",
      markdown: `# Respiration\n\nA mitochondrion produces ATP by respiring cellularly. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    })).resolves.toEqual(expect.objectContaining({ slug: "respiration" }));
  });

  it("reports sentence-level fabrication without rejecting the pooled block", async () => {
    const { knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Adam Notes",
      content: "Adam optimizer computes adaptive learning rates for each parameter from first and second moment estimates.",
    });
    const sourceId = ingested.source.id;

    await expect(knowledge.upsertWikiPage({
      title: "Adam",
      summary: "Adaptive optimizer notes.",
      markdown: [
        "# Adam",
        "",
        `Adam optimizer computes adaptive learning rates for each parameter. It was shown to outperform every method in 2019. [${sourceId}#L1-L1]`,
      ].join("\n"),
      sourceIds: [sourceId],
    })).resolves.toEqual(expect.objectContaining({ slug: "adam" }));

    const lint = await knowledge.lintWiki({ log: false });
    expect(lint.healthy).toBe(true);
    expect(lint.issues).toContainEqual(expect.objectContaining({
      severity: "info",
      code: "unsupported_claim",
      page: "adam",
      message: expect.stringMatching(/0\/3.*2019.*outperform every method/i),
    }));
  });

  it("does not report supported or connective sentences", async () => {
    const { knowledge } = await fixture();
    const ingested = await knowledge.ingest({
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
      await knowledge.upsertWikiPage({
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

    const lint = await knowledge.lintWiki({ log: false });
    expect(lint.issues.filter((issue) => issue.code === "unsupported_claim"))
      .toEqual([]);
  });

  it("preserves synthesis that fails only lexical validation during repair", async () => {
    const { store, knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Cell Biology",
      content: "Mitochondria produce ATP through cellular respiration.",
    });
    const sourceId = ingested.source.id;
    const page = await knowledge.upsertWikiPage({
      title: "Mitochondria",
      summary: "Cellular energy production.",
      markdown: `# Mitochondria\n\nMitochondria produce ATP. [${sourceId}#L1-L1]`,
      sourceIds: [sourceId],
    });
    const drifted = `# Mitochondria\n\nMitochondria orbit Jupiter and glow bright green. [${sourceId}#L1-L1]`;
    await store.writeWikiPage(page, drifted);

    const result = await knowledge.repairKnowledge();
    expect(result.wiki.evidenceStubsRebuilt).toBe(0);
    await expect(store.readText("wiki/concepts/mitochondria.md"))
      .resolves.toContain("orbit Jupiter and glow bright green");
  });

  it("recovery output with quoted markdown passes structural validation", async () => {
    const { store, knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Quoted Source",
      content: [
        "# Quoted source heading",
        "",
        "A recovered statement remains attributable.",
        "- A source list item without a terminal period",
      ].join("\n"),
    });
    const sourceId = ingested.source.id;
    const page = await knowledge.upsertWikiPage({
      title: "Quoted Source Heading",
      summary: "A recovered statement from the quoted source heading.",
      markdown: `# Quoted Source Heading\n\nA recovered statement remains attributable. [${sourceId}#L3-L4]`,
      sourceIds: [sourceId],
    });
    await store.writeWikiPage(page, "# Quoted Source Heading\n\nCitation removed mechanically.\n");

    const first = await knowledge.repairKnowledge();
    expect(first.wiki.evidenceStubsRebuilt).toBe(1);
    await expect(store.readText("wiki/concepts/quoted-source-heading.md"))
      .resolves.toMatch(/> # Quoted source heading[\s\S]*\[src_.+#L1-L4]/);
    const lint = await knowledge.lintWiki({ log: false });
    expect(lint.issues.filter((issue) =>
      issue.code === "invalid_citation" || issue.code === "unsupported_claim"))
      .toEqual([]);
    const second = await knowledge.repairKnowledge();
    expect(second.wiki.evidenceStubsRebuilt).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "rejects vault-relative symlinks that resolve outside the vault",
    async () => {
      const { root, knowledge } = await fixture();
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), "metis-external-"));
      temporaryDirectories.push(externalRoot);
      const externalPath = path.join(externalRoot, "outside.txt");
      await writeFile(externalPath, "This file is outside the study vault.", "utf8");
      await symlink(externalPath, path.join(root, "linked-source.txt"));

      await expect(knowledge.ingest({
        title: "Escaped Source",
        sourcePath: "linked-source.txt",
      })).rejects.toThrow(/outside the configured study vault/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects managed vault directories that are symlinked outside the vault",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "metis-managed-symlink-"));
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), "metis-managed-external-"));
      temporaryDirectories.push(root, externalRoot);
      await symlink(externalRoot, path.join(root, "wiki"), "dir");

      const store = new StudyStore(root);
      await expect(store.initialize()).rejects.toThrow(/outside the configured study vault/i);
      await expect(readdir(externalRoot)).resolves.toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to refresh generated skills through an escaping symlink",
    async () => {
      const { root, store } = await fixture();
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), "metis-skill-external-"));
      temporaryDirectories.push(externalRoot);
      await symlink(
        externalRoot,
        path.join(root, ".metis", "skills"),
        "dir",
      );

      const repair = new RepairService(store, new KnowledgeService(store));
      await expect(repair.repair()).rejects.toThrow(
        /repair failed.*outside the configured study vault/is,
      );
      await expect(readdir(externalRoot)).resolves.toEqual([]);
    },
  );
});

describe("vault persistence and updates", () => {
  it("serializes concurrent mutations across multiple store instances", async () => {
    const { root, store } = await fixture();
    const secondStore = new StudyStore(root);
    await secondStore.initialize();

    await Promise.all(Array.from({ length: 25 }, (_, index) => {
      const target = index % 2 === 0 ? store : secondStore;
      return target.mutate((state) => {
        state.concepts.push({
          id: `concept_concurrent_${index}`,
          title: `Concurrent concept ${index}`,
          notes: [],
          sourceIds: [],
        });
      });
    }));

    const state = await store.readState();
    expect(state.concepts).toHaveLength(25);
    expect(new Set(state.concepts.map((concept) => concept.id)).size).toBe(25);
  });

  it("preserves every concurrent operation-log entry", async () => {
    const { root, store } = await fixture();
    const secondStore = new StudyStore(root);
    await secondStore.initialize();

    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const target = index % 2 === 0 ? store : secondStore;
      return target.appendLog("concurrency-test", `Entry ${index}`);
    }));

    const log = await readFile(path.join(root, "wiki", "log.md"), "utf8");
    for (let index = 0; index < 20; index += 1) {
      expect(log).toContain(`concurrency-test | Entry ${index}`);
    }
    expect(log.match(/concurrency-test \| Entry/g)).toHaveLength(20);
  });

  it("recovers a stale vault lock without discarding the pending mutation", async () => {
    const { root, store } = await fixture();
    const lockPath = path.join(root, ".metis", "write.lock");
    await writeFile(lockPath, "{\"token\":\"stale\",\"pid\":-1}\n", "utf8");
    const staleTime = new Date(Date.now() - 5 * 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await store.mutate((state) => {
      state.concepts.push({
        id: "concept_after_stale_lock",
        title: "Recovered mutation",
        notes: [],
        sourceIds: [],
      });
    });

    expect((await store.readState()).concepts.map((concept) => concept.id))
      .toContain("concept_after_stale_lock");
  });

  it("migrates an unversioned vault through a dry-run and backed-up update", async () => {
    const { root, store } = await fixture();
    const currentState = await store.readState();
    const currentConfig = await store.getConfig();
    const { schemaVersion: _stateVersion, ...legacyState } = currentState;
    const { schemaVersion: _configVersion, ...legacyConfig } = currentConfig;
    await writeFile(
      path.join(root, ".metis", "state.json"),
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, ".metis", "config.json"),
      `${JSON.stringify(legacyConfig, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(root, "wiki", "SCHEMA.md"), "# Legacy schema\n", "utf8");
    const rawSentinel = path.join(root, "raw", "migration-sentinel.txt");
    await writeFile(rawSentinel, "raw evidence is never migrated", "utf8");

    const reopened = new StudyStore(root);
    await reopened.initialize();
    const inspection = await reopened.inspectVault();
    expect(inspection).toEqual(expect.objectContaining({
      stateVersion: 0,
      configVersion: 0,
      updateRequired: true,
      generatedSchemaCurrent: false,
    }));
    await expect(reopened.readState()).rejects.toThrow(/metis.repair|metis_repair/i);

    const dryRun = await reopened.updateVault({ dryRun: true });
    expect(dryRun.updated).toBe(false);
    expect(dryRun.actions).toEqual(expect.arrayContaining([
      "Migrated state schema v0 → v1.",
      "Migrated state schema v1 → v2.",
      "Migrated state schema v2 → v3.",
      "Migrated state schema v3 → v4.",
      "Migrated config schema v0 → v1.",
    ]));
    expect(JSON.parse(await readFile(path.join(root, ".metis", "state.json"), "utf8")))
      .not.toHaveProperty("schemaVersion");

    const updated = await reopened.updateVault();
    expect(updated.updated).toBe(true);
    expect(updated.stateVersion).toBe(5);
    expect(updated.configVersion).toBe(1);
    expect(updated.backupRelativePath).toMatch(/^\.metis\/backups\//);
    expect(await reopened.readState()).toEqual(expect.objectContaining({ schemaVersion: 5 }));
    expect(await reopened.getConfig()).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    await expect(readFile(rawSentinel, "utf8")).resolves.toBe("raw evidence is never migrated");

    const backupRoot = path.join(root, updated.backupRelativePath!);
    expect(JSON.parse(await readFile(path.join(backupRoot, "state.json"), "utf8")))
      .not.toHaveProperty("schemaVersion");
    await expect(readFile(path.join(backupRoot, "manifest.json"), "utf8"))
      .resolves.toContain('"excludes"');
    expect((await reopened.inspectVault()).updateRequired).toBe(false);
  });

  it("refuses to downgrade a vault created by a newer Metis schema", async () => {
    const { root, store } = await fixture();
    const state = await store.readState();
    await writeFile(
      path.join(root, ".metis", "state.json"),
      `${JSON.stringify({ ...state, schemaVersion: 99 }, null, 2)}\n`,
      "utf8",
    );

    const reopened = new StudyStore(root);
    await reopened.initialize();
    await expect(reopened.updateVault()).rejects.toThrow(/refusing to downgrade/i);
  });

  it("migrates a v1 vault forward and drops learner state at v4", async () => {
    const { root, knowledge } = await fixture();
    const source = await knowledge.ingest({
      title: "Fractions",
      content: "A common denominator is required before adding fractions.",
    });
    await knowledge.upsertWikiPage({
      title: "Fractions",
      summary: "Adding fractional quantities.",
      markdown: `# Fractions\n\nA common denominator is required before adding fractions. [${source.source.id}#L1-L1]`,
      sourceIds: [source.source.id],
    });
    const statePath = path.join(root, ".metis", "state.json");
    const legacyState = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: number;
      concepts: Array<Record<string, unknown>>;
      wikiPages: Array<Record<string, unknown>>;
    };
    legacyState.schemaVersion = 1;
    legacyState.concepts[0]!.notes = ["Adds denominators directly."];
    delete legacyState.concepts[0]!.misconceptions;
    delete legacyState.wikiPages[0]!.aliases;
    await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

    const reopened = new StudyStore(root);
    await reopened.initialize();
    const preview = await reopened.updateVault({ dryRun: true });
    expect(preview.actions).toContain("Migrated state schema v1 → v2.");
    expect(preview.actions).toContain("Migrated state schema v2 → v3.");
    expect(preview.actions).toContain("Migrated state schema v3 → v4.");
    await reopened.updateVault();

    const migrated = await reopened.readState();
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.wikiPages[0]!.aliases).toEqual([]);
    await expect(readFile(
      path.join(root, "wiki", "concepts", "fractions.md"),
      "utf8",
    )).resolves.toMatch(/aliases: \[\][\s\S]*A common denominator is required/);
    expect(migrated.concepts[0]).toEqual({
      id: "fractions",
      title: "Fractions",
      notes: ["Adds denominators directly."],
      sourceIds: [source.source.id],
    });
    expect(migrated.concepts[0]).not.toHaveProperty("misconceptions");
    expect(migrated).not.toHaveProperty("cards");
  });

  it("restores a managed-file backup without touching raw evidence", async () => {
    const { root, store } = await fixture();
    const rawPath = path.join(root, "raw", "restore-sentinel.txt");
    await writeFile(rawPath, "immutable across restore", "utf8");
    await store.mutate((state) => {
      state.concepts.push({
        id: "concept_before_backup",
        title: "Keep this concept",
        notes: [],
        sourceIds: [],
      });
    });
    const update = await store.updateVault();
    const backup = update.backupRelativePath!;
    await store.mutate((state) => {
      state.concepts.push({
        id: "concept_after_backup",
        title: "Remove this by restoring",
        notes: [],
        sourceIds: [],
      });
    });

    const preview = await store.restoreVaultBackup(backup, { dryRun: true });
    expect(preview).toEqual(expect.objectContaining({
      dryRun: true,
      restored: false,
      restoredFrom: backup,
      stateVersion: 5,
    }));
    expect((await store.readState()).concepts).toHaveLength(2);

    const restored = await store.restoreVaultBackup(backup);
    expect(restored.restored).toBe(true);
    expect(restored.recoveryBackupRelativePath).toMatch(/^\.metis\/backups\//);
    expect((await store.readState()).concepts.map((concept) => concept.id))
      .toEqual(["concept_before_backup"]);
    await expect(readFile(rawPath, "utf8")).resolves.toBe("immutable across restore");
    expect(await store.listVaultBackups()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: backup,
        integrity: "valid",
      }),
      expect.objectContaining({
        relativePath: restored.recoveryBackupRelativePath,
        integrity: "valid",
      }),
    ]));

    const recoveryStatePath = path.join(
      root,
      restored.recoveryBackupRelativePath!,
      "state.json",
    );
    const recoveryState = await readFile(recoveryStatePath, "utf8");
    await writeFile(recoveryStatePath, `${recoveryState}\n`, "utf8");
    await expect(store.restoreVaultBackup(
      restored.recoveryBackupRelativePath!,
      { dryRun: true },
    )).rejects.toThrow(/integrity check failed/i);
    expect(await store.listVaultBackups()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: restored.recoveryBackupRelativePath,
        integrity: "invalid",
      }),
    ]));
  });

  it("migrates and repairs a damaged vault, refreshes skills, and reuses repaired knowledge", async () => {
    const { root, store, knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Cellular Respiration",
      content: "Mitochondria produce ATP through cellular respiration.",
      tags: ["biology"],
    });
    await knowledge.upsertWikiPage({
      title: "Mitochondria",
      summary: "Cellular ATP production.",
      markdown: `# Mitochondria\n\nMitochondria produce ATP through cellular respiration. [${ingested.source.id}#L1-L1]`,
      sourceIds: [ingested.source.id],
      links: ["missing-concept"],
    });

    const rawPath = path.join(root, ingested.source.relativePath);
    const rawBefore = await readFile(rawPath);
    await chmod(rawPath, 0o644);
    const currentState = await store.readState();
    const currentConfig = await store.getConfig();
    const { schemaVersion: _stateVersion, ...legacyState } = currentState;
    const { schemaVersion: _configVersion, ...legacyConfig } = currentConfig;
    legacyState.concepts = [];
    await writeFile(
      path.join(root, ".metis", "state.json"),
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, ".metis", "config.json"),
      `${JSON.stringify(legacyConfig, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "wiki", "concepts", "mitochondria.md"),
      "# Mitochondria\n\nUnsupported legacy synthesis.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "wiki", "sources", `${ingested.source.id}.md`),
      "# Stale source descriptor\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".metis", "cache", "search-v1", `${ingested.source.checksum}.json`),
      "{\"invalid\":true}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".metis", "cache", "search-v1", "stale.json"),
      "{}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "wiki", "concepts", "untracked.md"),
      "# Untracked generated concept\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "wiki", "sources", "untracked.md"),
      "# Untracked generated source\n",
      "utf8",
    );

    const reopened = new StudyStore(root);
    await reopened.initialize();
    const repairedKnowledge = new KnowledgeService(reopened);
    const repair = new RepairService(reopened, repairedKnowledge);
    const preview = await repair.repair({ dryRun: true });
    expect(preview).toEqual(expect.objectContaining({
      dryRun: true,
      repaired: false,
      knowledgeInspectionDeferred: expect.stringContaining("schema migrations"),
      skills: expect.objectContaining({ updated: false }),
    }));
    await expect(readFile(
      path.join(root, ".metis", "skills", "manifest.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });

    const result = await repair.repair();
    expect(result).toEqual(expect.objectContaining({
      dryRun: false,
      repaired: true,
      backupRelativePath: expect.stringMatching(/^\.metis\/backups\//),
      wikiHealth: expect.objectContaining({ healthy: true }),
      skills: expect.objectContaining({ version: 1, updated: true }),
      knowledge: expect.objectContaining({
        sources: expect.objectContaining({
          verified: 1,
          permissionsRepaired: 1,
          descriptorsRefreshed: 1,
        }),
        wiki: expect.objectContaining({
          evidenceStubsRebuilt: 1,
          brokenLinksRemoved: 1,
          conceptsCreated: 1,
          untrackedManagedFilesRemoved: 2,
        }),
        searchIndex: expect.objectContaining({
          rebuilt: 1,
          staleEntriesRemoved: 1,
        }),
      }),
    }));
    const repairedState = await reopened.readState();
    expect(repairedState.schemaVersion).toBe(5);
    expect(repairedState.wikiPages[0]?.summary).toMatch(
      /^Recovered evidence: Mitochondria produce ATP/,
    );
    await expect(readFile(rawPath)).resolves.toEqual(rawBefore);
    expect((await stat(rawPath)).mode & 0o222).toBe(0);
    await expect(readFile(
      path.join(root, "wiki", "concepts", "mitochondria.md"),
      "utf8",
    )).resolves.toMatch(/Recovered verbatim evidence[\s\S]*Mitochondria produce ATP[\s\S]*\[src_.+#L1-L1]/);
    await expect(readFile(
      path.join(root, ".metis", "skills", "metis-grounded-answers", "SKILL.md"),
      "utf8",
    )).resolves.toMatch(/^---\nname: metis-grounded-answers\ndescription:/);
    await expect(readFile(
      path.join(root, ".metis", "skills", "metis-vault-maintenance", "agents", "openai.yaml"),
      "utf8",
    )).resolves.toContain("$metis-vault-maintenance");
    await expect(readFile(
      path.join(root, ".metis", "cache", "search-v1", "stale.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(
      path.join(root, "wiki", "concepts", "untracked.md"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(await repairedKnowledge.search("What produces ATP?", 1, "sources"))
      .toEqual([expect.objectContaining({ documentId: ingested.source.id })]);

    const second = await repair.repair();
    expect(second.skills).toEqual(expect.objectContaining({
      current: true,
      updated: false,
    }));
    expect(second.knowledge).toEqual(expect.objectContaining({
      wiki: expect.objectContaining({ evidenceStubsRebuilt: 0 }),
      searchIndex: expect.objectContaining({ reused: 1, rebuilt: 0 }),
    }));
    const full = await repair.repair({ mode: "full" });
    expect(full.knowledge).toEqual(expect.objectContaining({
      mode: "full",
      searchIndex: expect.objectContaining({ reused: 0, rebuilt: 1 }),
    }));
    await expect(readFile(rawPath)).resolves.toEqual(rawBefore);

    const skillManifestPath = path.join(root, ".metis", "skills", "manifest.json");
    const skillManifest = JSON.parse(
      await readFile(skillManifestPath, "utf8"),
    ) as { files: Record<string, string> };
    skillManifest.files["obsolete/SKILL.md"] = "0".repeat(64);
    await writeFile(
      skillManifestPath,
      `${JSON.stringify(skillManifest, null, 2)}\n`,
      "utf8",
    );
    const obsoleteSkillPath = path.join(
      root,
      ".metis",
      "skills",
      "obsolete",
      "SKILL.md",
    );
    await mkdir(path.dirname(obsoleteSkillPath), { recursive: true });
    await writeFile(obsoleteSkillPath, "obsolete\n", "utf8");
    const synchronizedSkills = await syncMetisSkills(reopened);
    expect(synchronizedSkills).toEqual(expect.objectContaining({
      updated: true,
      removedFiles: [".metis/skills/obsolete/SKILL.md"],
    }));
    await expect(readFile(obsoleteSkillPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops on modified raw evidence and rolls managed files back", async () => {
    const { root, store, knowledge } = await fixture();
    const ingested = await knowledge.ingest({
      title: "Immutable Evidence",
      content: "The original verified statement remains authoritative.",
    });
    await knowledge.upsertWikiPage({
      title: "Verified Statement",
      summary: "A statement backed by immutable evidence.",
      markdown: `# Verified Statement\n\nThe original verified statement remains authoritative. [${ingested.source.id}#L1-L1]`,
      sourceIds: [ingested.source.id],
    });
    const wikiPath = path.join(root, "wiki", "concepts", "verified-statement.md");
    const wikiBefore = await readFile(wikiPath, "utf8");
    const rawPath = path.join(root, ingested.source.relativePath);
    await chmod(rawPath, 0o644);
    await writeFile(rawPath, "Tampered evidence must not be accepted.\n", "utf8");

    const repair = new RepairService(store, new KnowledgeService(store));
    await expect(repair.repair()).rejects.toThrow(
      /repair failed.*restored.*source integrity check failed/is,
    );
    await expect(readFile(rawPath, "utf8"))
      .resolves.toBe("Tampered evidence must not be accepted.\n");
    await expect(readFile(wikiPath, "utf8")).resolves.toContain(
      wikiBefore.split("\n").find((line) => line.includes("original verified"))!,
    );
    await expect(readFile(
      path.join(root, ".metis", "repair.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.listVaultBackups()).length).toBeGreaterThanOrEqual(2);
  });
});

describe("repair CLI", () => {
  it("runs the same dry-run and repair workflow without an MCP client", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "metis-cli-test-"));
    temporaryDirectories.push(root);
    const entry = path.resolve("src", "index.ts");
    const previewRun = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      entry,
      "repair",
      "--vault",
      root,
      "--dry-run",
    ], { maxBuffer: 2 * 1024 * 1024 });
    const preview = JSON.parse(previewRun.stdout) as Record<string, unknown>;
    expect(preview).toEqual(expect.objectContaining({
      dryRun: true,
      repaired: false,
      mode: "incremental",
    }));

    const repairRun = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      entry,
      "repair",
      "--vault",
      root,
      "--full",
    ], { maxBuffer: 2 * 1024 * 1024 });
    const repaired = JSON.parse(repairRun.stdout) as Record<string, unknown>;
    expect(repaired).toEqual(expect.objectContaining({
      dryRun: false,
      repaired: true,
      mode: "full",
      backupRelativePath: expect.stringMatching(/^\.metis\/backups\//),
    }));
    await expect(readFile(
      path.join(root, ".metis", "skills", "manifest.json"),
      "utf8",
    )).resolves.toContain('"formatVersion": 1');
  });
});
