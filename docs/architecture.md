# Architecture

Metis is a grounding kernel. It separates evidence, synthesis, and model interaction so each can be inspected and replaced independently. Anything above grounding — research workflows, testing, study scheduling — is a consumer of this kernel, not part of it.

## Evidence and synthesis

`IngestService` ingests source bytes into read-only raw copies and computes provenance; `VerifiedSourceReader` rechecks their SHA-256 digest on every read and derives searchable text; `SearchService` indexes and ranks it; `WikiService` manages compiled wiki pages. Every one of them reads evidence through the same reader, so no path in the kernel can read a raw copy without verifying it first. Existing input and raw-source paths are resolved through their canonical filesystem paths so vault symlinks cannot escape the configured root. Search chunks retain line boundaries; overlapping spans and repeated support sentences are deduplicated; citation tokens identify exact raw-source spans.

Text derivation is per-format and line-preserving. Markdown keeps its body and blanks frontmatter; LaTeX blanks comments, the preamble, environment markers, and bookkeeping macros, and rewrites sectioning commands as Markdown headings; PDFs go through `pdftotext`; images are transcribed by the cheapest Claude vision model. Because every branch blanks lines rather than deleting them, a citation addresses the same line in the extracted text and in the raw file. Text branches are pure functions of the stored bytes, so they are recomputed freely; PDF and vision text is persisted per checksum under `.metis/cache/text-v1/`, because a transcript cannot be re-derived byte-for-byte and shifting it would move every line citation. A persisted entry records a checksum of the derived text as well as the source's, so a truncated or edited cache file is treated as absent rather than trusted. An absent PDF derivation is recomputed from the verified bytes and rewritten. An absent transcript is not recoverable, so the read fails with `DERIVED_TEXT_UNRECOVERABLE` instead of transcribing the image a second time and silently moving every citation into it, which is why that cache directory is the one worth backing up outside Metis. Each source records its extraction method and transcribing model, so model-transcribed evidence is distinguishable from a verbatim reading. Ingestion is transactional in both directions: nothing is recorded until text exists, and a failure removes the read-only raw copy and derived text it staged. Batch ingestion shares that path per file and the commit across the batch: extraction is independent and bounded in concurrency, so one unreadable file is reported as its own coded failure, while the state write, wiki index rebuild, and log entry happen once. Byte-identical files inside one batch claim a checksum before extraction begins, so they resolve to a single record rather than racing to store two. A directory scan never descends into `raw/`, `wiki/`, or `.metis/`, which would otherwise re-ingest Metis's own output as fresh evidence. Failures carry stable machine-readable codes and a retryable flag rather than only prose.

Ingestion also creates a versioned per-source search index keyed by the raw checksum. The in-memory inverted index is updated only for new or changed source records; on restart, compatible derived entries are restored from `.metis/cache/search-v1/`, while absent or incompatible entries rebuild from verified raw evidence. BM25 queries visit matching posting lists rather than retokenizing every chunk. Cached text is never returned directly: selected line spans are rehydrated from a freshly checksum-verified source, and a mismatched derived chunk is rebuilt automatically.

A citation token is separately resolvable. `CitationResolver` reads the exact lines a token names through the source's identity and line range alone, with no ranker involved, so the same token returns the same text however much has been ingested since. That is what lets a caller carry a token instead of an excerpt and read the excerpt back later, and it is why the bounds and precision rules are shared with wiki validation: a token a page may carry is exactly a token that resolves. Each read re-verifies the raw source's checksum, so a token cannot resolve against modified evidence, and one unusable token is reported alongside the excerpts that did resolve rather than failing the batch.

Concept pages require known source IDs and inline citations on factual prose. Citation ranges are checked against the referenced raw source, and writes retain the conservative lexical check that requires at least half of each block's distinctive terms to occur in its cited excerpts. `lint_wiki` also assesses individual sentences against the block's pooled citations. It reports unsupported checkable sentences as `unsupported_claim` at info severity while the sentence threshold is calibrated. Short connective prose may fail lexical matching without producing a finding, but digits, acronyms, and proper-name capitals keep a sentence checkable. Compiled wiki pages remain useful synthesis and human-readable notes, but they never become authoritative answer evidence.

For model access, the wiki is a keyed persistent intermediate representation. A direct `Map` resolves normalized titles, slugs, aliases, tags, and concept IDs to bounded concept capsules. Exact/alias lookup does not scan page prose. Only fuzzy fallback ranks candidate entries. The default search surface returns one capsule; checksum-verified raw evidence is loaded lazily when an answer or an explicit source search needs it.

Normal wiki, source, dashboard, and log resources are bounded. Complete generated wiki Markdown is isolated behind an explicit maintenance URI. Resource discovery does not enumerate every source or concept; graph and index access use their existing bounded tools instead of redundant manifest resources.

## Grounding model

`GroundingService` owns grounding policies, evidence sufficiency, and answer packet assembly.

Answer packets contain only the current keyed concepts, minimum raw excerpts, and situational warnings. Static policy lives in server instructions. Immediate same-context answer follow-ups may pass a prior packet ID; Metis verifies and reruns retrieval but returns matching earlier citations by reference plus only the new evidence delta. Packets are persisted under `.metis/cache/packets-v1/`, so a reconnect can still reuse one, and the newest thirty-two are kept. A record holds the grounding mode and the citation tokens it already showed, never the excerpt bodies: a token plus a verified source rehydrates the text, while a stored body would be a second, unverified copy of the evidence. A packet remains a bounded convenience, so an unwritable or unreadable record is a miss and the caller receives full evidence again.

Grounded answers decompose obvious multi-clause questions into at most five facets, while callers may provide more accurate self-contained facets explicitly. Retrieval runs per facet and the bounded packet maps each facet to raw citations with a `supported`, `partially_supported`, `unsupported`, or `conflicting` status. Overall coverage is sufficient only when every facet is supported. The server contract identifies these as conservative lexical routing signals rather than semantic entailment; raw evidence remains available to the connected model for final judgment.

Token coverage must not decide what the model gets to see, because it cannot rank a passage that answers a facet in different words against one that merely repeats the question's wording. Visibility therefore follows retrieval alone: unused packet budget goes to a bounded number of passages the coverage check could not confirm rather than being left unspent, marked `lexicalSupport: "related"` in the evidence list and listed under the facet's `borderlineCitations`. Withholding relevant evidence cannot be recovered downstream, while an extra excerpt only costs context.

Coverage is also not the last word on status. When the connected client advertises sampling, each facet's packet passages are sent to that client's model for a support verdict, and the returned status and citations replace the lexical ones and carry `statusMethod: "entailment"`. Only passages already in the packet are judged, so a verdict never widens what the caller sees; a facet already decided by a mechanical numeric conflict is left alone; and a client without sampling, a refused or timed out request, or an unparseable reply falls back to the lexical status rather than failing the answer. Passage text reaches that model as untrusted data, and the prompt says so.

Learner state is deliberately absent. Concept records carry identity, notes, and source references only. Mastery, scheduling, and misconception tracking belong to tools built on top of the kernel, which own their own state.

## Model boundary

The MCP server does not require a provider API key. It uses the model already connected through the MCP client:

- tools retrieve evidence and persist actions;
- resources expose bounded dashboard, wiki, log, source, and maintenance views;
- prompts teach the host model the desired grounding workflow;
- sampling asks that model for a facet support verdict when the client advertises the capability.

This keeps deployment portable across clients and avoids coupling vault data to one model vendor. JSON tools emit one compact text payload rather than duplicating the object in both MCP content channels.

## Filesystem boundary

All user paths are resolved against `METIS_VAULT_PATH`; traversal and absolute paths are rejected. Existing input and raw-source paths are resolved through their canonical filesystem paths so vault symlinks cannot escape the configured root.

## Persistence boundary

State and log mutations pass through an in-process queue and an exclusive `.metis/write.lock`, preventing lost updates across parallel MCP calls and multiple Metis instances. Stale locks are recovered only when their owner process is no longer alive, while active-lock waits fail with a clear timeout instead of writing concurrently. State and configuration are validated with complete runtime schemas on every read and before every write. Knowledge ingestion and wiki compilation stage managed text changes, commit state last, and restore prior generated files when a write fails.

There is deliberately no schema versioning, migration, or repair boundary. The current on-disk shape is the only shape, so a vault written by an older build is a validation failure rather than something to migrate, and nothing rebuilds derived data on demand. The two derived caches still heal themselves where they can: a search index carries a derivation fingerprint and is discarded when the parser, chunker, or tokenizer changes, and PDF text is recomputed from the checksum-verified bytes whenever its cache entry is absent. Image transcripts cannot be recomputed, so `.metis/cache/text-v1/` is the one directory whose loss is unrecoverable and the one worth backing up outside Metis.

## Source layout

Each directory under `src/` is one layer, and the dependency graph between them
is acyclic in the order listed:

| Directory | Owns |
| --- | --- |
| `shared/` | ids, hashing, path safety, atomic writes, error codes, context limits, the lexical tokenizer |
| `contracts/` | the vault data model: zod schemas, source-type descriptors, the citation token grammar |
| `vault/` | the filesystem boundary: state, config, the write queue and lock, managed file writes, generated templates, read-only views |
| `ingestion/` | bytes into recorded evidence: format extraction, vision transcription, the verified source reader, the transactional ingest pipeline |
| `search/` | tokenized BM25 indexing and ranking, the keyed concept index, citation resolution |
| `synthesis/` | compiled concept pages: claim splitting, citation and lexical validation, `lint_wiki` |
| `grounding/` | facet decomposition, evidence selection and packet assembly, the entailment port, the packet cache |
| `mcp/` | tool, resource, and prompt registration, and the sampling-backed entailment judge |
| `cli/` | argv parsing and process wiring |
| `kernel.ts` | the composition root that wires the services over one vault |

One edge is worth naming. Ingestion declares the `SourceIndexWriter` port that
search implements, so warming the index after an ingest is an effect ingestion
requests rather than a dependency it owns.

## Extension seams

The vault format is stable in practice rather than by contract, since nothing migrates it yet:

- hybrid embeddings and reranking, the only fix for a paraphrase lexical retrieval never returns at all;
- entailment-based wiki citation gating, reusing the grounding sampling seam;
- a repair and migration boundary, when the format starts changing under real vaults;
- structure-aware chunking and richer document parsers;
- graph visualization and prerequisite inference;
- HTTP transport, user accounts, and shared vaults;
- higher-level consumers (research, testing, scheduling) that keep their own state beside the kernel's.
