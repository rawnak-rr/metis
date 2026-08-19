import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
        "metis_repair",
        "metis_restore_backup",
        "list_metis_backups",
        "upsert_wiki_page",
        "prepare_grounded_answer",
        "prepare_practice",
        "record_review",
        "resolve_misconception",
        "plan_study_session",
        "verify_math",
        "render_math_pdf",
        "lint_wiki",
      ]));
      expect(names.length).toBeGreaterThanOrEqual(16);

      const repairPreview = await client.callTool({
        name: "metis_repair",
        arguments: { dryRun: true },
      });
      expect(toolObject(repairPreview)).toEqual(expect.objectContaining({
        dryRun: true,
        repaired: false,
        migration: expect.objectContaining({ targetStateVersion: 3 }),
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
        "learn-topic",
        "adaptive-study-session",
        "verified-math-solution",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
