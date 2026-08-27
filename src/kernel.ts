import { StudyStore } from "./vault/store.js";
import { VerifiedSourceReader } from "./ingestion/source-reader.js";
import { IngestService } from "./ingestion/service.js";
import { CitationResolver } from "./search/citations.js";
import { SearchService } from "./search/service.js";
import { WikiService } from "./synthesis/wiki.js";
import { KnowledgeRepair } from "./repair/knowledge.js";
import type { VisionTranscriber } from "./ingestion/vision.js";

export interface MetisKernel {
  store: StudyStore;
  /** Verified reads of stored evidence; every other service reads through it. */
  sources: VerifiedSourceReader;
  ingestion: IngestService;
  search: SearchService;
  citations: CitationResolver;
  wiki: WikiService;
  knowledgeRepair: KnowledgeRepair;
}

/**
 * Wires the kernel's services over one vault.
 *
 * The wiring is the whole design in ten lines: one reader holds the text cache
 * and the checksum guarantee, search implements the index port that ingestion
 * declares, and repair sits above everything because it rebuilds what the rest
 * derive. Nothing here decides policy, so a consumer that needs only part of
 * the kernel can construct that part directly instead.
 */
export function createKernel(
  store: StudyStore,
  transcriber?: VisionTranscriber,
): MetisKernel {
  const sources = transcriber === undefined
    ? new VerifiedSourceReader(store)
    : new VerifiedSourceReader(store, transcriber);
  const search = new SearchService(store, sources);
  const ingestion = new IngestService(store, sources, search);
  const citations = new CitationResolver(store, sources);
  const wiki = new WikiService(store, sources);
  const knowledgeRepair = new KnowledgeRepair(store, sources, search, wiki);
  return { store, sources, ingestion, search, citations, wiki, knowledgeRepair };
}
