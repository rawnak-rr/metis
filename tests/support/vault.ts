import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { PacketStore } from "../../src/grounding/packets.js";
import { GroundingService } from "../../src/grounding/service.js";
import { createKernel } from "../../src/kernel.js";
import { StudyStore } from "../../src/vault/store.js";

/** Every vault a test created, removed after each test by `useTemporaryVaults`. */
export const temporaryDirectories: string[] = [];

/** Registers per-file cleanup. Call once at the top of a test file. */
export function useTemporaryVaults(): void {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });
}

/** A temporary directory that is not a vault, cleaned up with the rest. */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

/** An initialized vault with the kernel and grounding wired over it. */
export async function fixture() {
  const root = await temporaryDirectory("metis-test-");
  const store = new StudyStore(root);
  await store.initialize("Test Vault");
  const metis = createKernel(store);
  const grounding = new GroundingService(
    store,
    metis.search,
    new PacketStore(store),
  );
  return { root, store, metis, grounding };
}
