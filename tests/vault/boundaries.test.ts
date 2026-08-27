import { readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKernel } from "../../src/kernel.js";
import { RepairService } from "../../src/repair/service.js";
import { StudyStore } from "../../src/vault/store.js";
import {
  fixture,
  temporaryDirectory,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

describe("vault path boundaries", () => {
  it.skipIf(process.platform === "win32")(
    "rejects vault-relative symlinks that resolve outside the vault",
    async () => {
      const { root, metis } = await fixture();
      const externalRoot = await temporaryDirectory("metis-external-");
      const externalPath = path.join(externalRoot, "outside.txt");
      await writeFile(externalPath, "This file is outside the study vault.", "utf8");
      await symlink(externalPath, path.join(root, "linked-source.txt"));

      await expect(metis.ingestion.ingest({
        title: "Escaped Source",
        sourcePath: "linked-source.txt",
      })).rejects.toThrow(/outside the configured study vault/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects managed vault directories that are symlinked outside the vault",
    async () => {
      const root = await temporaryDirectory("metis-managed-symlink-");
      const externalRoot = await temporaryDirectory("metis-managed-external-");
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
      const externalRoot = await temporaryDirectory("metis-skill-external-");
      await symlink(
        externalRoot,
        path.join(root, ".metis", "skills"),
        "dir",
      );

      const repairKernel = createKernel(store);
      const repair = new RepairService(
        store,
        repairKernel.knowledgeRepair,
        repairKernel.wiki,
      );
      await expect(repair.repair()).rejects.toThrow(
        /repair failed.*outside the configured study vault/is,
      );
      await expect(readdir(externalRoot)).resolves.toEqual([]);
    },
  );
});
