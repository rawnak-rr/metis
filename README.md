# Metis

Metis is a local-first grounding kernel that gives any MCP-capable assistant a persistent, source-grounded knowledge workspace. It combines an LLM-maintained Obsidian wiki, retrieval over immutable raw evidence, and bounded evidence packets that keep a long session inside its context budget.

The design follows the compounding-wiki pattern: raw sources remain immutable, while the assistant continuously integrates what they mean into an interlinked wiki. You keep control of sources and judgment; the assistant handles synthesis, cross-references, and retrieval.

Metis deliberately does one thing: ingest material, index it, route to the right concept, and return verified evidence for as few tokens as possible. Higher-level workflows — research, testing, study scheduling — belong in tools built on top of it, not in the kernel.

## What works

- Ingest Markdown, plain text, PDF, LaTeX, CSV, TSV, JSON, or YAML from inside a vault, or send text directly.
- Ingest a whole directory or file list in one call, with per-file outcomes and a single state commit.
- Preserve a read-only raw copy with SHA-256 provenance, duplicate detection, and integrity verification on every read.
- Checksum derived PDF and image text as well as the raw bytes, and refuse to re-transcribe an image whose transcript is gone rather than moving its citations.
- Build and persist a disposable checksum-keyed BM25 index during ingestion, then update it incrementally instead of rechunking and retokenizing unchanged sources for every query.
- Compile concept pages whose factual prose has validated inline raw-source citations into an Obsidian-compatible wiki.
- Resolve one compact wiki concept capsule by title, slug, alias, or tag by default; retrieve bounded checksum-verified raw excerpts only when evidence is needed.
- Read the exact lines a citation token names, independently of retrieval, so a token can be carried in place of the excerpt and the excerpt read back later.
- Prepare answers in `sources_only`, `sources_first`, or `open` grounding modes with per-facet evidence sufficiency.
- Visualize a bounded global graph or one concept neighborhood with its supporting sources.
- Lint wiki provenance, links, orphans, and staleness.
- Expose tools, resources, and reusable prompts over MCP stdio.

## Requirements

- Node.js 20 or newer
- `pdftotext` and `pdftoppm` from Poppler for PDF ingestion
- An MCP client that supports sampling, so it can transcribe images and image-only PDF pages with its own model. `@anthropic-ai/sdk` and Claude API credentials are only needed as a fallback for a client that never advertises sampling.

On macOS with Homebrew:

```sh
brew install node poppler
```

Equivalent system packages work on Linux and Windows.

## Install and build

```sh
git clone <this-repository>
cd metis
npm install
npm run build
npm test
```

The server uses the current directory as the study vault unless `METIS_VAULT_PATH` is set. Point that variable at an existing Obsidian vault to keep the generated wiki beside your notes:

```sh
METIS_VAULT_PATH="/absolute/path/to/Obsidian Vault" npm start
```

The process speaks MCP over standard input/output, so it will wait quietly for an MCP client rather than display an interactive terminal.

## Connect an MCP client

Use the following shape in clients that accept an MCP JSON configuration. Replace both paths with absolute paths:

```json
{
  "mcpServers": {
    "metis": {
      "command": "node",
      "args": ["/absolute/path/to/metis/dist/src/cli/index.js"],
      "env": {
        "METIS_VAULT_PATH": "/absolute/path/to/Obsidian Vault"
      }
    }
  }
}
```

For a friend, share the repository, have them install the four requirements, and change only `METIS_VAULT_PATH`. Their sources, wiki, review history, and goals stay in their own vault.

## First workflow

1. Connect Metis and ask the assistant to call `configure_study_vault`.
2. Put source files anywhere inside the vault and call `ingest_source` with a vault-relative path, or pass direct text. See [Ingestion](#ingestion) for the supported formats and their failure codes.
3. Ask the assistant to synthesize the source into one or more concept pages with `upsert_wiki_page`. Every factual prose block must include an inline raw-source citation such as `[src_ab12#L8-L14]`.
4. Ask a question. The assistant should call `prepare_grounded_answer` before responding.
5. Call `get_knowledge_graph` globally or with a `focusId` to inspect a bounded neighborhood.
6. Run `lint_wiki` after major ingests to keep the knowledge base connected and trustworthy.
7. In a long session, keep citation tokens rather than excerpt text and call `resolve_citations` to read a passage back when it is needed again.

For strict closed-book behavior, choose `sources_only`. The normal `sources_first` mode uses the vault whenever it can and permits outside knowledge only when the returned evidence packet identifies a gap. Outside additions must be labelled.

## Ingestion

`ingest_source` stores an immutable read-only copy under `raw/`, derives searchable text from it, and records how that text was derived. Nothing is committed until the text is in hand: a failed extraction leaves no source record, no raw copy, and no derived files behind.

| Extension | Kind | Text extraction |
| --- | --- | --- |
| `.md`, `.markdown` | `markdown` | Body kept verbatim; YAML frontmatter blanked |
| `.txt`, `.text` | `text` | Verbatim |
| `.csv`, `.tsv`, `.json`, `.yaml`, `.yml` | `data` | Verbatim |
| `.tex` | `latex` | Comments, preamble, environment markers, and bookkeeping macros blanked; sectioning commands become Markdown headings |
| `.pdf` | `pdf` | Poppler `pdftotext -layout`; page-by-page vision transcription if the PDF has no text layer |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | `image` | Transcribed by the connected client's own model |

Text extraction never changes a line's number, so a citation such as `[src_ab12#L8-L14]` addresses the same lines in the extracted text and in the raw file you can open in Obsidian.

An image, or a PDF page with no text layer (a slide deck exported straight to page images, most commonly), is transcribed by asking the connected MCP client to run its own vision-capable model over it through sampling — Metis holds no model or API key of its own for this by default, and the client picks whichever model it wants (typically its cheapest one, since transcription is high volume and needs no reasoning). A client that never advertises sampling falls back to a configured `VisionTranscriber` if one was set up (`AnthropicVisionTranscriber` by default for a standalone/embedded kernel, honoring `METIS_VISION_MODEL` and Anthropic credentials resolved via `ANTHROPIC_API_KEY` or an `ant auth login` profile); with neither sampling nor a fallback, image extraction fails with `EXTRACT_VISION_UNAVAILABLE`. A PDF that falls back to vision is capped at 150 pages per ingest (`EXTRACT_PDF_TOO_MANY_PAGES` above that) and needs `pdftoppm` on `PATH` to render its pages. Because a transcript cannot be re-derived byte-for-byte, it is persisted under `.metis/cache/text-v1/` and reused for every later read and duplicate ingestion, so nothing is transcribed twice and its line citations stay stable. PDF text extracted with `pdftotext` is cached the same way. Every source record carries its extraction method (`pdftotext`, `pdf-vision`, or `vision`), media type, and transcribing model, and the generated provenance page shows them, so model-transcribed evidence is never mistaken for verbatim text.

Text sources must be valid UTF-8; a byte-order mark is accepted and stripped. Text and PDF sources are capped at 32 MiB, images at 5 MiB.

A failed ingestion returns a stable `error.code` plus `error.retryable`, so callers branch on the code rather than on message text:

| Code | Meaning |
| --- | --- |
| `INGEST_TITLE_EMPTY` | Title was blank |
| `INGEST_INPUT_AMBIGUOUS` | Neither or both of `content` and `sourcePath` were given |
| `INGEST_CONTENT_EMPTY` | Inline content had no text |
| `INGEST_UNSUPPORTED_TYPE` | Extension is not in the table above |
| `INGEST_SOURCE_NOT_FOUND` | No file at that vault-relative path |
| `INGEST_SOURCE_NOT_A_FILE` | Path is a directory or special file |
| `INGEST_PATH_OUTSIDE_VAULT` | Path or symlink resolves outside the vault |
| `INGEST_SOURCE_TOO_LARGE` | Above the size cap for that kind |
| `EXTRACT_NOT_UTF8` | Bytes are binary or another encoding |
| `EXTRACT_EMPTY_TEXT` | Extraction produced no citable text |
| `EXTRACT_PDF_TOOL_MISSING` | `pdftotext` is not on `PATH` |
| `EXTRACT_PDF_FAILED` | PDF is encrypted or damaged |
| `EXTRACT_PDF_RENDER_TOOL_MISSING` | `pdftoppm` is not on `PATH`, needed to render an image-only PDF's pages |
| `EXTRACT_PDF_RENDER_FAILED` | Rendering an image-only PDF's pages failed |
| `EXTRACT_PDF_TOO_MANY_PAGES` | An image-only PDF has more than 150 pages; split it |
| `EXTRACT_VISION_UNAVAILABLE` | No connected client advertises sampling, and no fallback transcriber is configured |
| `EXTRACT_VISION_NOT_CONFIGURED` | The fallback's Claude credentials are missing or rejected |
| `EXTRACT_VISION_RATE_LIMITED` | Retryable; the model is rate limited |
| `EXTRACT_VISION_REFUSED` | The model declined to transcribe the image, or returned no transcript |
| `EXTRACT_VISION_TRUNCATED` | Transcript hit the output limit; split the image |
| `EXTRACT_VISION_FAILED` | Retryable; the transcription request failed |
| `INGEST_COPY_VERIFICATION_FAILED` | Stored copy did not match the input checksum |
| `INGEST_COMMIT_FAILED` | Retryable; the managed transaction did not commit |
| `SOURCE_INTEGRITY_FAILED` | A stored raw copy no longer matches its checksum |

## Vault layout

```text
Obsidian Vault/
├── raw/                       immutable ingested source copies
├── wiki/
│   ├── concepts/              compiled, interlinked explanations
│   ├── sources/               provenance pages
│   ├── index.md               navigable content catalog
│   ├── log.md                 append-only operation history
│   └── SCHEMA.md              rules for maintaining the wiki
└── .metis/
    ├── cache/search-v1/       disposable checksum-keyed search indexes
    ├── cache/text-v1/         PDF and image text derived once per checksum
    ├── cache/packets-v1/      evidence packet citation manifests
    ├── config.json            local configuration
    └── state.json             sources, wiki pages, and concept manifests
```

The Markdown layer is readable without Metis and works with Obsidian graph view, backlinks, tags, and version control. Machine state is plain JSON so it is portable and inspectable.

## Grounding contract

`prepare_grounded_answer` does not pretend retrieval alone is a finished answer. It returns:

- one or two keyed concept capsules for routing;
- a small set of ranked excerpts from checksum-verified immutable raw sources;
- exact line-span citation tokens;
- a conservative overall coverage judgment plus compact `supported`, `partially_supported`, `unsupported`, or `conflicting` facets;
- compact warnings for independent sources, possible numeric conflicts, or instruction-like source text.

Overall coverage is `sufficient` only when every required facet is supported. A conflict therefore remains partial rather than being mistaken for extra corroboration. Facet statuses and their citations come from token coverage by default, which routes conservatively but cannot tell a passage that answers a facet from one that repeats its wording; when the connected client advertises sampling, its model judges the packet's passages instead and the facet reports `statusMethod: "entailment"`. Either way the citations point to retained raw excerpts, and a passage neither method confirmed stays visible under `borderlineCitations` and `lexicalSupport: "related"` rather than being dropped from the packet. Callers may pass up to five short self-contained `facets` for a complex question; otherwise Metis conservatively decomposes obvious multi-clause questions.

Static behavior lives once in the MCP server instructions rather than being repeated in every answer packet. JSON tools also emit one model-facing payload rather than duplicating the same object as both text and structured content.

Every grounded-answer packet includes a short `packetId`. For an immediate related follow-up that remains in the same model context, pass it back as `priorPacketId`; Metis re-runs indexed retrieval and raw checksum verification, references citations already present in the earlier packet through `reusedEvidence`, and returns only new evidence. Packet manifests are written to `.metis/cache/packets-v1/`, so a reconnect or a restarted server can still reuse one. A manifest holds the grounding mode and the citations already shown, never the excerpt bodies, because a token plus a verified source rehydrates the text. Unknown or expired packet IDs fail open to a complete fresh evidence packet.

`resolve_citations` reads back the exact lines a citation token names. It is deterministic and does not run the ranker, so a token resolves to the same text however much has been ingested since, which is what makes a citation usable in place of the excerpt when context is tight. Every resolution re-verifies the raw source checksum, and an unusable token is reported next to the excerpts that did resolve.

`search_knowledge` defaults to server-side keyed wiki routing and normally returns one bounded capsule. Use `scope: "sources"` for raw excerpts or `scope: "all"` when both are explicitly useful. Normal wiki and source resources return compact capsules or provenance descriptors; complete generated wiki Markdown is available only through `study://maintenance/wiki/{slug}`. Wiki synthesis is never authoritative evidence for `prepare_grounded_answer`.

On wiki writes, Metis verifies that citation source IDs and line ranges exist, requires inline citation coverage for factual prose, and requires at least half of each block's distinctive terms to occur in its cited excerpts. `lint_wiki` additionally reports unsupported sentence-sized claims as info findings. The sentence check is read-only while its threshold is calibrated. These mechanical checks catch missing, out-of-range, and unrelated citations; they are not substitutes for semantic or human review.

For long sessions, dashboards expose bounded summaries plus totals, and graph and lint results paginate or truncate explicitly. A fresh client can route to the right concept and reload verified evidence without replaying the transcript.

## Development

```sh
npm run typecheck
npm test
npm run build
```

The test suite covers the immutable source and wiki flow, grounded retrieval, citation validation and resolution, derived-text integrity, packet reuse across a restart, link linting, and an in-memory MCP client/server exchange.

## Current boundaries

- Retrieval is local BM25-style lexical search behind a direct keyed concept map and checksum-keyed incremental inverted index. Lexical matching is the kernel's weakest layer and the current focus of work. Derived per-source indexes are disposable and carry a derivation fingerprint, so a changed parser, chunker, or tokenizer rebuilds them automatically; selected line spans are rehydrated only after the raw source checksum is verified. An optional embedding or hybrid reranker can be added without changing the vault format.
- PDF ingestion extracts embedded text with `pdftotext`; a PDF whose pages carry no text layer falls back to rendering each page and transcribing it, capped at 150 pages per ingest.
- Image and image-only-PDF transcription is a model output, not a verbatim reading, and by default it is the connected client's own model rather than one Metis holds credentials for. It is labelled as such on every source record and provenance page, but a transcript can still misread handwriting or dense notation. Its cache entry under `.metis/cache/text-v1/` is the only copy, so back that directory up yourself; if it is lost, reads fail with `DERIVED_TEXT_UNRECOVERABLE` rather than re-transcribing, because a second transcript would move every line citation into that source.
- Ingestion is structure-blind: `.csv`, `.json`, and `.yaml` sources are chunked as prose, and a LaTeX `verbatim` environment has its `%` characters treated as comments.
- The connected LLM performs explanation and wiki synthesis. Metis provides compact evidence packets, persistent state, and one-time server policy rather than embedding a specific model vendor.
- Local state/log writes are serialized and cross-process locked; ingestion and wiki compilation also roll back generated files when their managed transaction fails. A future shared HTTP deployment still needs transactional multi-user storage and authentication.

## License

MIT
