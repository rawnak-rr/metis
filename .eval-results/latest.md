# Metis MCP Evaluation

- Result: **PASS**
- Score: **163/163 (100%)**
- Required threshold: 85% and all critical checks
- Critical checks: passed
- Duration: 234 ms
- Finished: 2026-08-19T13:43:28.721Z

| Result | Check | Category | Weight | Criterion |
|---|---|---:|---:|---|
| Pass | `protocol.required_tools` | protocol | 6 | Advertises every required grounding and maintenance tool |
| Pass | `protocol.tool_metadata` | protocol | 3 | Tool schemas include descriptions and behavioral annotations |
| Pass | `context.single_wire_payload` | context | 5 | JSON tools emit one compact model-facing payload instead of duplicating text and structured content |
| Pass | `protocol.resources_prompts` | protocol | 3 | Exposes navigable resources, templates, and a reusable grounding prompt |
| Pass | `context.protocol_surface_budget` | context | 5 | Tool, resource, template, and prompt discovery stays compact |
| Pass | `ingest.provenance` | knowledge | 5 | Ingestion creates immutable IDs, SHA-256 checksums, and raw paths |
| Pass | `ingest.deduplication` | knowledge | 3 | Byte-identical sources deduplicate by checksum |
| Pass | `context.bounded_discovery` | context | 5 | Resource discovery stays fixed-size without enumerating every concept or source |
| Pass | `wiki.compilation_integrity` | wiki | 6 | Compiled pages retain provenance and resolve reciprocal links |
| Pass | `wiki.obsidian_resource` | wiki | 3 | Normal wiki resource returns one compact keyed capsule rather than full Markdown |
| Pass | `context.keyed_concept_lookup` | context | 7 | Exact alias lookup resolves through the server-side concept map with a bounded capsule |
| Pass | `context.bounded_resources` | context | 6 | Source metadata stays compact while full wiki Markdown is maintenance-only |
| Pass | `migration.backup_roundtrip` | persistence | 8 | Metis repair previews safely, migrates legacy metadata, repairs generated knowledge and skills, backs up managed files, and preserves raw evidence |
| Pass | `migration.restore_roundtrip` | persistence | 7 | Backup restore previews safely, creates a recovery backup, restores managed state, and preserves raw evidence |
| Pass | `retrieval.golden_queries` | grounding | 8 | Golden queries retrieve expected source language with ranked line spans |
| Pass | `context.source_search_budget` | context | 7 | Every multi-domain raw-source search stays within the model-context byte budget |
| Pass | `grounding.known_citations` | grounding | 6 | Known questions return non-fabricated line-span citation tokens |
| Pass | `context.grounded_packet_budget` | context | 7 | Grounded answer packet stays bounded without repeated policy while retaining keyed state and raw citations |
| Pass | `grounding.facet_coverage` | grounding | 7 | Multi-part questions expose compact per-facet support and cannot become sufficient when a required facet is unsupported |
| Pass | `grounding.prompt_injection_boundary` | grounding | 7 | Evidence packets explicitly classify retrieved instructions as untrusted source data |
| Pass | `grounding.conflicting_sources` | grounding | 7 | Grounding returns independent contradictory passages and requires the answer to expose the conflict |
| Pass | `grounding.strict_no_external` | grounding | 6 | Strict grounding never escalates to outside knowledge when evidence is absent |
| Pass | `grounding.sources_first_gap` | grounding | 4 | Sources-first mode exposes unsupported facets for explicitly labelled gap filling |
| Pass | `context.transcript_independent_resume` | context | 8 | A fresh MCP client routes to the right concept capsule without prior transcript |
| Pass | `context.bounded_maintenance_page` | context | 6 | Large lint results paginate and populated discovery remains independent of vault cardinality |
| Pass | `progress.dashboard_resource` | learning | 5 | Dashboard resource reflects sources, wiki pages, and concepts |
| Pass | `progress.knowledge_graph` | learning | 5 | Bounded graph neighborhoods connect concepts to their supporting evidence |
| Pass | `persistence.concurrent_tool_writes` | persistence | 8 | Parallel MCP mutations preserve every independent write |

## Failed-check evidence
