import { chmod, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKernel } from "../../src/kernel.js";
import { RepairService } from "../../src/repair/service.js";
import { syncMetisSkills } from "../../src/repair/skills.js";
import { StudyStore } from "../../src/vault/store.js";
import {
  fixture,
  temporaryDirectory,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

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
    const { root, metis } = await fixture();
    const source = await metis.ingestion.ingest({
      title: "Fractions",
      content: "A common denominator is required before adding fractions.",
    });
    await metis.wiki.upsertWikiPage({
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
    const { root, store, metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Cellular Respiration",
      content: "Mitochondria produce ATP through cellular respiration.",
      tags: ["biology"],
    });
    await metis.wiki.upsertWikiPage({
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
    const repairedKnowledge = createKernel(reopened);
    const repair = new RepairService(
      reopened,
      repairedKnowledge.knowledgeRepair,
      repairedKnowledge.wiki,
    );
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
    expect(await repairedKnowledge.search.search("What produces ATP?", 1))
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
    const { root, store, metis } = await fixture();
    const ingested = await metis.ingestion.ingest({
      title: "Immutable Evidence",
      content: "The original verified statement remains authoritative.",
    });
    await metis.wiki.upsertWikiPage({
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

    const repairKernel = createKernel(store);
    const repair = new RepairService(
      store,
      repairKernel.knowledgeRepair,
      repairKernel.wiki,
    );
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
