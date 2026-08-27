import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  temporaryDirectory,
  useTemporaryVaults,
} from "../support/vault.js";

const execFileAsync = promisify(execFile);

useTemporaryVaults();

describe("repair CLI", () => {
  it("runs the same dry-run and repair workflow without an MCP client", async () => {
    const root = await temporaryDirectory("metis-cli-test-");
    const entry = path.resolve("src", "cli", "index.ts");
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
