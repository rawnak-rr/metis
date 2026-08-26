import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createStudyServer } from "../src/server.js";

const roots: string[] = [];

function toolObject(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((item): item is { type: "text"; text: string } =>
    Boolean(item)
    && typeof item === "object"
    && (item as { type?: unknown }).type === "text"
    && typeof (item as { text?: unknown }).text === "string");
  expect(textBlock).toBeDefined();
  const parsed = JSON.parse(textBlock?.text ?? "");
  expect(parsed).not.toBeInstanceOf(Array);
  return parsed as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP surface", () => {
  it("connects, advertises the full study workflow, and executes tools and resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "metis-mcp-test-"));
    roots.push(root);
    const { server } = await createStudyServer(root);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "ingest_source",
        "ingest_sources",
        "metis_repair",
        "metis_restore_backup",
        "list_metis_backups",
        "upsert_wiki_page",
        "prepare_grounded_answer",
        "search_knowledge",
        "resolve_citations",
        "get_knowledge_graph",
        "lint_wiki",
      ]));
      expect(names).toHaveLength(12);

      const repairPreview = await client.callTool({
        name: "metis_repair",
        arguments: { dryRun: true },
      });
      expect(toolObject(repairPreview)).toEqual(expect.objectContaining({
        dryRun: true,
        repaired: false,
        migration: expect.objectContaining({ targetStateVersion: 5 }),
      }));

      const ingested = await client.callTool({
        name: "ingest_source",
        arguments: {
          title: "MCP Source",
          content: "The mitochondrion produces ATP through cellular respiration.",
        },
      });
      const ingestedObject = toolObject(ingested);
      const sourceId = String(
        (ingestedObject.source as Record<string, unknown>).id,
      );
      const wiki = await client.callTool({
        name: "upsert_wiki_page",
        arguments: {
          title: "Mitochondrion",
          summary: "Cellular ATP production.",
          markdown: `# Mitochondrion\n\nThe mitochondrion produces ATP through cellular respiration. [${sourceId}#L1-L1]`,
          sourceIds: [sourceId],
        },
      });
      toolObject(wiki);
      await writeFile(
        path.join(root, "wiki", "concepts", "mitochondrion.md"),
        "# Mitochondrion\n\nLegacy prose without inline evidence.\n",
        "utf8",
      );
      const repaired = await client.callTool({
        name: "metis_repair",
        arguments: {},
      });
      expect(toolObject(repaired)).toEqual(expect.objectContaining({
        repaired: true,
        wikiHealth: expect.objectContaining({
          healthy: true,
          issueCounts: expect.objectContaining({ error: 0 }),
        }),
        knowledge: expect.objectContaining({
          wiki: expect.objectContaining({ evidenceStubsRebuilt: 1 }),
        }),
      }));

      const search = await client.callTool({
        name: "search_knowledge",
        arguments: { query: "What produces ATP?", limit: 3 },
      });
      expect(JSON.stringify(toolObject(search))).toContain("mitochondrion");

      const rawSearch = toolObject(await client.callTool({
        name: "search_knowledge",
        arguments: { query: "What produces ATP?", limit: 3, scope: "sources" },
      })) as { evidence: Array<{ citation: string }> };
      const citation = rawSearch.evidence[0]!.citation;
      const rehydrated = toolObject(await client.callTool({
        name: "resolve_citations",
        arguments: { citations: [citation, "[src_missing#L1-L2]"] },
      })) as {
        resolved: Array<{ token: string; text: string }>;
        unresolved: Array<{ error: { code: string } }>;
      };
      expect(rehydrated.resolved).toEqual([expect.objectContaining({
        token: citation,
      })]);
      expect(rehydrated.resolved[0]!.text).toContain("mitochondrion");
      expect(rehydrated.unresolved[0]!.error.code).toBe("CITATION_SOURCE_UNKNOWN");

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("study://dashboard");
      const dashboard = await client.readResource({ uri: "study://dashboard" });
      const dashboardText = dashboard.contents[0] && "text" in dashboard.contents[0]
        ? dashboard.contents[0].text
        : "";
      expect(JSON.parse(dashboardText)).toEqual(expect.objectContaining({
        counts: expect.objectContaining({ sources: 1 }),
      }));

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining([
        "grounded-explanation",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("asks a sampling-capable client to judge facet support", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "metis-mcp-sampling-"));
    roots.push(root);
    const { server } = await createStudyServer(root);
    const client = new Client(
      { name: "sampling-client", version: "1.0.0" },
      { capabilities: { sampling: {} } },
    );
    const prompts: string[] = [];
    // Stand in for the client's model: read the numbered passages back out of
    // the prompt and support only the one that answers the question.
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const prompt = request.params.messages
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [message.content])
        .map((block) => "text" in block && typeof block.text === "string"
          ? block.text
          : "")
        .join("\n");
      prompts.push(prompt);
      const lines = prompt.split("\n");
      const verdicts: string[] = [];
      lines.forEach((line, index) => {
        const numbered = line.match(/^Passage (\d+):$/);
        if (!numbered) return;
        const body = lines[index + 1] ?? "";
        verdicts.push(`${numbered[1]}: ${
          body.includes("Passive convection") ? "supported" : "insufficient"
        }`);
      });
      return {
        model: "test-sampler",
        role: "assistant" as const,
        content: { type: "text" as const, text: verdicts.join("\n") },
      };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const decoy = toolObject(await client.callTool({
        name: "ingest_source",
        arguments: {
          title: "Safety Manual Index",
          content: "Thermal runaway mechanisms in the loop are documented in the safety manual.",
        },
      }));
      const answer = toolObject(await client.callTool({
        name: "ingest_source",
        arguments: {
          title: "Passive Cooling Note",
          content: "Passive convection removes decay heat and keeps the reactor coolant subcooled.",
        },
      }));
      const decoyId = String((decoy.source as Record<string, unknown>).id);
      const answerId = String((answer.source as Record<string, unknown>).id);

      const packet = toolObject(await client.callTool({
        name: "prepare_grounded_answer",
        arguments: {
          question: "Which mechanism prevents thermal runaway in the reactor coolant loop?",
          groundingMode: "sources_only",
        },
      }));

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Passage 1:");
      expect(packet.facets).toEqual([expect.objectContaining({
        status: "supported",
        statusMethod: "entailment",
        citations: [`[${answerId}#L1-L1]`],
        borderlineCitations: [`[${decoyId}#L1-L1]`],
      })]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
