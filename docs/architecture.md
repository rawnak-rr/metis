# Architecture

Metis separates evidence, synthesis, pedagogy, and model interaction so each can be inspected and replaced independently.

## Evidence and synthesis

`KnowledgeService` ingests source bytes into read-only raw copies, computes provenance, rechecks their SHA-256 digest on every read, extracts searchable text, and manages compiled wiki pages. Existing input and raw-source paths are resolved through their canonical filesystem paths so vault symlinks cannot escape the configured root. Search chunks retain line boundaries; overlapping spans and repeated support sentences are deduplicated; citation tokens identify exact raw-source spans.

Ingestion also creates a versioned per-source search index keyed by the raw checksum. The in-memory inverted index is updated only for new or changed source records; on restart, compatible derived entries are restored from `.metis/cache/search-v1/`, while absent or incompatible entries rebuild from verified raw evidence. BM25 queries visit matching posting lists rather than retokenizing every chunk. Cached text is never returned directly: selected line spans are rehydrated from a freshly checksum-verified source, and a mismatched derived chunk is rebuilt automatically.

Concept pages require known source IDs and inline citations on factual prose. Citation ranges are checked against the referenced raw source, and an intentionally conservative lexical check requires at least half of each block's distinctive terms to occur in its cited excerpts. Compiled wiki pages remain useful synthesis and human-readable notes, but they never become authoritative answer or practice evidence.

For model access, the wiki is a keyed persistent intermediate representation. A direct `Map` resolves normalized titles, slugs, aliases, tags, and concept IDs to bounded concept capsules. Exact/alias lookup does not scan page prose. Only fuzzy fallback ranks candidate entries. The default search surface returns one capsule; checksum-verified raw evidence is loaded lazily when an answer, practice task, or explicit source search needs it.

Normal wiki, source, dashboard, and log resources are bounded. Complete generated wiki Markdown is isolated behind an explicit maintenance URI. Resource discovery does not enumerate every source or concept; graph and index access use their existing bounded tools instead of redundant manifest resources.

## Learning model

`LearningService` owns:

- grounding policies and evidence sufficiency;
- adaptive practice briefs;
- SM-2 card scheduling;
- mastery estimates and confidence;
- misconceptions;
- study goals and timed session plans.

Mastery is deliberately understandable rather than presented as a psychometrically exact score. It is a bounded recency-weighted performance signal; confidence grows with attempts. Both values remain visible in `.metis/state.json`.

Answer and practice packets contain only the current keyed concepts, learner overlay, task settings, minimum raw excerpts, and situational warnings. Static policy lives in server instructions. Immediate same-context answer follow-ups may pass a prior packet ID; Metis verifies and reruns retrieval but returns matching earlier citations by reference plus only the new evidence delta. The bounded packet cache is intentionally ephemeral, so a reconnect falls back to full evidence. Review queues are front-only and one card by default; backs require an exact post-attempt lookup. Completed reviews and grades persist immediately, so the next activity can be reconstructed by a fresh MCP client without transcript replay.

Grounded answers decompose obvious multi-clause questions into at most five facets, while callers may provide more accurate self-contained facets explicitly. Retrieval runs per facet and the bounded packet maps each facet to raw citations with a `supported`, `partially_supported`, `unsupported`, or `conflicting` status. Overall coverage is sufficient only when every facet is supported. The server contract identifies these as conservative lexical routing signals rather than semantic entailment; raw evidence remains available to the connected model for final judgment.

## Model boundary

The MCP server does not require a provider API key. It uses the model already connected through the MCP client:

- tools retrieve evidence and persist actions;
- resources expose bounded dashboard, wiki, log, source, and maintenance views;
- prompts teach the host model the desired study workflows.

This keeps deployment portable across clients and avoids coupling personal study data to one model vendor. JSON tools emit one compact text payload rather than duplicating the object in both MCP content channels.

## Numerical boundary

Node sends a constrained JSON request to `python/verify_math.py`. The Python process parses expressions with the standard AST module and evaluates only allow-listed nodes. The dependency-free path uses `decimal` arithmetic, direct linear/quadratic solving, and residual-checked Newton iteration. When SymPy is available, the same safe parse tree gains richer symbolic evaluation and solving. Python code, attribute access, subscripting, comprehensions, and arbitrary function calls are rejected. Model-facing results omit echoed inputs and cap exact/LaTeX strings and solution lists.

## Filesystem boundary

All user paths are resolved against `METIS_VAULT_PATH`; traversal and absolute paths are rejected. LaTeX exports are confined to `exports/`. The document body cannot inject file I/O or preamble commands, and compilation disables shell escape.

## Persistence and upgrade boundary

State and log mutations pass through an in-process queue and an exclusive `.metis/write.lock`, preventing lost updates across parallel MCP calls and multiple Metis instances. Stale locks are recovered only when their owner process is no longer alive, while active-lock waits fail with a clear timeout instead of writing concurrently. State and configuration are validated with complete runtime schemas before use and before persistence. Knowledge ingestion and wiki compilation stage managed text changes, commit state last, and restore prior generated files when a write fails.

`metis_repair` is the explicit vault-upgrade and recovery boundary shared by the CLI and MCP. It supports dry-run inspection, refuses newer-schema downgrades, creates a checksummed managed-file backup, executes ordered pure migrations through state v3, reconciles safe foreign references, and refreshes generated wiki schema, source descriptors, concept frontmatter, index files, and portable Agent Skills. Valid synthesis bodies remain unchanged; a missing or mechanically invalid concept body is rebuilt as a minimal verbatim-evidence page with verified line citations. Files not represented by state are pruned only from the explicitly Metis-managed concept/source directories and remain in the repair backup.

Every raw source is checksum-verified before repair. A missing or modified source is not repairable from derived data, so the operation stops and automatically restores managed state/wiki files. Search indexes are disposable: incremental repair reuses entries whose source checksum and derivation version match, rebuilds invalid or missing entries, and removes stale cache files; full mode rebuilds all entries. `metis_restore_backup` verifies the complete checksum inventory, creates a recovery backup, and restores state/config plus the managed wiki. Repair, migration, and restore never rewrite files under `raw/` or `exports/`.

## Extension seams

The stable vault format allows later additions without migration of user-authored Markdown:

- hybrid embeddings and reranking;
- OCR and richer document parsers;
- FSRS scheduling;
- graph visualization and prerequisite inference;
- HTTP transport, user accounts, and shared classrooms;
- rubric calibration and richer knowledge tracing;
- optional model sampling when the MCP client advertises that capability.
