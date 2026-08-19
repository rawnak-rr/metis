# Metis

Metis is a local-first grounding kernel that gives any MCP-capable assistant a persistent, source-grounded knowledge workspace. It combines an LLM-maintained Obsidian wiki, retrieval over immutable raw evidence, and bounded evidence packets that keep a long session inside its context budget.

The design follows the compounding-wiki pattern: raw sources remain immutable, while the assistant continuously integrates what they mean into an interlinked wiki. You keep control of sources and judgment; the assistant handles synthesis, cross-references, and retrieval.

Metis deliberately does one thing: ingest material, index it, route to the right concept, and return verified evidence for as few tokens as possible. Higher-level workflows — research, testing, study scheduling — belong in tools built on top of it, not in the kernel.

## What works

- Ingest Markdown, plain text, PDF, LaTeX, CSV, TSV, JSON, or YAML from inside a vault, or send text directly.
- Preserve a read-only raw copy with SHA-256 provenance, duplicate detection, and integrity verification on every read.
- Build and persist a disposable checksum-keyed BM25 index during ingestion, then update it incrementally instead of rechunking and retokenizing unchanged sources for every query.
- Compile concept pages whose factual prose has validated inline raw-source citations into an Obsidian-compatible wiki.
- Resolve one compact wiki concept capsule by title, slug, alias, or tag by default; retrieve bounded checksum-verified raw excerpts only when evidence is needed.
- Prepare answers in `sources_only`, `sources_first`, or `open` grounding modes with per-facet evidence sufficiency.
- Visualize a bounded global graph or one concept neighborhood with its supporting sources.
- Lint wiki provenance, links, orphans, and staleness.
- Migrate and repair an entire vault, refresh portable agent skills, and incrementally rebuild derived knowledge from verified raw evidence.
- Expose tools, resources, and reusable prompts over MCP stdio.

## Requirements

- Node.js 20 or newer
- `pdftotext` from Poppler for PDF ingestion

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

## Repairing or updating a vault

Keep the Metis application and study vault in separate directories. After updating and rebuilding the application, repair the existing vault directly:

```sh
npm run repair -- --vault "/absolute/path/to/Obsidian Vault"
# Installed package:
metis repair --vault "/absolute/path/to/Obsidian Vault"
```

With an MCP client, reconnect to the latest build and tell the connected LLM:

> Metis repair

The server instruction maps that request to `metis_repair`. The command and MCP tool use the same workflow: refuse newer-schema downgrades, create a checksummed timestamped backup under `.metis/backups/`, run every migration in order, reconcile safe state references, repair generated source pages and concept frontmatter, remove untracked files from the Metis-managed `wiki/concepts/` and `wiki/sources/` directories, rebuild invalid concept pages as citation-valid verbatim evidence stubs, refresh the portable Agent Skills bundle, and return bounded wiki health. Valid model-authored synthesis is preserved, and removed managed files remain recoverable from the backup.

Raw sources are checksum-verified, restored to read-only permissions when necessary, and never rewritten. A missing or modified raw source stops repair and rolls managed state and wiki files back instead of inventing evidence. Failed repairs retain a direct backup path.

Repair uses checksum-valid search indexes and rebuilds only missing or incompatible entries by default. Use `--full` on the CLI or `{"knowledgeMode":"full"}` through MCP only when every derived index should be regenerated. Use `--dry-run` or `{"dryRun":true}` to inspect planned work without creating a backup or generated skills.

`metis update` remains a CLI alias for compatibility; the MCP boundary is the single `metis_repair` tool so discovery does not carry two overlapping schemas.

Repair writes install-ready `metis-grounded-study` and `metis-vault-maintenance` skills under `.metis/skills/`, with `SKILL.md`, OpenAI agent metadata, and a checksummed version manifest. Metis does not overwrite a client's global or project-specific skill directory; MCP clients receive the equivalent server policy automatically, while clients with Agent Skills support can install or link the generated folders explicitly.

Use `metis_restore_backup` with a backup path returned by repair to preview or restore managed state/config/wiki files. A restore first creates a recovery backup and never modifies raw evidence or exports.

Use `list_metis_backups` to inspect a bounded newest-first page while verifying every managed-file checksum. Metis does not automatically delete backups.

## Connect an MCP client

Use the following shape in clients that accept an MCP JSON configuration. Replace both paths with absolute paths:

```json
{
  "mcpServers": {
    "metis": {
      "command": "node",
      "args": ["/absolute/path/to/metis/dist/src/index.js"],
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
2. Put source files anywhere inside the vault and call `ingest_source` with a vault-relative path, or pass direct text.
3. Ask the assistant to synthesize the source into one or more concept pages with `upsert_wiki_page`. Every factual prose block must include an inline raw-source citation such as `[src_ab12#L8-L14]`.
4. Ask a question. The assistant should call `prepare_grounded_answer` before responding.
5. Call `get_knowledge_graph` globally or with a `focusId` to inspect a bounded neighborhood.
6. Run `lint_wiki` after major ingests to keep the knowledge base connected and trustworthy.

For strict closed-book behavior, choose `sources_only`. The normal `sources_first` mode uses the vault whenever it can and permits outside knowledge only when the returned evidence packet identifies a gap. Outside additions must be labelled.

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
    ├── backups/               checksummed managed-file update snapshots
    ├── cache/search-v1/       disposable checksum-keyed search indexes
    ├── skills/                generated grounding and maintenance Agent Skills
    ├── config.json            local configuration
    ├── repair.json            last successful repair and derivation versions
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

Overall coverage is `sufficient` only when every required facet is supported. A conflict therefore remains partial rather than being mistaken for extra corroboration. Facet statuses are conservative lexical routing signals, not semantic entailment, and their citations point to the retained raw excerpts. Callers may pass up to five short self-contained `facets` for a complex question; otherwise Metis conservatively decomposes obvious multi-clause questions.

Static behavior lives once in the MCP server instructions rather than being repeated in every answer packet. JSON tools also emit one model-facing payload rather than duplicating the same object as both text and structured content.

Every grounded-answer packet includes a short `packetId`. For an immediate related follow-up that remains in the same model context, pass it back as `priorPacketId`; Metis re-runs indexed retrieval and raw checksum verification, references citations already present in the earlier packet through `reusedEvidence`, and returns only new evidence. Unknown or expired packet IDs fail open to a complete fresh evidence packet.

`search_knowledge` defaults to server-side keyed wiki routing and normally returns one bounded capsule. Use `scope: "sources"` for raw excerpts or `scope: "all"` when both are explicitly useful. Normal wiki and source resources return compact capsules or provenance descriptors; complete generated wiki Markdown is available only through `study://maintenance/wiki/{slug}`. Wiki synthesis is never authoritative evidence for `prepare_grounded_answer`.

On wiki writes, Metis verifies that citation source IDs and line ranges exist, requires inline citation coverage for factual prose, and requires at least half of each block's distinctive terms to occur in its cited excerpts. This mechanical check catches missing, out-of-range, and unrelated citations; it is not a substitute for semantic or human review.

For long sessions, dashboards expose bounded summaries plus totals, and graph and lint results paginate or truncate explicitly. A fresh client can route to the right concept and reload verified evidence without replaying the transcript.

## Development

```sh
npm run typecheck
npm test
npm run eval
npm run build
```

The test suite covers the immutable source and wiki flow, grounded retrieval, citation validation, link linting, vault migration and repair, and an in-memory MCP client/server exchange.

The scored MCP evaluation harness runs separately with `npm run eval`. It talks to the server only through MCP, applies a growing weighted rubric with an 85% threshold, requires all critical safety checks, and writes JSON and Markdown reports to `.eval-results/`. See `evals/README.md` for coverage and extension instructions.

## Current boundaries

- Retrieval is local BM25-style lexical search behind a direct keyed concept map and checksum-keyed incremental inverted index. Lexical matching is the kernel's weakest layer and the current focus of work. Derived per-source indexes are disposable and versioned; selected line spans are rehydrated only after the raw source checksum is verified. An optional embedding or hybrid reranker can be added without changing the vault format.
- PDF ingestion extracts embedded text with `pdftotext`. OCR for scanned PDFs is not yet included, and extracted text is not yet checksummed independently of the source PDF.
- Ingestion is structure-blind: `.csv`, `.json`, and `.yaml` sources are chunked as prose.
- The connected LLM performs explanation and wiki synthesis. Metis provides compact evidence packets, persistent state, and one-time server policy rather than embedding a specific model vendor.
- Local state/log writes are serialized and cross-process locked; ingestion and wiki compilation also roll back generated files when their managed transaction fails. A future shared HTTP deployment still needs transactional multi-user storage and authentication.

## License

MIT
