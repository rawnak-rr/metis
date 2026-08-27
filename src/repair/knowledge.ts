import { chmod, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { SourceRecord, StudyState, WikiPageRecord } from "../contracts/types.js";
import { WIKI_CITATION_PATTERN } from "../contracts/citation.js";
import { isDerivedTextPersisted } from "../contracts/source-types.js";
import { nowIso, stripFrontmatter, unique } from "../shared/util.js";
import {
  DERIVED_TEXT_CACHE_DIRECTORY,
  GENERATED_WIKI_FORMAT_VERSION,
  SEARCH_INDEX_CACHE_DIRECTORY,
} from "../vault/layout.js";
import { pruneCacheDirectory } from "../vault/cache.js";
import { StudyStore } from "../vault/store.js";
import { VerifiedSourceReader, preview } from "../ingestion/source-reader.js";
import { tokenize } from "../shared/lexicon.js";
import { SearchService, type SearchIndexRepairResult } from "../search/service.js";
import { WikiService } from "../synthesis/wiki.js";

export type KnowledgeRepairMode = "incremental" | "full";

export interface KnowledgeRepairResult {
  mode: KnowledgeRepairMode;
  dryRun: boolean;
  sources: {
    total: number;
    verified: number;
    permissionsRepaired: number;
    descriptorsPreserved: number;
    descriptorsRefreshed: number;
  };
  wiki: {
    pages: number;
    preserved: number;
    metadataRefreshed: number;
    evidenceStubsRebuilt: number;
    brokenLinksRemoved: number;
    missingSourceReferencesRemoved: number;
    conceptsCreated: number;
    learnerReferencesRepaired: number;
    untrackedManagedFilesRemoved: number;
  };
  searchIndex: SearchIndexRepairResult;
  derivedText: {
    /** Sources whose text cannot be recomputed from the raw bytes. */
    expected: number;
    /** Entries whose text matched its recorded checksum. */
    verified: number;
    /** Pre-checksum entries rewritten with one. */
    upgraded: number;
    /** Pre-checksum entries left as they are, in a dry run. */
    unverified: number;
    /**
     * Sources with no usable entry. Their line citations cannot be resolved,
     * and for an image transcript nothing but a backup can recover them.
     */
    missingSourceIds: string[];
    staleEntriesRemoved: number;
  };
}
/**
 * Rebuilds everything derived from evidence, and nothing that is evidence.
 *
 * Repair reads through the same verified reader as the normal path, so a missing
 * or modified raw source stops the operation rather than being papered over from
 * derived data. Search indexes are disposable and rebuilt freely; derived text
 * is not, so each expected entry is read rather than counted. Valid authored
 * synthesis is preserved, and only a mechanically invalid page is replaced with
 * a minimal verbatim-evidence rebuild.
 */
export class KnowledgeRepair {
  constructor(
    private readonly store: StudyStore,
    private readonly reader: VerifiedSourceReader,
    private readonly search: SearchService,
    private readonly wiki: WikiService,
  ) {}

  async repairKnowledge(options: {
    mode?: KnowledgeRepairMode;
    dryRun?: boolean;
  } = {}): Promise<KnowledgeRepairResult> {
    const mode = options.mode ?? "incremental";
    const dryRun = options.dryRun ?? false;
    const state = structuredClone(await this.store.readState());
    const relationships = reconcileKnowledgeRelationships(state);
    if (!dryRun && relationships.changed) await this.store.writeState(state);

    let descriptorsPreserved = 0;
    let descriptorsRefreshed = 0;
    let permissionsRepaired = 0;
    for (const source of state.sources) {
      const verified = await this.reader.readVerifiedBytes(source);
      if (((await stat(verified.absolute)).mode & 0o222) !== 0) {
        permissionsRepaired += 1;
        if (!dryRun) await chmod(verified.absolute, 0o444);
      }
      const current = mode === "incremental"
        && await this.sourceDescriptorCurrent(source);
      if (current) {
        descriptorsPreserved += 1;
        continue;
      }
      descriptorsRefreshed += 1;
      if (!dryRun) {
        const sourceText = await this.reader.readSourceText(source);
        await this.store.writeSourcePage(source, preview(sourceText));
      }
    }

    let preserved = 0;
    let metadataRefreshed = 0;
    let evidenceStubsRebuilt = 0;
    for (const page of state.wikiPages) {
      const pageRelativePath = path.posix.join(
        "wiki",
        "concepts",
        `${page.slug}.md`,
      );
      let markdown = "";
      let valid = false;
      try {
        markdown = await this.store.readText(pageRelativePath);
        await this.wiki.validateWikiMarkdown(
          markdown,
          page.sourceIds,
          state.sources,
          "structural",
        );
        valid = true;
      } catch {
        valid = false;
      }

      if (!valid) {
        evidenceStubsRebuilt += 1;
        if (!dryRun) {
          const rebuilt = await this.recoveryWikiMarkdown(
            page,
            state.sources,
          );
          const updatedPage = {
            ...page,
            summary: rebuilt.summary,
            updatedAt: nowIso(),
          };
          await this.store.mutateManaged(
            (next) => {
              const index = next.wikiPages.findIndex((candidate) =>
                candidate.slug === updatedPage.slug);
              if (index < 0) {
                throw new Error(`Cannot repair missing wiki state for '${updatedPage.slug}'.`);
              }
              next.wikiPages[index] = updatedPage;
            },
            () => ({
              wikiPages: [{ page: updatedPage, markdown: rebuilt.markdown }],
            }),
          );
          Object.assign(page, updatedPage);
        }
        continue;
      }

      if (mode === "full" || !wikiMetadataCurrent(markdown, page)) {
        metadataRefreshed += 1;
        if (!dryRun) {
          await this.store.writeWikiPage(page, stripFrontmatter(markdown));
        }
      } else {
        preserved += 1;
      }
    }

    const untrackedManagedFilesRemoved = await this.pruneUntrackedWikiFiles(
      state,
      dryRun,
    );
    if (!dryRun) await this.store.rebuildWikiIndex();
    const searchIndex = await this.search.repairSearchIndex(state.sources, mode, dryRun);
    const derivedText = await this.repairDerivedText(state.sources, dryRun);
    return {
      mode,
      dryRun,
      sources: {
        total: state.sources.length,
        verified: state.sources.length,
        permissionsRepaired,
        descriptorsPreserved,
        descriptorsRefreshed,
      },
      wiki: {
        pages: state.wikiPages.length,
        preserved,
        metadataRefreshed,
        evidenceStubsRebuilt,
        brokenLinksRemoved: relationships.brokenLinksRemoved,
        missingSourceReferencesRemoved:
          relationships.missingSourceReferencesRemoved,
        conceptsCreated: relationships.conceptsCreated,
        learnerReferencesRepaired:
          relationships.learnerReferencesRepaired,
        untrackedManagedFilesRemoved,
      },
      searchIndex,
      derivedText,
    };
  }

  private async sourceDescriptorCurrent(source: SourceRecord): Promise<boolean> {
    try {
      const markdown = await this.store.readText(path.posix.join(
        "wiki",
        "sources",
        `${source.id}.md`,
      ));
      return markdown.includes(`metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`)
        && markdown.includes(`id: ${JSON.stringify(source.id)}`)
        && markdown.includes(`SHA-256: \`${source.checksum}\``)
        && markdown.includes(`Raw file: [${source.relativePath}]`);
    } catch {
      return false;
    }
  }

  private async recoveryWikiMarkdown(
    page: WikiPageRecord,
    sources: SourceRecord[],
  ): Promise<{ markdown: string; summary: string }> {
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const queryTokens = new Set(tokenize(`${page.title} ${page.summary}`));
    const blocks: string[] = [
      `# ${page.title}`,
      "",
      "## Recovered verbatim evidence",
      "",
    ];
    let summary = "";
    for (const sourceId of page.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) {
        throw new Error(
          `Cannot rebuild '${page.slug}': source '${sourceId}' is unavailable.`,
        );
      }
      const sourceText = await this.reader.readSourceText(source);
      const excerpt = bestRecoveryExcerpt(sourceText, queryTokens);
      if (!excerpt) {
        throw new Error(
          `Cannot rebuild '${page.slug}': source '${sourceId}' has no extractable text.`,
        );
      }
      const citation = `[${source.id}#L${excerpt.lineStart}-L${excerpt.lineEnd}]`;
      if (!summary) {
        summary = `Recovered evidence: ${excerpt.text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 480)}`;
      }
      const quoted = excerpt.text
        .replace(WIKI_CITATION_PATTERN, "[$1 line $2-$3]")
        .split("\n")
        .map((line) => `> ${line}`);
      quoted[quoted.length - 1] = `${quoted.at(-1)} ${citation}`;
      blocks.push(
        `### ${source.title}`,
        "",
        ...quoted,
        "",
      );
    }
    const markdown = blocks.join("\n").trimEnd();
    await this.wiki.validateWikiMarkdown(
      markdown,
      page.sourceIds,
      sources,
      "structural",
    );
    return { markdown: `${markdown}\n`, summary };
  }

  /**
   * Derived text is only expected for sources whose extraction is expensive or
   * non-deterministic; every other entry in the cache is stale.
   */
  private async repairDerivedText(
    sources: SourceRecord[],
    dryRun: boolean,
  ): Promise<KnowledgeRepairResult["derivedText"]> {
    const persisted = sources
      .filter((source) => isDerivedTextPersisted(source.extraction.method));
    const expected = new Set(persisted.map((source) => `${source.checksum}.json`));
    const staleEntriesRemoved = await pruneCacheDirectory(
      this.store,
      DERIVED_TEXT_CACHE_DIRECTORY,
      expected,
      dryRun,
    );
    // Counting the entries state expects would report a healthy cache for one
    // that is entirely absent, so each entry is read and checked instead.
    let verified = 0;
    let upgraded = 0;
    let unverified = 0;
    const missingSourceIds: string[] = [];
    for (const source of persisted) {
      const stored = await this.reader.readDerivedText(source);
      if (!stored) {
        missingSourceIds.push(source.id);
        continue;
      }
      if (stored.verified) {
        verified += 1;
        continue;
      }
      if (dryRun) {
        unverified += 1;
        continue;
      }
      if (await this.reader.persistDerivedText(source, stored.text)) {
        upgraded += 1;
      } else {
        unverified += 1;
      }
    }
    return {
      expected: persisted.length,
      verified,
      upgraded,
      unverified,
      missingSourceIds,
      staleEntriesRemoved,
    };
  }

  private async pruneUntrackedWikiFiles(
    state: StudyState,
    dryRun: boolean,
  ): Promise<number> {
    const managedDirectories = [
      {
        relativePath: path.posix.join("wiki", "concepts"),
        expected: new Set(state.wikiPages.map((page) => `${page.slug}.md`)),
      },
      {
        relativePath: path.posix.join("wiki", "sources"),
        expected: new Set(state.sources.map((source) => `${source.id}.md`)),
      },
    ];
    let removed = 0;
    for (const directory of managedDirectories) {
      const absolute = await this.store.resolveExisting(directory.relativePath);
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (
          (!entry.isFile() && !entry.isSymbolicLink())
          || !entry.name.endsWith(".md")
          || directory.expected.has(entry.name)
        ) {
          continue;
        }
        removed += 1;
        if (!dryRun) {
          await unlink(await this.store.resolveForWrite(path.posix.join(
            directory.relativePath,
            entry.name,
          )));
        }
      }
    }
    return removed;
  }
}

function reconcileKnowledgeRelationships(state: StudyState): {
  changed: boolean;
  brokenLinksRemoved: number;
  missingSourceReferencesRemoved: number;
  conceptsCreated: number;
  learnerReferencesRepaired: number;
} {
  const before = JSON.stringify(state);
  const sourceIds = new Set(state.sources.map((source) => source.id));
  const slugs = new Set(state.wikiPages.map((page) => page.slug));
  let brokenLinksRemoved = 0;
  let missingSourceReferencesRemoved = 0;
  let conceptsCreated = 0;
  let learnerReferencesRepaired = 0;

  for (const page of state.wikiPages) {
    page.aliases = unique(page.aliases);
    page.tags = unique(page.tags);
    const knownSources = unique(page.sourceIds.filter((id) => sourceIds.has(id)));
    missingSourceReferencesRemoved += page.sourceIds.length - knownSources.length;
    if (knownSources.length === 0) {
      throw new Error(
        `Cannot repair wiki page '${page.slug}': none of its source records remain.`,
      );
    }
    page.sourceIds = knownSources;
    const validLinks = unique(page.links.filter((link) =>
      link !== page.slug && slugs.has(link)));
    brokenLinksRemoved += page.links.length - validLinks.length;
    page.links = validLinks;

    let concept = state.concepts.find((candidate) => candidate.id === page.slug);
    if (!concept) {
      concept = {
        id: page.slug,
        title: page.title,
        notes: [],
        sourceIds: [...page.sourceIds],
      };
      state.concepts.push(concept);
      conceptsCreated += 1;
    } else {
      concept.title = page.title;
      concept.sourceIds = unique([
        ...concept.sourceIds.filter((id) => sourceIds.has(id)),
        ...page.sourceIds,
      ]);
    }
  }

  for (const concept of state.concepts) {
    const repaired = unique(concept.sourceIds.filter((id) => sourceIds.has(id)));
    if (repaired.length !== concept.sourceIds.length) {
      learnerReferencesRepaired += concept.sourceIds.length - repaired.length;
      concept.sourceIds = repaired;
    }
  }
  return {
    changed: before !== JSON.stringify(state),
    brokenLinksRemoved,
    missingSourceReferencesRemoved,
    conceptsCreated,
    learnerReferencesRepaired,
  };
}

function wikiMetadataCurrent(markdown: string, page: WikiPageRecord): boolean {
  return markdown.includes(`metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`)
    && markdown.includes(`title: ${JSON.stringify(page.title)}`)
    && markdown.includes(
      `aliases: [${page.aliases.map((value) => JSON.stringify(value)).join(", ")}]`,
    )
    && markdown.includes(
      `sources: [${page.sourceIds.map((value) => JSON.stringify(value)).join(", ")}]`,
    )
    && markdown.includes(
      `links: [${page.links.map((value) => JSON.stringify(value)).join(", ")}]`,
    );
}

function bestRecoveryExcerpt(
  sourceText: string,
  queryTokens: ReadonlySet<string>,
): { lineStart: number; lineEnd: number; text: string } | undefined {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  let best: {
    lineStart: number;
    lineEnd: number;
    text: string;
    score: number;
  } | undefined;
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start]?.trim()) continue;
    let end = start;
    let characters = 0;
    while (end < lines.length && end < start + 8) {
      const nextLength = lines[end]!.length + (end > start ? 1 : 0);
      if (end > start && characters + nextLength > 1_400) break;
      characters += nextLength;
      end += 1;
    }
    while (end > start + 1 && !lines[end - 1]?.trim()) end -= 1;
    let text = lines.slice(start, end).join("\n").trim();
    if (text.length > 1_400) text = text.slice(0, 1_400).trimEnd();
    if (!text) continue;
    const score = unique(tokenize(text))
      .filter((token) => queryTokens.has(token)).length;
    if (
      !best
      || score > best.score
      || (score > 0 && score === best.score && text.length < best.text.length)
    ) {
      best = {
        lineStart: start + 1,
        lineEnd: end,
        text,
        score,
      };
    }
  }
  return best && {
    lineStart: best.lineStart,
    lineEnd: best.lineEnd,
    text: best.text,
  };
}
