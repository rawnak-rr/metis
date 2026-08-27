import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { MetisError, type MetisErrorCode } from "../../src/shared/errors.js";
import {
  extractLatexText,
  extractMarkdownText,
  normalizeText,
} from "../../src/ingestion/extract.js";
import { KnowledgeService } from "../../src/ingestion/knowledge.js";
import { createStudyServer } from "../../src/mcp/server.js";
import { StudyStore } from "../../src/vault/store.js";
import { sha256 } from "../../src/shared/util.js";
import {
  AnthropicVisionTranscriber,
  CHEAPEST_VISION_MODEL,
  type VisionTranscriber,
} from "../../src/ingestion/vision.js";

const temporaryDirectories: string[] = [];

/** Records every call so tests can assert that transcription is never repeated. */
class StubTranscriber implements VisionTranscriber {
  readonly model = CHEAPEST_VISION_MODEL;
  readonly calls: Array<{ mediaType: string; title: string; bytes: number }> = [];

  constructor(private readonly behaviour: string | MetisError) {}

  async transcribe(input: {
    bytes: Buffer;
    mediaType: string;
    title: string;
  }): Promise<string> {
    this.calls.push({
      mediaType: input.mediaType,
      title: input.title,
      bytes: input.bytes.byteLength,
    });
    if (this.behaviour instanceof MetisError) throw this.behaviour;
    return this.behaviour;
  }
}

async function fixture(vision?: VisionTranscriber) {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-ingest-"));
  temporaryDirectories.push(root);
  const store = new StudyStore(root);
  await store.initialize("Ingest Vault");
  const knowledge = new KnowledgeService(store, vision);
  return { root, store, knowledge };
}

/** One-pixel PNG; the stub transcriber never decodes it. */
function pngBytes(padding = 0): Buffer {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AABAAB/wD8HwGiAAAAAElFTkSuQmCC",
    "base64",
  );
  return padding > 0 ? Buffer.concat([image, Buffer.alloc(padding)]) : image;
}

/** Minimal single-page PDF with one text line, readable by pdftotext. */
function pdfBytes(line: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
      + " /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let document = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(document.length);
    document += object;
  }
  const xrefAt = document.length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

async function ingestCode(operation: () => Promise<unknown>): Promise<MetisErrorCode> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MetisError);
    return (error as MetisError).code;
  }
  throw new Error("Expected ingestion to fail.");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("text extraction", () => {
  it("normalizes line endings and invisible whitespace without moving lines", () => {
    const normalized = normalizeText("first line  \r\nsecond\rthird\u200b\n");
    expect(normalized).toBe("first line\nsecond\nthird\n");
    expect(normalized.split("\n")).toHaveLength(4);
  });

  it("blanks Markdown frontmatter but keeps every body line in place", () => {
    const raw = [
      "---",
      "title: Photosynthesis",
      "tags: [biology]",
      "---",
      "",
      "# Photosynthesis",
      "",
      "Photosynthesis converts light energy into chemical energy.",
    ].join("\r\n");
    const lines = extractMarkdownText(raw).split("\n");

    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 4)).toEqual(["", "", "", ""]);
    expect(lines[5]).toBe("# Photosynthesis");
    expect(lines[7]).toBe("Photosynthesis converts light energy into chemical energy.");
  });

  it("keeps Markdown untouched when there is no frontmatter", () => {
    const raw = "# Title\n\n---\n\nBody text.\n";
    expect(extractMarkdownText(raw)).toBe(raw);
  });

  it("reduces LaTeX to citable prose while preserving line numbers", () => {
    const raw = [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\title{Mitochondria}",
      "\\begin{document}",
      "\\maketitle",
      "\\section{Cellular respiration}",
      "% Reviewer note: expand this paragraph later.",
      "Mitochondria produce \\textbf{ATP} through cellular respiration. % inline note",
      "Roughly 90\\% of cellular ATP is produced there~\\cite{alberts}.",
      "\\begin{itemize}",
      "  \\item The inner membrane hosts the electron transport chain.",
      "\\end{itemize}",
      "\\label{sec:respiration}",
      "\\end{document}",
      "Trailing junk after the document body.",
    ].join("\n");
    const lines = extractLatexText(raw).split("\n");

    expect(lines).toHaveLength(15);
    expect(lines.slice(0, 5)).toEqual(["", "", "", "", ""]);
    expect(lines[5]).toBe("## Cellular respiration");
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe("Mitochondria produce ATP through cellular respiration.");
    expect(lines[8]).toBe("Roughly 90% of cellular ATP is produced there .");
    expect(lines[9]).toBe("");
    expect(lines[10]).toBe("- The inner membrane hosts the electron transport chain.");
    expect(lines.slice(11)).toEqual(["", "", "", ""]);
  });

  it("keeps a nested section title and drops its trailing label", () => {
    expect(extractLatexText(
      "\\subsection{The \\textbf{ATP} cycle}\\label{sec:atp}",
    )).toBe("### The ATP cycle");
  });

  it("keeps a LaTeX fragment that has no document environment", () => {
    const lines = extractLatexText([
      "\\section{Fragment}",
      "Plain prose survives. % trailing comment",
    ].join("\n")).split("\n");
    expect(lines).toEqual(["## Fragment", "Plain prose survives."]);
  });
});

describe("ingestion", () => {
  it("cites Markdown body lines at their raw-file line numbers", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(
      path.join(root, "notes.md"),
      [
        "---",
        "title: Photosynthesis",
        "---",
        "",
        "Photosynthesis converts light energy into chemical energy.",
        "",
      ].join("\n"),
      "utf8",
    );

    const ingested = await knowledge.ingest({
      title: "Photosynthesis Notes",
      sourcePath: "notes.md",
    });

    expect(ingested.source.kind).toBe("markdown");
    expect(ingested.source.extraction).toEqual({ method: "markdown" });
    // Line 5 of the raw file is line 5 of the extracted text.
    await expect(knowledge.upsertWikiPage({
      title: "Photosynthesis",
      summary: "Light energy becomes chemical energy.",
      markdown: `# Photosynthesis\n\nPhotosynthesis converts light energy into chemical energy. [${ingested.source.id}#L5-L5]`,
      sourceIds: [ingested.source.id],
    })).resolves.toEqual(expect.objectContaining({ slug: "photosynthesis" }));
  });

  it("indexes LaTeX prose and never indexes its preamble or comments", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(
      path.join(root, "paper.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{unlikelypackagename}",
        "\\begin{document}",
        "\\section{Respiration}",
        "% secretcommentmarker should never be searchable",
        "Mitochondria produce ATP through cellular respiration.",
        "\\end{document}",
      ].join("\n"),
      "utf8",
    );

    const ingested = await knowledge.ingest({
      title: "Respiration Paper",
      sourcePath: "paper.tex",
    });

    expect(ingested.source.kind).toBe("latex");
    expect(ingested.source.extraction.method).toBe("latex");
    const text = await knowledge.readSourceText(ingested.source);
    expect(text).toContain("Mitochondria produce ATP");
    expect(text).not.toContain("secretcommentmarker");
    expect(text).not.toContain("unlikelypackagename");
    expect(await knowledge.search("secretcommentmarker")).toEqual([]);
    expect(await knowledge.search("mitochondria respiration"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ documentId: ingested.source.id }),
      ]));
  });

  it("extracts PDF text once and reuses the persisted derivation", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(
      path.join(root, "paper.pdf"),
      pdfBytes("Photosynthesis converts light energy into chemical energy."),
    );

    const ingested = await knowledge.ingest({
      title: "Photosynthesis Paper",
      sourcePath: "paper.pdf",
    });

    expect(ingested.source.kind).toBe("pdf");
    expect(ingested.source.extraction.method).toBe("pdftotext");
    expect(ingested.source.extraction.extractedAt).toBeTruthy();
    expect(ingested.preview).toContain("Photosynthesis converts light energy");

    const derived = JSON.parse(await readFile(
      path.join(root, ".metis", "cache", "text-v1", `${ingested.source.checksum}.json`),
      "utf8",
    )) as Record<string, unknown>;
    expect(derived).toEqual(expect.objectContaining({
      formatVersion: 2,
      sourceChecksum: ingested.source.checksum,
      method: "pdftotext",
    }));
    expect(derived.textChecksum).toBe(sha256(String(derived.text)));
    expect(String(derived.text)).toContain("chemical energy");
  });

  it("reports a coded failure for a file that pdftotext cannot read", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(path.join(root, "broken.pdf"), "This is not really a PDF.", "utf8");

    expect(await ingestCode(() => knowledge.ingest({
      title: "Broken PDF",
      sourcePath: "broken.pdf",
    }))).toBe("EXTRACT_PDF_FAILED");
    expect(await readdir(path.join(root, "raw"))).toEqual([]);
  });
});

describe("image ingestion", () => {
  it("transcribes an image with the cheapest vision model and stores provenance", async () => {
    const transcriber = new StubTranscriber(
      "Figure 1: Chlorophyll absorbs red and blue light.\nAbsorption peaks near 430 nm.",
    );
    const { root, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());

    const ingested = await knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
      tags: ["biology"],
    });

    expect(transcriber.calls).toEqual([expect.objectContaining({
      mediaType: "image/png",
      title: "Chlorophyll Slide",
    })]);
    expect(ingested.source.kind).toBe("image");
    expect(ingested.source.extraction).toEqual(expect.objectContaining({
      method: "vision",
      mediaType: "image/png",
      model: CHEAPEST_VISION_MODEL,
    }));
    expect(ingested.preview).toContain("Chlorophyll absorbs red and blue light");
    expect(await knowledge.search("chlorophyll absorption"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ documentId: ingested.source.id }),
      ]));
    await expect(readFile(
      path.join(root, ".metis", "cache", "text-v1", `${ingested.source.checksum}.json`),
      "utf8",
    )).resolves.toContain("Chlorophyll absorbs");
  });

  it("never transcribes the same image twice", async () => {
    const transcriber = new StubTranscriber("Absorption peaks near 430 nm.");
    const { root, store } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const first = new KnowledgeService(store, transcriber);
    const ingested = await first.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    });

    // A duplicate ingestion, and a fresh process reading the same source, both
    // reuse the persisted transcript rather than paying for the model again.
    await first.ingest({ title: "Same Slide", sourcePath: "slide.png" });
    const reopened = new KnowledgeService(store, transcriber);
    const text = await reopened.readSourceText(ingested.source);

    expect(text).toContain("430 nm");
    expect(transcriber.calls).toHaveLength(1);
  });

  it("records the model override from METIS_VISION_MODEL provenance", async () => {
    const transcriber = new StubTranscriber("Transcribed slide text.");
    const { root, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.jpg"), pngBytes());

    const ingested = await knowledge.ingest({
      title: "Slide",
      sourcePath: "slide.jpg",
    });

    expect(transcriber.calls[0]?.mediaType).toBe("image/jpeg");
    expect(ingested.source.extraction.model).toBe(CHEAPEST_VISION_MODEL);
  });

  it("leaves no raw copy or derived text when transcription fails", async () => {
    const transcriber = new StubTranscriber(new MetisError(
      "EXTRACT_VISION_RATE_LIMITED",
      "rate limited",
    ));
    const { root, knowledge, store } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());

    expect(await ingestCode(() => knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    }))).toBe("EXTRACT_VISION_RATE_LIMITED");
    expect(await readdir(path.join(root, "raw"))).toEqual([]);
    expect(await readdir(path.join(root, ".metis", "cache", "text-v1"))).toEqual([]);
    expect((await store.readState()).sources).toEqual([]);
  });

  it("abandons ingestion when a transcript cannot be persisted", async () => {
    const transcriber = new StubTranscriber("Chlorophyll absorbs red and blue light.");
    const { root, knowledge, store } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const cacheDirectory = path.join(root, ".metis", "cache", "text-v1");
    await chmod(cacheDirectory, 0o500);

    try {
      expect(await ingestCode(() => knowledge.ingest({
        title: "Chlorophyll Slide",
        sourcePath: "slide.png",
      }))).toBe("INGEST_COMMIT_FAILED");
      expect(await readdir(path.join(root, "raw"))).toEqual([]);
      expect((await store.readState()).sources).toEqual([]);
    } finally {
      await chmod(cacheDirectory, 0o700);
    }
  });

  it("rejects an image above the vision size limit before calling the model", async () => {
    const transcriber = new StubTranscriber("unused");
    const { root, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "huge.png"), pngBytes(6 * 1024 * 1024));

    expect(await ingestCode(() => knowledge.ingest({
      title: "Huge Slide",
      sourcePath: "huge.png",
    }))).toBe("INGEST_SOURCE_TOO_LARGE");
    expect(transcriber.calls).toEqual([]);
    expect(await readdir(path.join(root, "raw"))).toEqual([]);
  });
});

describe("batch ingestion", () => {
  it("classifies every file in a directory and commits once", async () => {
    const { root, store, knowledge } = await fixture();
    await mkdir(path.join(root, "inbox"), { recursive: true });
    await writeFile(path.join(root, "inbox", "chain-rule.md"), "The chain rule differentiates a composition.\n", "utf8");
    await writeFile(path.join(root, "inbox", "learning-rate.txt"), "The learning rate sets the step size.\n", "utf8");
    await writeFile(path.join(root, "inbox", "copy-of-chain-rule.md"), "The chain rule differentiates a composition.\n", "utf8");
    await writeFile(path.join(root, "inbox", "slides.key"), "unsupported", "utf8");
    await writeFile(path.join(root, "inbox", "broken.txt"), Buffer.from([0x48, 0x69, 0xff, 0xfe]));

    const result = await knowledge.ingestMany({ directory: "inbox" });

    expect(result.requested).toBe(4);
    expect(result.ingested).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    const status = Object.fromEntries(result.items.map((item) =>
      [item.sourcePath, item.status]));
    expect(status["inbox/broken.txt"]).toBe("failed");
    expect(status["inbox/learning-rate.txt"]).toBe("ingested");
    // Whichever of the two identical files stages first claims the record, so
    // the pair is asserted as a pair rather than by name.
    expect([status["inbox/chain-rule.md"], status["inbox/copy-of-chain-rule.md"]].sort())
      .toEqual(["duplicate", "ingested"]);
    const failure = result.items.find((item) => item.status === "failed");
    expect(failure?.error?.code).toBe("EXTRACT_NOT_UTF8");

    const state = await store.readState();
    expect(state.sources).toHaveLength(2);
    // The title comes from the filename, so the race winner decides which of
    // the two identical files is named. Both pairings are exact and valid.
    expect([
      ["chain rule", "learning rate"],
      ["copy of chain rule", "learning rate"],
    ]).toContainEqual(state.sources.map((source) => source.title).sort());
    // One shared commit means one log entry, not one per file.
    const log = await store.readText("wiki/log.md");
    expect(log.match(/\] ingest_batch \|/g) ?? []).toHaveLength(1);
    expect(log.match(/\] ingest \|/g)).toBeNull();
  });

  it("resolves a byte-identical file in the same batch to the first record", async () => {
    const { root, store, knowledge } = await fixture();
    await mkdir(path.join(root, "dupes"), { recursive: true });
    await writeFile(path.join(root, "dupes", "a.md"), "Identical evidence.\n", "utf8");
    await writeFile(path.join(root, "dupes", "b.md"), "Identical evidence.\n", "utf8");

    const result = await knowledge.ingestMany({ directory: "dupes" });

    expect(result.ingested).toBe(1);
    expect(result.duplicates).toBe(1);
    const ingested = result.items.find((item) => item.status === "ingested");
    const duplicate = result.items.find((item) => item.status === "duplicate");
    expect(duplicate?.source?.id).toBe(ingested?.source?.id);
    expect((await store.readState()).sources).toHaveLength(1);
    const raw = await readdir(path.join(root, "raw"));
    expect(raw).toHaveLength(1);
  });

  it("never ingests Metis's own generated output when scanning the vault root", async () => {
    const { root, knowledge } = await fixture();
    await knowledge.ingest({ title: "Seed", content: "Seed evidence for the wiki.\n" });
    await writeFile(path.join(root, "fresh.md"), "Fresh evidence at the vault root.\n", "utf8");

    const result = await knowledge.ingestMany({ directory: ".", recursive: true });

    expect(result.items.map((item) => item.sourcePath)).toEqual(["fresh.md"]);
    expect(result.items.every((item) => !item.sourcePath.startsWith("raw/"))).toBe(true);
    expect(result.items.every((item) => !item.sourcePath.startsWith("wiki/"))).toBe(true);
  });

  it("scans subdirectories only when asked and honours an extension filter", async () => {
    const { root, knowledge } = await fixture();
    await mkdir(path.join(root, "deep", "nested"), { recursive: true });
    await writeFile(path.join(root, "deep", "top.md"), "Top level evidence.\n", "utf8");
    await writeFile(path.join(root, "deep", "notes.txt"), "Plain text evidence.\n", "utf8");
    await writeFile(path.join(root, "deep", "nested", "inner.md"), "Nested evidence.\n", "utf8");

    const shallow = await knowledge.ingestMany({ directory: "deep", extensions: ["md"] });
    expect(shallow.items.map((item) => item.sourcePath)).toEqual(["deep/top.md"]);

    const deep = await knowledge.ingestMany({ directory: "deep", recursive: true });
    expect(deep.items.map((item) => item.sourcePath).sort())
      .toEqual(["deep/nested/inner.md", "deep/notes.txt", "deep/top.md"]);
    // The already-ingested file resolves as a duplicate rather than a second record.
    expect(deep.items.find((item) => item.sourcePath === "deep/top.md")?.status)
      .toBe("duplicate");
  });

  it("makes every batched source immediately searchable and tagged", async () => {
    const { root, store, knowledge } = await fixture();
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "gradient-descent.md"), "Gradient descent follows the negative gradient.\n", "utf8");
    await writeFile(path.join(root, "corpus", "bayes.md"), "Bayes theorem updates a prior into a posterior.\n", "utf8");

    const result = await knowledge.ingestMany({ directory: "corpus", tags: ["batch"] });
    const bayes = result.items.find((item) => item.sourcePath.endsWith("bayes.md"));

    expect(await knowledge.search("posterior prior"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ documentId: bayes?.source?.id }),
      ]));
    const state = await store.readState();
    expect(state.sources).toHaveLength(2);
    expect(state.sources.every((source) => source.tags.includes("batch"))).toBe(true);
  });

  it("rejects malformed and oversized batch requests with distinguishable codes", async () => {
    const { root, knowledge } = await fixture();
    await mkdir(path.join(root, "empty"), { recursive: true });
    await writeFile(path.join(root, "empty", "notes.key"), "unsupported", "utf8");

    expect(await ingestCode(() => knowledge.ingestMany({})))
      .toBe("INGEST_INPUT_AMBIGUOUS");
    expect(await ingestCode(() => knowledge.ingestMany({
      sourcePaths: ["a.md"],
      directory: "empty",
    }))).toBe("INGEST_INPUT_AMBIGUOUS");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: "empty" })))
      .toBe("INGEST_BATCH_EMPTY");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: "absent" })))
      .toBe("INGEST_SOURCE_NOT_FOUND");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: "raw" })))
      .toBe("INGEST_DIRECTORY_MANAGED");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: "wiki/sources" })))
      .toBe("INGEST_DIRECTORY_MANAGED");
    expect(await ingestCode(() => knowledge.ingestMany({
      sourcePaths: ["wiki/concepts/chain-rule.md"],
    }))).toBe("INGEST_SOURCE_MANAGED");
    expect(await ingestCode(() => knowledge.ingestMany({
      sourcePaths: ["good.md", "raw/src-1-notes.md"],
    }))).toBe("INGEST_SOURCE_MANAGED");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: "empty/notes.key" })))
      .toBe("INGEST_SOURCE_NOT_A_DIRECTORY");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: ".." })))
      .toBe("INGEST_PATH_OUTSIDE_VAULT");
    expect(await ingestCode(() => knowledge.ingestMany({ directory: "/etc" })))
      .toBe("INGEST_PATH_OUTSIDE_VAULT");
    expect(await ingestCode(() => knowledge.ingestMany({
      sourcePaths: Array.from({ length: 201 }, (_, index) => `note-${index}.md`),
    }))).toBe("INGEST_BATCH_TOO_LARGE");
  });

  it("reports a per-path failure without disturbing the rest of the list", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(path.join(root, "good.md"), "Good evidence.\n", "utf8");
    await writeFile(path.join(root, "report.docx"), "unsupported", "utf8");

    const result = await knowledge.ingestMany({
      sourcePaths: ["good.md", "report.docx", "missing.md", "good.md"],
    });

    expect(result.requested).toBe(3);
    expect(result.ingested).toBe(1);
    expect(result.failed).toBe(2);
    expect(Object.fromEntries(result.items.map((item) =>
      [item.sourcePath, item.error?.code ?? item.status])))
      .toEqual({
        "good.md": "ingested",
        "report.docx": "INGEST_UNSUPPORTED_TYPE",
        "missing.md": "INGEST_SOURCE_NOT_FOUND",
      });
    // A failed item leaves no read-only orphan behind.
    expect(await readdir(path.join(root, "raw"))).toHaveLength(1);
  });

  it("keeps a committed batch when indexing one item afterwards fails", async () => {
    const { root, store, knowledge } = await fixture();
    await writeFile(path.join(root, "seed.md"), "Seed evidence for the batch.\n", "utf8");
    await knowledge.ingest({ title: "Seed", sourcePath: "seed.md" });
    // Corrupt the committed raw copy, so re-reading the duplicate's text after
    // the commit fails integrity verification.
    const [rawName] = await readdir(path.join(root, "raw"));
    const rawCopy = path.join(root, "raw", rawName ?? "");
    await chmod(rawCopy, 0o600);
    await writeFile(rawCopy, "Tampered evidence.\n", "utf8");
    await writeFile(path.join(root, "fresh.md"), "Fresh evidence for the batch.\n", "utf8");
    // A cold service, so the duplicate's text comes off disk rather than cache.
    const cold = new KnowledgeService(store);

    const result = await cold.ingestMany({ sourcePaths: ["seed.md", "fresh.md"] });

    expect(result.ingested).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.items.find((item) => item.status === "duplicate")?.error?.code)
      .toBe("SOURCE_INTEGRITY_FAILED");
    // The commit stands: the failure is reported on its item, not as a failed call.
    const state = await store.readState();
    expect(state.sources).toHaveLength(2);
    expect(state.sources.map((source) => source.title)).toContain("fresh");
  });

  it("leaves no staged copy behind when the shared commit fails", async () => {
    const { root, store, knowledge } = await fixture();
    await mkdir(path.join(root, "batch"), { recursive: true });
    await writeFile(path.join(root, "batch", "one.md"), "First evidence.\n", "utf8");
    await writeFile(path.join(root, "batch", "two.md"), "Second evidence.\n", "utf8");
    const failing = new Error("commit rejected");
    store.mutateManaged = async () => {
      throw failing;
    };

    expect(await ingestCode(() => knowledge.ingestMany({ directory: "batch" })))
      .toBe("INGEST_COMMIT_FAILED");
    expect(await readdir(path.join(root, "raw"))).toHaveLength(0);
    expect(await readdir(path.join(root, ".metis", "cache", "text-v1"))).toHaveLength(0);
  });
});

describe("ingestion error codes", () => {
  it("rejects malformed requests with distinguishable codes", async () => {
    const { knowledge } = await fixture();

    expect(await ingestCode(() => knowledge.ingest({ title: "  ", content: "x" })))
      .toBe("INGEST_TITLE_EMPTY");
    expect(await ingestCode(() => knowledge.ingest({ title: "Both", content: "x", sourcePath: "a.md" })))
      .toBe("INGEST_INPUT_AMBIGUOUS");
    expect(await ingestCode(() => knowledge.ingest({ title: "Neither" })))
      .toBe("INGEST_INPUT_AMBIGUOUS");
    expect(await ingestCode(() => knowledge.ingest({ title: "Blank", content: "   \n  " })))
      .toBe("INGEST_CONTENT_EMPTY");
  });

  it("distinguishes unsupported, missing, and non-file inputs", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(path.join(root, "report.docx"), "binary-ish", "utf8");
    await mkdir(path.join(root, "notes-folder.md"), { recursive: true });

    expect(await ingestCode(() => knowledge.ingest({
      title: "Word Report",
      sourcePath: "report.docx",
    }))).toBe("INGEST_UNSUPPORTED_TYPE");
    expect(await ingestCode(() => knowledge.ingest({
      title: "Absent",
      sourcePath: "missing.md",
    }))).toBe("INGEST_SOURCE_NOT_FOUND");
    expect(await ingestCode(() => knowledge.ingest({
      title: "Directory",
      sourcePath: "notes-folder.md",
    }))).toBe("INGEST_SOURCE_NOT_A_FILE");
  });

  it.skipIf(process.platform === "win32")(
    "codes a vault escape distinctly from a missing file",
    async () => {
      const { root, knowledge } = await fixture();
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), "metis-ingest-external-"));
      temporaryDirectories.push(externalRoot);
      await writeFile(path.join(externalRoot, "outside.md"), "Outside the vault.", "utf8");
      await symlink(path.join(externalRoot, "outside.md"), path.join(root, "linked.md"));

      expect(await ingestCode(() => knowledge.ingest({
        title: "Escaped",
        sourcePath: "linked.md",
      }))).toBe("INGEST_PATH_OUTSIDE_VAULT");
    },
  );

  it("refuses non-UTF-8 and textless sources without storing them", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(path.join(root, "latin.txt"), Buffer.from([0x48, 0x69, 0xff, 0xfe]));
    await writeFile(path.join(root, "blank.txt"), "\n   \n\t\n", "utf8");

    expect(await ingestCode(() => knowledge.ingest({
      title: "Latin Bytes",
      sourcePath: "latin.txt",
    }))).toBe("EXTRACT_NOT_UTF8");
    expect(await ingestCode(() => knowledge.ingest({
      title: "Blank Notes",
      sourcePath: "blank.txt",
    }))).toBe("EXTRACT_EMPTY_TEXT");
    expect(await readdir(path.join(root, "raw"))).toEqual([]);
  });

  it("accepts a UTF-8 byte-order mark and strips it from evidence", async () => {
    const { root, knowledge } = await fixture();
    await writeFile(
      path.join(root, "bom.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("Photosynthesis stores energy in glucose.", "utf8"),
      ]),
    );

    const ingested = await knowledge.ingest({
      title: "BOM Notes",
      sourcePath: "bom.txt",
    });

    const text = await knowledge.readSourceText(ingested.source);
    expect(text.startsWith("Photosynthesis")).toBe(true);
  });

  it("marks transient failures as retryable and permanent ones as final", () => {
    expect(new MetisError("EXTRACT_VISION_RATE_LIMITED", "x").retryable).toBe(true);
    expect(new MetisError("INGEST_UNSUPPORTED_TYPE", "x").retryable).toBe(false);
  });
});

interface CapturedRequest {
  url?: string;
  apiKey: boolean;
  body: Record<string, unknown>;
}

/**
 * Drive the real Anthropic SDK against a local stub so the request shape, model
 * choice, and response handling are all exercised without network access.
 */
async function withStubApi<T>(
  reply: { status: number; payload: unknown },
  run: (captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      captured.push({
        url: request.url,
        apiKey: Boolean(request.headers["x-api-key"]),
        body: JSON.parse(body || "{}") as Record<string, unknown>,
      });
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const previous = {
    key: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    return await run(captured);
  } finally {
    process.env.ANTHROPIC_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous.baseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function stubMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: CHEAPEST_VISION_MODEL,
    content: [{ type: "text", text: "Chlorophyll absorbs red and blue light." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8 },
    ...overrides,
  };
}

describe("Claude vision request", () => {
  it("posts a base64 image to the cheapest model and stores the transcript", async () => {
    await withStubApi(
      { status: 200, payload: stubMessage() },
      async (captured) => {
        const { root, knowledge } = await fixture(new AnthropicVisionTranscriber());
        await writeFile(path.join(root, "slide.png"), pngBytes());
        const ingested = await knowledge.ingest({
          title: "Chlorophyll Slide",
          sourcePath: "slide.png",
        });

        expect(captured).toHaveLength(1);
        expect(captured[0]?.url).toBe("/v1/messages");
        expect(captured[0]?.apiKey).toBe(true);
        const body = captured[0]!.body as {
          model: string;
          max_tokens: number;
          system: string;
          messages: Array<{ content: Array<Record<string, unknown>> }>;
        };
        expect(body.model).toBe(CHEAPEST_VISION_MODEL);
        expect(body.max_tokens).toBe(16_000);
        expect(body.system).toContain("transcribe");
        expect(body.messages[0]?.content[0]).toEqual({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: pngBytes().toString("base64"),
          },
        });
        expect(ingested.source.extraction).toEqual(expect.objectContaining({
          method: "vision",
          model: CHEAPEST_VISION_MODEL,
        }));
        expect(await knowledge.readSourceText(ingested.source))
          .toBe("Chlorophyll absorbs red and blue light.");
      },
    );
  });

  it("refuses to store a partial transcript when the model runs out of output", async () => {
    await withStubApi(
      { status: 200, payload: stubMessage({ stop_reason: "max_tokens" }) },
      async () => {
        const { root, knowledge } = await fixture(new AnthropicVisionTranscriber());
        await writeFile(path.join(root, "slide.png"), pngBytes());
        expect(await ingestCode(() => knowledge.ingest({
          title: "Long Slide",
          sourcePath: "slide.png",
        }))).toBe("EXTRACT_VISION_TRUNCATED");
        expect(await readdir(path.join(root, "raw"))).toEqual([]);
      },
    );
  });

  it("codes a model refusal separately from a request failure", async () => {
    await withStubApi(
      {
        status: 200,
        payload: stubMessage({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
        }),
      },
      async () => {
        const { root, knowledge } = await fixture(new AnthropicVisionTranscriber());
        await writeFile(path.join(root, "slide.png"), pngBytes());
        expect(await ingestCode(() => knowledge.ingest({
          title: "Refused Slide",
          sourcePath: "slide.png",
        }))).toBe("EXTRACT_VISION_REFUSED");
      },
    );
  });

  it("marks a rate-limited transcription as retryable", async () => {
    await withStubApi(
      {
        status: 429,
        payload: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      },
      async () => {
        const { root, store } = await fixture();
        const knowledge = new KnowledgeService(
          store,
          new AnthropicVisionTranscriber(),
        );
        await writeFile(path.join(root, "slide.png"), pngBytes());
        let raised: MetisError | undefined;
        try {
          await knowledge.ingest({ title: "Busy Slide", sourcePath: "slide.png" });
        } catch (error) {
          raised = error as MetisError;
        }
        expect(raised?.code).toBe("EXTRACT_VISION_RATE_LIMITED");
        expect(raised?.retryable).toBe(true);
        expect(await readdir(path.join(root, "raw"))).toEqual([]);
      },
    );
  }, 20_000);
});

describe("ingestion over MCP", () => {
  it("returns a coded error result instead of an opaque protocol failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "metis-ingest-mcp-"));
    temporaryDirectories.push(root);
    const transcriber = new StubTranscriber("Slide text from the cheapest model.");
    const { server } = await createStudyServer(root, { vision: transcriber });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      await writeFile(path.join(root, "report.docx"), "unsupported", "utf8");
      const failure = await client.callTool({
        name: "ingest_source",
        arguments: { title: "Word Report", sourcePath: "report.docx" },
      });
      expect(failure.isError).toBe(true);
      const payload = JSON.parse(
        (failure.content as Array<{ text: string }>)[0]!.text,
      ) as { error: { code: string; retryable: boolean; message: string } };
      expect(payload.error).toEqual(expect.objectContaining({
        code: "INGEST_UNSUPPORTED_TYPE",
        retryable: false,
      }));
      expect(payload.error.message).toContain(".png");

      await writeFile(path.join(root, "slide.png"), pngBytes());
      const success = await client.callTool({
        name: "ingest_source",
        arguments: { title: "Slide", sourcePath: "slide.png" },
      });
      expect(success.isError).not.toBe(true);
      const stored = JSON.parse(
        (success.content as Array<{ text: string }>)[0]!.text,
      ) as { source: { kind: string; extraction: { method: string; model: string } } };
      expect(stored.source.kind).toBe("image");
      expect(stored.source.extraction).toEqual(expect.objectContaining({
        method: "vision",
        model: CHEAPEST_VISION_MODEL,
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports a mixed batch as one result with per-item outcomes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "metis-batch-mcp-"));
    temporaryDirectories.push(root);
    const { server } = await createStudyServer(root);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      await mkdir(path.join(root, "inbox"), { recursive: true });
      await writeFile(path.join(root, "inbox", "chain-rule.md"), "The chain rule differentiates a composition.\n", "utf8");
      await writeFile(path.join(root, "inbox", "broken.txt"), Buffer.from([0x48, 0x69, 0xff, 0xfe]));
      await writeFile(path.join(root, "inbox", "deck.key"), "unsupported", "utf8");

      const result = await client.callTool({
        name: "ingest_sources",
        arguments: { directory: "inbox", tags: ["inbox"] },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      ) as {
        ingested: number;
        failed: number;
        skipped: number;
        items: Array<{
          sourcePath: string;
          status: string;
          source?: { id: string };
          error?: { code: string; retryable: boolean };
        }>;
      };
      expect(payload).toEqual(expect.objectContaining({
        requested: 2,
        ingested: 1,
        duplicates: 0,
        failed: 1,
        skipped: 1,
      }));
      expect(payload.items.find((item) => item.sourcePath === "inbox/chain-rule.md"))
        .toEqual(expect.objectContaining({ status: "ingested" }));
      expect(payload.items.find((item) => item.sourcePath === "inbox/broken.txt")?.error)
        .toEqual(expect.objectContaining({
          code: "EXTRACT_NOT_UTF8",
          retryable: false,
        }));

      const empty = await client.callTool({
        name: "ingest_sources",
        arguments: { sourcePaths: ["inbox/chain-rule.md"], directory: "inbox" },
      });
      expect(empty.isError).toBe(true);
      expect(JSON.parse((empty.content as Array<{ text: string }>)[0]!.text))
        .toEqual({
          error: expect.objectContaining({ code: "INGEST_INPUT_AMBIGUOUS" }),
        });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("derived text integrity", () => {
  it("refuses to re-transcribe an image whose stored transcript is gone", async () => {
    const transcriber = new StubTranscriber("Absorption peaks near 430 nm.");
    const { root, store, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const ingested = await knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    });
    expect(transcriber.calls).toHaveLength(1);

    await rm(path.join(
      root,
      ".metis",
      "cache",
      "text-v1",
      `${ingested.source.checksum}.json`,
    ));

    // A second transcription would move every line citation into this source,
    // so the read fails instead of quietly answering from different text.
    const reopened = new KnowledgeService(store, transcriber);
    expect(await ingestCode(() => reopened.readSourceText(ingested.source)))
      .toBe("DERIVED_TEXT_UNRECOVERABLE");
    expect(transcriber.calls).toHaveLength(1);
  });

  it("rejects a transcript that no longer matches its own checksum", async () => {
    const transcriber = new StubTranscriber("Absorption peaks near 430 nm.");
    const { root, store, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const ingested = await knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    });
    const cachePath = path.join(
      root,
      ".metis",
      "cache",
      "text-v1",
      `${ingested.source.checksum}.json`,
    );
    const entry = JSON.parse(await readFile(cachePath, "utf8")) as
      Record<string, unknown>;
    entry.text = "Absorption peaks near 700 nm.";
    await writeFile(cachePath, `${JSON.stringify(entry)}\n`, "utf8");

    const reopened = new KnowledgeService(store, transcriber);
    expect(await ingestCode(() => reopened.readSourceText(ingested.source)))
      .toBe("DERIVED_TEXT_UNRECOVERABLE");
    expect(transcriber.calls).toHaveLength(1);
  });

  it("accepts a pre-checksum transcript so an existing vault keeps its citations", async () => {
    const transcriber = new StubTranscriber("Absorption peaks near 430 nm.");
    const { root, store, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const ingested = await knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    });
    const cachePath = path.join(
      root,
      ".metis",
      "cache",
      "text-v1",
      `${ingested.source.checksum}.json`,
    );
    const entry = JSON.parse(await readFile(cachePath, "utf8")) as
      Record<string, unknown>;
    delete entry.textChecksum;
    entry.formatVersion = 1;
    await writeFile(cachePath, `${JSON.stringify(entry)}\n`, "utf8");

    const reopened = new KnowledgeService(store, transcriber);
    await expect(reopened.readSourceText(ingested.source))
      .resolves.toContain("430 nm");

    // Repair is the boundary that adds the missing checksum.
    const repaired = await new KnowledgeService(store, transcriber)
      .repairKnowledge({});
    expect(repaired.derivedText).toEqual(expect.objectContaining({
      expected: 1,
      upgraded: 1,
      missingSourceIds: [],
    }));
    const upgraded = JSON.parse(await readFile(cachePath, "utf8")) as
      Record<string, unknown>;
    expect(upgraded.formatVersion).toBe(2);
    expect(upgraded.textChecksum).toBe(sha256(String(upgraded.text)));
    expect(transcriber.calls).toHaveLength(1);
  });

  it("recovers a PDF derivation from the raw bytes and re-persists it", async () => {
    const { root, store, knowledge } = await fixture();
    await writeFile(
      path.join(root, "paper.pdf"),
      pdfBytes("Photosynthesis converts light energy into chemical energy."),
    );
    const ingested = await knowledge.ingest({
      title: "Photosynthesis Paper",
      sourcePath: "paper.pdf",
    });
    const cachePath = path.join(
      root,
      ".metis",
      "cache",
      "text-v1",
      `${ingested.source.checksum}.json`,
    );
    await rm(cachePath);

    // Unlike a transcript, PDF text is a function of the checksum-verified
    // bytes, so it is recoverable rather than lost.
    const reopened = new KnowledgeService(store);
    await expect(reopened.readSourceText(ingested.source))
      .resolves.toContain("chemical energy");
    const rewritten = JSON.parse(await readFile(cachePath, "utf8")) as
      Record<string, unknown>;
    expect(rewritten.formatVersion).toBe(2);
    expect(rewritten.textChecksum).toBe(sha256(String(rewritten.text)));
  });

  it("reports a missing transcript instead of counting it as retained", async () => {
    const transcriber = new StubTranscriber("Absorption peaks near 430 nm.");
    const { root, store, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const ingested = await knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    });
    await rm(path.join(
      root,
      ".metis",
      "cache",
      "text-v1",
      `${ingested.source.checksum}.json`,
    ));

    const repaired = await new KnowledgeService(store, transcriber)
      .repairKnowledge({});
    expect(repaired.derivedText).toEqual(expect.objectContaining({
      expected: 1,
      verified: 0,
      missingSourceIds: [ingested.source.id],
    }));
  });

  it("backs up a transcript and restores it after the cache is lost", async () => {
    const transcriber = new StubTranscriber("Absorption peaks near 430 nm.");
    const { root, store, knowledge } = await fixture(transcriber);
    await writeFile(path.join(root, "slide.png"), pngBytes());
    const ingested = await knowledge.ingest({
      title: "Chlorophyll Slide",
      sourcePath: "slide.png",
    });
    const cacheRelative = path.join(
      ".metis",
      "cache",
      "text-v1",
      `${ingested.source.checksum}.json`,
    );

    const update = await store.updateVault();
    const backup = update.backupRelativePath!;
    await expect(readFile(
      path.join(root, backup, cacheRelative),
      "utf8",
    )).resolves.toContain("430 nm");

    await rm(path.join(root, cacheRelative));
    const restored = await store.restoreVaultBackup(backup);
    expect(restored.restored).toBe(true);

    const reopened = new KnowledgeService(store, transcriber);
    await expect(reopened.readSourceText(ingested.source))
      .resolves.toContain("430 nm");
    expect(transcriber.calls).toHaveLength(1);
  });
});
