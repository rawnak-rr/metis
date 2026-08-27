import { readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StudyStore } from "../../src/vault/store.js";
import {
  fixture,
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

});
