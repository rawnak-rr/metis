import type {
  SourceRecord,
  StudyState,
  WikiPageRecord,
} from "../contracts/types.js";
import { describeExtraction } from "../contracts/source-types.js";
import { nowIso, yamlString } from "../shared/util.js";
import { GENERATED_WIKI_FORMAT_VERSION } from "./layout.js";

/**
 * The exact text of every file Metis generates inside a vault.
 *
 * Repair compares a generated file against what these produce to decide whether
 * it is current, so the templates and that check have to be reading the same
 * thing. Nothing here touches the filesystem.
 */
export function sourcePageText(source: SourceRecord, preview: string): string {
  return [
    "---",
    `metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`,
    `id: ${yamlString(source.id)}`,
    `title: ${yamlString(source.title)}`,
    `type: "source"`,
    `ingested: ${yamlString(source.ingestedAt)}`,
    `kind: ${yamlString(source.kind)}`,
    `extraction: ${yamlString(describeExtraction(source))}`,
    `tags: [${source.tags.map(yamlString).join(", ")}]`,
    "---",
    "",
    `# ${source.title}`,
    "",
    `> [!source] Immutable source`,
    `> ID: \`${source.id}\`  `,
    `> Raw file: [${source.relativePath}](../../${source.relativePath})  `,
    `> SHA-256: \`${source.checksum}\``,
    `> Text extraction: \`${describeExtraction(source)}\``,
    "",
    "## Preview",
    "",
    preview.trim() || "_No text preview is available._",
    "",
    "## Notes",
    "",
    "This page records provenance. Create or update concept pages with `upsert_wiki_page` after synthesizing the source.",
    "",
  ].join("\n");
}

export function wikiPageText(page: WikiPageRecord, markdown: string): string {
  const frontmatter = [
    "---",
    `metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`,
    `title: ${yamlString(page.title)}`,
    `summary: ${yamlString(page.summary)}`,
    `aliases: [${page.aliases.map(yamlString).join(", ")}]`,
    `updated: ${yamlString(page.updatedAt)}`,
    `sources: [${page.sourceIds.map(yamlString).join(", ")}]`,
    `links: [${page.links.map(yamlString).join(", ")}]`,
    `tags: [${page.tags.map(yamlString).join(", ")}]`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${markdown.trim()}\n`;
}

export function logText(
  existing: string,
  operation: string,
  title: string,
  details: string[],
): string {
  const entry = [
    "",
    `## [${nowIso()}] ${operation} | ${title}`,
    "",
    ...details.map((detail) => `- ${detail}`),
    "",
  ].join("\n");
  return `${existing.trimEnd()}\n${entry}`;
}

export function wikiIndexText(state: StudyState): string {
  const concepts = [...state.wikiPages]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((page) => `- [[concepts/${page.slug}|${page.title}]] — ${page.summary} (${page.sourceIds.length} source${page.sourceIds.length === 1 ? "" : "s"})`);
  const sources = [...state.sources]
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))
    .map((source) => `- [[sources/${source.id}|${source.title}]] — \`${source.id}\` · ${source.tags.join(", ") || "untagged"}`);
  const index = [
    "---",
    `generated: ${yamlString(nowIso())}`,
    `source_count: ${state.sources.length}`,
    `concept_count: ${state.wikiPages.length}`,
    "---",
    "",
    "# Study Wiki",
    "",
    "## Concepts",
    "",
    ...(concepts.length > 0 ? concepts : ["_No concept pages yet._"]),
    "",
    "## Sources",
    "",
    ...(sources.length > 0 ? sources : ["_No sources ingested yet._"]),
    "",
  ].join("\n");
  return index;
}

export const WIKI_SCHEMA = `# Study Wiki Schema

This vault separates evidence from synthesis so its knowledge stays inspectable.

## Layers

1. \`raw/\` contains immutable source copies. Never edit a file after ingestion; ingest a changed document as a new source.
2. \`wiki/sources/\` contains provenance pages generated from raw sources.
3. \`wiki/concepts/\` contains compiled, cross-linked explanations maintained through the MCP.
4. \`wiki/index.md\` is the content map. \`wiki/log.md\` is the append-only operation timeline.
5. \`.metis/\` contains portable machine state: the source, wiki page, and concept records, the derived-text and search caches, and managed backups.

## Concept page contract

- YAML frontmatter lists title, summary, aliases, updated time, source IDs, links, and tags.
- Every factual prose block includes an inline raw-source line-span token returned by search, such as \`[src_ab12#L8-L14]\`.
- Citation source IDs and ranges must exist, and at least half of each block's distinctive terms must occur in the cited excerpts.
- Direct evidence, inference, contradiction, and open questions are distinguished explicitly.
- Related concepts are linked with Obsidian wikilinks.
- A page is updated when newly ingested evidence changes or challenges its synthesis.

## Answering

- Use the compiled wiki for navigation and synthesis, but use checksum-verified raw sources as the authoritative evidence behind every answer.
- Default to sources-first grounding. Outside knowledge is added only when the vault is insufficient and is clearly labelled.
- Never invent citations.
- Quote numerical results from the cited excerpt. A figure the sources do not contain is derived work, and is labelled as such alongside the evidence it rests on.

## Maintenance

Run the wiki health check after material updates. Resolve missing provenance and broken links first, then connect orphan pages and revisit stale synthesis.
`;
