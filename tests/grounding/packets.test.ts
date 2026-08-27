import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKernel } from "../../src/kernel.js";
import { GroundingService } from "../../src/grounding/service.js";
import { PacketStore } from "../../src/grounding/packets.js";
import {
  fixture,
  useTemporaryVaults,
} from "../support/vault.js";

useTemporaryVaults();

describe("packet persistence", () => {
  const notes = [
    "# Gradient descent",
    "",
    "Gradient descent iteratively updates parameters in the negative gradient direction.",
    "A learning rate controls the update step size.",
    "For a convex differentiable objective, suitable step sizes support convergence.",
  ].join("\n");

  it("reuses a packet built before the process restarted", async () => {
    const { store, metis, grounding } = await fixture();
    await metis.ingestion.ingest({ title: "Gradient Descent Notes", content: notes });
    const packet = await grounding.prepareAnswer(
      "What controls the gradient descent step size?",
      "sources_only",
    );
    expect(packet.evidence.length).toBeGreaterThan(0);

    // Fresh services, as if an MCP client reconnected to a restarted server.
    const restarted = new GroundingService(
      store,
      createKernel(store).search,
      new PacketStore(store),
    );
    const followUp = await restarted.prepareAnswer(
      "Which parameter controls the gradient descent update step size?",
      "sources_only",
      3,
      packet.packetId,
    );
    expect(followUp.reusedEvidence).toEqual(expect.objectContaining({
      fromPacketId: packet.packetId,
    }));
    expect(followUp.reusedEvidence?.citations.length).toBeGreaterThan(0);
    expect(followUp).not.toHaveProperty("reuseUnavailable");
  });

  it("stores citations without a second copy of the evidence", async () => {
    const { root, metis, grounding } = await fixture();
    await metis.ingestion.ingest({ title: "Gradient Descent Notes", content: notes });
    const packet = await grounding.prepareAnswer(
      "What controls the gradient descent step size?",
      "sources_only",
    );

    const record = JSON.parse(await readFile(
      path.join(root, ".metis", "cache", "packets-v1", `${packet.packetId}.json`),
      "utf8",
    )) as { citations: string[] };
    expect(record.citations).toEqual(
      expect.arrayContaining([packet.evidence[0]!.citation]),
    );
    // The excerpt body is deliberately absent: the citation plus a verified
    // source rehydrates it, and a copy here would be unverified evidence.
    expect(JSON.stringify(record)).not.toContain("negative gradient direction");
  });

  it("falls back to full evidence when the prior packet used another mode", async () => {
    const { store, metis, grounding } = await fixture();
    await metis.ingestion.ingest({ title: "Gradient Descent Notes", content: notes });
    const packet = await grounding.prepareAnswer(
      "What controls the gradient descent step size?",
      "sources_only",
    );

    const restarted = new GroundingService(
      store,
      createKernel(store).search,
      new PacketStore(store),
    );
    const followUp = await restarted.prepareAnswer(
      "Which parameter controls the gradient descent update step size?",
      "sources_first",
      3,
      packet.packetId,
    );
    expect(followUp.reuseUnavailable).toBe(true);
    expect(followUp).not.toHaveProperty("reusedEvidence");
  });
});
