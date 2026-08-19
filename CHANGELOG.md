## [Unreleased]

### Changed

- Markdown ingestion drops YAML frontmatter, and LaTeX ingestion drops comments, the
  preamble, environment markers, and bookkeeping macros while converting sectioning
  commands to Markdown headings. Both blank lines in place, so citation line numbers keep
  addressing the raw file.
- Text sources must be valid UTF-8; a byte-order mark is accepted and stripped. Text and
  PDF sources are capped at 32 MiB and images at 5 MiB.
- A duplicate ingestion reuses stored text instead of re-extracting it.
- A failed ingestion removes its read-only raw copy and derived text instead of leaving
  orphans in the vault.
- State schema v5 adds the `image` source kind and the required `extraction` descriptor;
  the v4 to v5 migration infers the method of existing sources from their kind.
- The search-index derivation version and generated-wiki format version advanced, so
  repair rebuilds indexes and refreshes provenance pages under the new extraction rules.
- Reduced Metis to a grounding kernel. Removed spaced repetition, practice generation,
  mastery/confidence tracking, misconceptions, goals, session planning, constrained
  mathematics, and LaTeX PDF output. The MCP surface is now 10 tools and one prompt.
  Higher-level workflows are expected to build on the kernel rather than live inside it.
- Split the former `LearningService` into `GroundingService`, which keeps grounded-answer
  assembly, facet coverage, and evidence packets.
- State schema v4 drops `cards`, `reviews`, and `goals`, and reduces concept records to
  identity, notes, and source references. The v3 to v4 migration discards learner state.
- Concept capsules no longer carry a learner overlay.

### Added

- Image ingestion: `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp` sources are transcribed
  with `claude-haiku-4-5`, the cheapest Claude model with vision, overridable through
  `METIS_VISION_MODEL`. The Anthropic SDK is an optional dependency loaded on first use.
- Persisted derived text under `.metis/cache/text-v1/`, so a PDF is extracted and an image
  transcribed exactly once per checksum and image line citations stay stable across reads,
  duplicate ingestions, and repair. An image whose transcript cannot be persisted is not
  ingested at all, since re-running the model would not reproduce its line numbers.
- Stable ingestion failure codes with a `retryable` flag, returned by `ingest_source` as a
  structured `error` result instead of an opaque protocol error.
- Extraction provenance on every source record and generated provenance page: method,
  media type, and transcribing model.
- `metis_repair` CLI and MCP workflow with dry-run inspection, ordered migrations, checksummed rollback backups, generated knowledge repair, portable Agent Skill refresh, incremental/full search-index synchronization, downgrade refusal, and post-repair health reporting. `metis update` remains a CLI alias.
- `metis_restore_backup` with restore previews, recovery backups, managed wiki swaps, and raw-source preservation.
- `list_metis_backups` with complete checksum verification and invalid-backup reporting.
- State schema v2 with structured, recurring, and resolvable misconception records.
- State schema v3 with persisted wiki aliases and ordered v1→v2→v3 migration.
- Direct keyed concept lookup over titles, slugs, aliases, tags, and concept IDs.
- Compact concept capsules, bounded graph neighborhoods, paginated wiki health, and a non-destructive private-vault context evaluator.
- Adaptive practice/session priority using mastery, confidence, recency, active misconceptions, and goal urgency.
- Cross-process vault write locking, stale-lock recovery, and serialized log/state writes.
- Managed state/wiki/index/log transactions for ingestion and wiki updates.
- Prompt-injection and contradictory-source grounding warnings.
- Multi-domain deterministic retrieval, migration, restore, concurrency, and adaptive-learning evaluations.
- GitHub CI, issue templates, contribution guidance, and security policy.
- A versioned checksum-keyed incremental BM25 inverted index, persisted as disposable per-source derived data and built during ingestion.
- Immediate grounded-answer follow-up reuse through packet IDs and evidence deltas.
- A content-free MATH2991 retrieval/context benchmark and clean Matplotlib teaser graph.
- Conservative per-facet grounded-answer coverage with optional caller-provided facets, automatic multi-clause decomposition, citation mapping, and explicit supported, partially supported, unsupported, and conflicting states.
- A critical MCP discovery-size budget to prevent tools, resources, templates, and prompts from silently bloating every model session.

### Changed

- Mastery evidence is calibrated with prior weight and no longer jumps to 100% after one successful attempt.
- Search token normalization matches common singular/plural variants.
- Source search now ranks posting-list candidates from cached token frequencies instead of rechunking and retokenizing the full scoped corpus on every query.
- Search defaults to one keyed wiki capsule; raw-source excerpts are explicit or assembled internally for grounded answer/practice packets.
- Common tool responses return bounded deltas, dashboards/plans remain cardinality-independent, and JSON is emitted once instead of duplicated as text and structured content.
- Answer and practice policy moved to one-time server instructions instead of repeating long contracts on every call.
- Normal wiki/source/graph resources are bounded manifests or capsules; complete wiki Markdown is maintenance-only.
- Math verification omits input echoes and bounds very large exact, LaTeX, and solution-list output.
- Overall answer coverage is sufficient only when every required facet is supported; contradictory numeric evidence now keeps coverage partial instead of counting as corroboration.
- Grounded-answer evidence selection now returns only passages that support or partially support a facet instead of filling the result limit with unrelated ranked chunks.
- Model-facing concept capsules omit internal routing metadata and empty learner fields.
- Knowledge graphs omit the duplicate Mermaid rendering by default; callers can request it only when needed.
- Server instructions and verbose tool descriptions were consolidated without removing grounding, safety, practice, math, or update policy.
- CLI builds emit runtime JavaScript only; evaluations run directly from TypeScript and no longer populate `dist/` with tests, evals, declarations, or source maps.

### Removed

- Redundant wiki-index and graph-manifest resources that only redirected the model to existing tools.
- Duplicate dashboard and operation-log tools; their bounded MCP resources remain available.
- Dated development-session, completion-audit, and evaluation-log documents duplicated by the current README, architecture, changelog, tests, and generated evaluation report.
- The broken retrieval-graph command and documentation for absent renderer files.

### Security

- Raw-source checksum verification on every authoritative read.
- Indexed candidates are rehydrated from freshly checksum-verified raw text before return; incompatible or mismatched derived entries rebuild automatically.
- Canonical path containment rejects symlink escapes.
- Overlapping evidence chunks are deduplicated.
- Repeated support sentences are deduplicated even when their source spans do not overlap.
- Wiki citations require valid raw-source spans and deterministic support checks.
- Updated transitive MCP/Hono dependencies to versions without known npm audit vulnerabilities.
