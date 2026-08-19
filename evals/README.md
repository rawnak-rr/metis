# MCP evaluations

The eval suite exercises Metis through an actual in-memory MCP client/server connection. It does not call service classes directly and does not require a model API key.

Run:

```sh
npm run eval
```

CI mode uses the same deterministic checks and returns a nonzero exit code below threshold:

```sh
npm run eval:ci
```

Reports are written to:

- `.eval-results/latest.json` for CI ingestion and trend dashboards;
- `.eval-results/latest.md` for human review.

The suite uses a weighted rubric and requires at least 85%. Critical safety and contract checks must all pass even when the total score exceeds the threshold. The current rubric contains 245 weighted points; its total grows when new checks are added.

To evaluate an existing private vault without changing it:

```sh
npm run eval:real-vault -- /absolute/path/to/vault
```

That harness hashes the original tree, copies it to a temporary directory, migrates and queries only the copy, verifies keyed routing and payload budgets, checks the original hash again, writes a content-free report, and removes the copy in a `finally` block.

It also compares the former full-scan BM25 token work with the checksum-keyed incremental index across related questions, and separately measures compact answer-packet bytes with and without explicit same-context evidence reuse. Retrieval work counts lexical source-token visits plus posting-list visits; model tokens are conservatively estimated as JSON bytes divided by four and are not provider billing telemetry.

## Coverage

- MCP tool, resource, resource-template, prompt, schema, and annotation discovery
- bounded protocol discovery so newly added tools and resources cannot silently
  inflate every model session
- immutable ingestion provenance and checksum deduplication
- direct title/slug/alias/tag concept routing and compact wiki capsules
- bounded resource discovery, manifests, graph neighborhoods, dashboards, logs, and paginated health linting
- strict multi-domain golden-query retrieval relevance and line-span citations
- conservative per-facet support for multi-part questions, including explicit
  unsupported and conflicting states
- checksum-keyed incremental BM25 indexing, persisted derived-cache reuse, version invalidation, and warm-cache tamper detection
- same-context grounded-answer evidence deltas with safe full-packet fallback
- strict source-only behavior and sources-first gap escalation
- tamper, symlink, overlapping/repeated-evidence, prompt-injection, and contradictory-source defenses
- single-payload MCP JSON, bounded answer/search responses, and no repeated per-call contracts
- bounded concept/source knowledge graph neighborhoods
- ordered state-v4 legacy migrations, aliases, checksummed backups, restore round trips, and corrupted-backup reporting
- concurrent MCP mutations and cross-instance persistence
- transcript-independent reconnect behavior

The harness scores protocol and grounding *behavior*. It does not yet measure
retrieval *quality* — there is no recall@k or MRR over labeled question/span
pairs. Adding that is the next planned change.

Edit `cases.json` to add golden retrieval cases or change the pass threshold. Add domain fixtures under `fixtures/`. Checks should remain deterministic; use a separate optional model-graded suite if answer-quality judgments are added later.
