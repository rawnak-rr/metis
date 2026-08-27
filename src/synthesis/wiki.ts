import path from "node:path";
import type { SourceRecord, WikiPageRecord } from "../contracts/types.js";
import { parseWikiCitations, sliceCitedLines, sourceTextLines } from "../contracts/citation.js";
import { nowIso, slugify, stripFrontmatter, unique } from "../shared/util.js";
import { StudyStore } from "../vault/store.js";
import { VerifiedSourceReader } from "../ingestion/source-reader.js";
import { tokenize } from "../shared/lexicon.js";
import {
  assessClaim,
  lexicalSupportTokens,
  splitClaimUnits,
  stripCitationAndMarkdownSyntax,
  type ClaimAssessment,
} from "./claims.js";

export interface WikiLintResult {
  healthy: boolean;
  checkedAt: string;
  pages: number;
  sources: number;
  issues: Array<{
    severity: "error" | "warning" | "info";
    code:
      | "missing_source"
      | "broken_link"
      | "orphan_page"
      | "uncited_page"
      | "invalid_citation"
      | "unsupported_claim"
      | "source_integrity"
      | "stale_page";
    page: string;
    message: string;
  }>;
}

export type WikiValidationLevel = "structural" | "strict";

export interface WikiValidationContext {
  body: string;
  excerptsByToken: ReadonlyMap<string, string>;
}
/**
 * Compiled concept pages: writing them, validating their citations, and linting
 * the wiki as a whole.
 *
 * A page is synthesis, never authoritative evidence. What makes it trustworthy
 * is mechanical: every factual prose block carries an inline citation, every
 * citation is checked against the referenced raw source, and every declared
 * source is actually cited. `lintWiki` additionally assesses individual
 * sentences, and reports rather than rejects while that threshold is calibrated.
 */
export class WikiService {
  constructor(
    private readonly store: StudyStore,
    private readonly reader: VerifiedSourceReader,
  ) {}

  async upsertWikiPage(input: {
    title: string;
    summary: string;
    markdown: string;
    sourceIds: string[];
    aliases?: string[];
    links?: string[];
    tags?: string[];
    slug?: string;
  }): Promise<WikiPageRecord> {
    if (input.title.trim().length > 200) {
      throw new Error("Wiki titles must be at most 200 characters.");
    }
    if (input.summary.trim().length > 500) {
      throw new Error("Wiki summaries must be at most 500 characters.");
    }
    if ((input.aliases ?? []).some((alias) => alias.trim().length > 120)) {
      throw new Error("Wiki aliases must be at most 120 characters each.");
    }
    const state = await this.store.readState();
    const sourceIds = unique(input.sourceIds);
    const missingSources = sourceIds.filter((id) => !state.sources.some((source) => source.id === id));
    if (missingSources.length > 0) {
      throw new Error(`Unknown source IDs: ${missingSources.join(", ")}`);
    }
    if (sourceIds.length === 0) {
      throw new Error("A wiki page must cite at least one ingested source.");
    }
    const slug = slugify(input.slug?.trim() || input.title);
    const links = unique((input.links ?? []).map(slugify).filter((link) => link !== slug));
    const page: WikiPageRecord = {
      slug,
      title: input.title.trim(),
      summary: input.summary.trim(),
      aliases: unique((input.aliases ?? [])
        .map((alias) => alias.trim())
        .filter(Boolean)
        .filter((alias) => normalizeLookupKey(alias) !== normalizeLookupKey(input.title))),
      sourceIds,
      links,
      tags: unique((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
      updatedAt: nowIso(),
    };
    if (!page.title || !page.summary || !input.markdown.trim()) {
      throw new Error("Wiki title, summary, and markdown body are required.");
    }
    await this.validateWikiMarkdown(
      input.markdown,
      sourceIds,
      state.sources,
      "strict",
    );

    await this.store.mutateManaged(
      (next) => {
        const index = next.wikiPages.findIndex((candidate) => candidate.slug === slug);
        if (index >= 0) next.wikiPages[index] = page;
        else next.wikiPages.push(page);

        let concept = next.concepts.find((candidate) => candidate.id === slug);
        if (!concept) {
          concept = {
            id: slug,
            title: page.title,
            notes: [],
            sourceIds,
          };
          next.concepts.push(concept);
        } else {
          concept.title = page.title;
          concept.sourceIds = unique([...concept.sourceIds, ...sourceIds]);
        }
      },
      () => ({
        wikiPages: [{ page, markdown: input.markdown }],
        rebuildWikiIndex: true,
        log: {
          operation: "wiki",
          title: page.title,
          details: [
            `Page: \`wiki/concepts/${page.slug}.md\``,
            `Evidence: ${page.sourceIds.map((id) => `\`${id}\``).join(", ")}`,
            `Links: ${page.links.length > 0 ? page.links.map((link) => `[[${link}]]`).join(", ") : "none"}`,
          ],
        },
      }),
    );
    return page;
  }

  async lintWiki(options: { log?: boolean } = {}): Promise<WikiLintResult> {
    const state = await this.store.readState();
    const slugs = new Set(state.wikiPages.map((page) => page.slug));
    const sourceIds = new Set(state.sources.map((source) => source.id));
    const inbound = new Map(state.wikiPages.map((page) => [page.slug, 0]));
    const issues: WikiLintResult["issues"] = [];
    for (const source of state.sources) {
      try {
        await this.reader.readVerifiedBytes(source);
      } catch (error) {
        issues.push({
          severity: "error",
          code: "source_integrity",
          page: source.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const page of state.wikiPages) {
      if (page.sourceIds.length === 0) {
        issues.push({
          severity: "error",
          code: "uncited_page",
          page: page.slug,
          message: "Page has no source provenance.",
        });
      }
      for (const sourceId of page.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          issues.push({
            severity: "error",
            code: "missing_source",
            page: page.slug,
            message: `References unknown source '${sourceId}'.`,
          });
        }
      }
      for (const link of page.links) {
        if (!slugs.has(link)) {
          issues.push({
            severity: "warning",
            code: "broken_link",
            page: page.slug,
            message: `Links to missing concept page '${link}'.`,
          });
        } else {
          inbound.set(link, (inbound.get(link) ?? 0) + 1);
        }
      }
      if (page.sourceIds.length > 0 && page.sourceIds.every((sourceId) => sourceIds.has(sourceId))) {
        try {
          const markdown = await this.store.readText(
            path.posix.join("wiki", "concepts", `${page.slug}.md`),
          );
          const validation = await this.validateWikiMarkdown(
            markdown,
            page.sourceIds,
            state.sources,
            "structural",
          );
          try {
            this.validateWikiLexicalBlocks(validation);
          } catch (error) {
            issues.push({
              severity: "error",
              code: "invalid_citation",
              page: page.slug,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          for (const assessment of this.assessWikiClaims(validation)) {
            if (assessment.status !== "unsupported" || assessment.kind !== "checkable") {
              continue;
            }
            const unmatched = assessment.unmatched.slice(0, 8).join(", ");
            const more = assessment.unmatched.length > 8 ? ", ..." : "";
            issues.push({
              severity: "info",
              code: "unsupported_claim",
              page: page.slug,
              message: `The cited passage does not lexically support this wiki claim (${assessment.matched}/${assessment.required} required distinctive terms matched; unmatched: ${unmatched}${more}): "${assessment.claim.text.slice(0, 120)}"`,
            });
          }
        } catch (error) {
          issues.push({
            severity: "error",
            code: "invalid_citation",
            page: page.slug,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const newestEvidence = state.sources
        .filter((source) => page.sourceIds.includes(source.id))
        .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))[0];
      if (newestEvidence && newestEvidence.ingestedAt > page.updatedAt) {
        issues.push({
          severity: "warning",
          code: "stale_page",
          page: page.slug,
          message: `Cited source '${newestEvidence.id}' is newer than the compiled page.`,
        });
      }
    }
    if (state.wikiPages.length > 1) {
      for (const page of state.wikiPages) {
        if ((inbound.get(page.slug) ?? 0) === 0 && page.links.length === 0) {
          issues.push({
            severity: "info",
            code: "orphan_page",
            page: page.slug,
            message: "Page has no incoming or outgoing concept links.",
          });
        }
      }
    }
    const result: WikiLintResult = {
      healthy: !issues.some((issue) => issue.severity === "error"),
      checkedAt: nowIso(),
      pages: state.wikiPages.length,
      sources: state.sources.length,
      issues,
    };
    if (options.log !== false) {
      await this.store.appendLog("lint", "Wiki health check", [
        `Pages: ${result.pages}`,
        `Sources: ${result.sources}`,
        `Issues: ${issues.length}`,
        `Errors: ${issues.filter((issue) => issue.severity === "error").length}`,
      ]);
    }
    return result;
  }

  async validateWikiMarkdown(
    markdown: string,
    declaredSourceIds: string[],
    sources: SourceRecord[],
    level: WikiValidationLevel,
  ): Promise<WikiValidationContext> {
    const body = stripFrontmatter(markdown);
    const citations = parseWikiCitations(body);
    if (citations.length === 0) {
      throw new Error("Wiki pages must contain at least one inline source citation in the form [source_id#L1-L4].");
    }

    const excerptsByToken = new Map<string, string>();
    const citedSourceIds = new Set<string>();
    const sourceLines = new Map<string, string[]>();
    for (const citation of citations) {
      if (!declaredSourceIds.includes(citation.sourceId)) {
        throw new Error(
          `Citation ${citation.token} references a source not declared in sourceIds.`,
        );
      }
      const source = sources.find((candidate) => candidate.id === citation.sourceId);
      if (!source) {
        throw new Error(`Citation ${citation.token} references an unknown source.`);
      }
      let lines = sourceLines.get(source.id);
      if (!lines) {
        lines = sourceTextLines(await this.reader.readSourceText(source));
        sourceLines.set(source.id, lines);
      }
      excerptsByToken.set(citation.token, sliceCitedLines(lines, citation));
      citedSourceIds.add(citation.sourceId);
    }

    const uncitedSources = declaredSourceIds.filter((sourceId) => !citedSourceIds.has(sourceId));
    if (uncitedSources.length > 0) {
      throw new Error(
        `Every declared source must be cited in the page body. Missing: ${uncitedSources.join(", ")}`,
      );
    }

    for (const block of wikiClaimBlocks(body)) {
      const blockCitations = parseWikiCitations(block);
      const claim = stripCitationAndMarkdownSyntax(block);
      const claimTokens = lexicalSupportTokens(claim);
      if (claimTokens.length === 0) continue;
      if (blockCitations.length === 0) {
        throw new Error(
          `Every factual prose block needs an inline source citation. Uncited block: "${claim.slice(0, 120)}"`,
        );
      }
    }

    const validation = { body, excerptsByToken };
    if (level === "strict") this.validateWikiLexicalBlocks(validation);
    return validation;
  }

  private validateWikiLexicalBlocks(validation: WikiValidationContext): void {
    for (const block of wikiClaimBlocks(validation.body)) {
      const blockCitations = parseWikiCitations(block);
      const claim = stripCitationAndMarkdownSyntax(block);
      const claimTokens = lexicalSupportTokens(claim);
      if (claimTokens.length === 0) continue;
      const evidence = blockCitations
        .map((citation) => validation.excerptsByToken.get(citation.token) ?? "")
        .join("\n");
      const evidenceTokens = new Set(lexicalSupportTokens(evidence));
      const overlap = claimTokens.filter((token) => evidenceTokens.has(token)).length;
      const requiredOverlap = Math.min(
        claimTokens.length,
        Math.max(2, Math.ceil(claimTokens.length / 2)),
      );
      if (overlap < requiredOverlap) {
        throw new Error(
          `The cited passage does not lexically support this wiki block (${overlap}/${requiredOverlap} required distinctive terms matched): "${claim.slice(0, 120)}"`,
        );
      }
    }
  }

  private assessWikiClaims(validation: WikiValidationContext): ClaimAssessment[] {
    return wikiClaimBlocks(validation.body).flatMap((block) => {
      const evidence = parseWikiCitations(block)
        .map((citation) => validation.excerptsByToken.get(citation.token) ?? "")
        .join("\n");
      const evidenceTokens = new Set(lexicalSupportTokens(evidence));
      return splitClaimUnits(block)
        .filter((unit) => lexicalSupportTokens(unit.text).length > 0)
        .map((unit) => assessClaim(unit, evidenceTokens));
    });
  }
}

function normalizeLookupKey(value: string): string {
  return unique(tokenize(value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()))
    .join(" ");
}

function wikiClaimBlocks(markdown: string): string[] {
  return stripFrontmatter(markdown)
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block
      .split("\n")
      .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
      .join("\n")
      .trim())
    .filter((block) => {
      if (!block) return false;
      if (/^(?:```|~~~)/.test(block)) return false;
      if (/^(?:\$\$|\\\[)/.test(block)) return false;
      if (/^(?:evidence|related|see also|sources?)\s*:/i.test(block)) return false;
      return true;
    });
}
