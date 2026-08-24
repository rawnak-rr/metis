import type {
  CompactConceptCapsule,
  ConceptCapsule,
  EvidenceExcerpt,
  GroundingMode,
  SearchChunk,
} from "./types.js";
import {
  KnowledgeService,
  compactConceptCapsule,
  tokenize,
  type RetrievalSession,
} from "./knowledge.js";
import { StudyStore } from "./store.js";
import { newId, unique } from "./util.js";

const MAX_REUSABLE_EVIDENCE_EXCERPTS = 18;
const MAX_ANSWER_FACETS = 5;
const MAX_ANSWER_EVIDENCE = 6;
const SUPPORTED_UNION_TOKEN_COVERAGE = 0.7;
const SUPPORTED_PASSAGE_TOKEN_COVERAGE = 0.5;

const FACET_INSTRUCTION_TOKENS = new Set([
  "answer",
  "describe",
  "discuss",
  "explain",
  "happen",
  "happens",
  "identify",
  "make",
  "please",
  "show",
  "tell",
  "why",
]);

export type EvidenceFacetStatus =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "conflicting";

export interface EvidenceFacetCoverage {
  id: string;
  question: string;
  status: EvidenceFacetStatus;
  citations: string[];
}

export interface EvidencePacket {
  packetId: string;
  groundingMode: GroundingMode;
  coverage: "sufficient" | "partial" | "none";
  facets: EvidenceFacetCoverage[];
  concepts: CompactConceptCapsule[];
  evidence: EvidenceExcerpt[];
  warnings: Array<
    | "compare_independent_sources"
    | "possible_numeric_conflict"
    | "source_instructions_detected"
  >;
  reusedEvidence?: {
    fromPacketId: string;
    citations: string[];
  };
  reuseUnavailable?: boolean;
}

interface CachedEvidencePacket {
  groundingMode: GroundingMode;
  evidence: EvidenceExcerpt[];
}

interface AnswerFacet {
  id: string;
  question: string;
  retrievalQuery: string;
  explicit: boolean;
}

interface FacetRetrieval {
  facet: AnswerFacet;
  hits: SearchChunk[];
}
export class GroundingService {
  private readonly answerPackets = new Map<string, CachedEvidencePacket>();

  constructor(
    private readonly store: StudyStore,
    private readonly knowledge: KnowledgeService,
  ) {}

  async prepareAnswer(
    question: string,
    mode?: GroundingMode,
    limit = 3,
    priorPacketId?: string,
    requestedFacets?: string[],
  ): Promise<EvidencePacket> {
    const config = await this.store.getConfig();
    const groundingMode = mode ?? config.groundingDefault;
    const evidenceLimit = Math.max(
      1,
      Math.min(MAX_ANSWER_EVIDENCE, Math.round(limit)),
    );
    const retrieval = await this.knowledge.openRetrieval();
    const concepts = retrieval.lookupConcepts(question, 2);
    const answerFacets = buildAnswerFacets(question, requestedFacets);
    const facetRetrievals: FacetRetrieval[] = [];
    for (const facet of answerFacets) {
      const facetConcepts = retrieval.lookupConcepts(facet.retrievalQuery, 2);
      const routedConcepts = mergeConceptCapsules(facetConcepts, concepts);
      facetRetrievals.push({
        facet,
        hits: await this.routedEvidence(
          retrieval,
          facet.retrievalQuery,
          routedConcepts,
          Math.max(2, evidenceLimit),
        ),
      });
    }
    const hits = selectFacetEvidence(facetRetrievals, evidenceLimit);
    const selectedHitKeys = new Set(hits.map(searchHitKey));
    const facets = facetRetrievals.map(({ facet, hits: candidates }) =>
      assessEvidenceFacet(
        facet,
        candidates.filter((hit) => selectedHitKeys.has(searchHitKey(hit))),
      ));
    const coverage = aggregateFacetCoverage(facets);
    const completeEvidence = this.knowledge.evidenceExcerpts(hits);
    const priorPacket = priorPacketId
      ? this.answerPackets.get(priorPacketId)
      : undefined;
    const compatiblePriorPacket = priorPacket?.groundingMode === groundingMode
      ? priorPacket
      : undefined;
    const reusableCitations = compatiblePriorPacket
      ? new Set(compatiblePriorPacket.evidence.map((item) => item.citation))
      : new Set<string>();
    const reusedCitations = completeEvidence
      .filter((item) => reusableCitations.has(item.citation))
      .map((item) => item.citation);
    const evidence = completeEvidence
      .filter((item) => !reusableCitations.has(item.citation));
    const packetId = newId("packet");
    const reusableEvidence = [
      ...(compatiblePriorPacket?.evidence ?? []),
      ...completeEvidence,
    ].filter((item, position, items) =>
      items.findIndex((candidate) =>
        candidate.citation === item.citation) === position)
      .slice(-MAX_REUSABLE_EVIDENCE_EXCERPTS);
    this.rememberAnswerPacket(packetId, {
      groundingMode,
      evidence: reusableEvidence,
    });
    return {
      packetId,
      groundingMode,
      coverage,
      facets,
      concepts: concepts.map(compactConceptCapsule),
      evidence,
      warnings: evidenceWarnings(completeEvidence),
      ...(priorPacketId && reusedCitations.length > 0
        ? {
            reusedEvidence: {
              fromPacketId: priorPacketId,
              citations: reusedCitations,
            },
          }
        : {}),
      ...(priorPacketId && !compatiblePriorPacket
        ? { reuseUnavailable: true }
        : {}),
    };
  }

  private rememberAnswerPacket(
    packetId: string,
    packet: CachedEvidencePacket,
  ): void {
    this.answerPackets.set(packetId, packet);
    while (this.answerPackets.size > 32) {
      const oldest = this.answerPackets.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.answerPackets.delete(oldest);
    }
  }

  private async routedEvidence(
    retrieval: RetrievalSession,
    query: string,
    concepts: ConceptCapsule[],
    limit: number,
  ): Promise<SearchChunk[]> {
    const sourceIds = retrieval
      .sourceIdsForConcepts(concepts.map((concept) => concept.key));
    const routed = sourceIds.size > 0
      ? await retrieval.search(query, limit, { sourceIds })
      : [];
    if (routed.filter((hit) => hit.score >= 2).length >= Math.min(2, limit)) {
      return routed;
    }
    const broader = await retrieval.search(query, limit);
    const merged = new Map<string, SearchChunk>();
    for (const hit of [...routed, ...broader]) {
      const key = `${hit.documentId}:${hit.lineStart}:${hit.lineEnd}`;
      const existing = merged.get(key);
      if (!existing || hit.score > existing.score) merged.set(key, hit);
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 6)));
  }
}

function buildAnswerFacets(
  question: string,
  requestedFacets?: string[],
): AnswerFacet[] {
  const explicitFacets = (requestedFacets ?? [])
    .map(cleanFacetText)
    .filter(Boolean);
  const sourceFacets = explicitFacets.length > 0
    ? explicitFacets
    : splitQuestionFacets(question);
  const deduplicated = new Map<string, string>();
  for (const facet of sourceFacets) {
    const key = facet.toLowerCase();
    if (!deduplicated.has(key)) deduplicated.set(key, facet);
  }
  const facetQuestions = [...deduplicated.values()]
    .slice(0, MAX_ANSWER_FACETS);
  const fallback = cleanFacetText(question);
  if (facetQuestions.length === 0 && fallback) facetQuestions.push(fallback);
  const context = facetQuestions[0] ?? fallback;
  return facetQuestions.map((facetQuestion, index) => {
    const needsContext = explicitFacets.length === 0
      && index > 0
      && (
        /\b(?:it|its|they|their|this|that|these|those|former|latter)\b/i
          .test(facetQuestion)
        || facetSupportTokens(facetQuestion).length < 3
      );
    return {
      id: `facet_${index + 1}`,
      question: facetQuestion,
      retrievalQuery: needsContext
        ? `${facetQuestion} ${context}`
        : facetQuestion,
      explicit: explicitFacets.length > 0,
    };
  });
}

function splitQuestionFacets(question: string): string[] {
  const questionLead = "(?:what|why|how|when|where|who|which|whether|do|does|did|is|are|can|could|should|would|will|explain|describe|compare|identify)";
  const separated = question
    .replace(new RegExp(`\\?\\s+(?=${questionLead}\\b)`, "gi"), "?\n")
    .replace(new RegExp(`\\.\\s+(?=${questionLead}\\b)`, "gi"), ".\n")
    .replace(/;\s+/g, ";\n");
  const conjunction = new RegExp(
    `\\s*,?\\s+(?:and|but)\\s+(?=${questionLead}\\b)`,
    "gi",
  );
  return separated
    .split("\n")
    .flatMap((sentence) => sentence.split(conjunction))
    .map(cleanFacetText)
    .filter(Boolean);
}

function cleanFacetText(value: string): string {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .replace(/[\s,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeConceptCapsules(
  primary: ConceptCapsule[],
  fallback: ConceptCapsule[],
): ConceptCapsule[] {
  const merged = new Map<string, ConceptCapsule>();
  for (const concept of [...primary, ...fallback]) {
    if (!merged.has(concept.key)) merged.set(concept.key, concept);
  }
  return [...merged.values()].slice(0, 2);
}

function selectFacetEvidence(
  retrievals: FacetRetrieval[],
  limit: number,
): SearchChunk[] {
  const selected = new Map<string, SearchChunk>();
  const add = (hit: SearchChunk): void => {
    if (selected.size >= limit) return;
    const key = searchHitKey(hit);
    const existing = selected.get(key);
    if (!existing || hit.score > existing.score) selected.set(key, hit);
  };

  // Preserve both sides of a detected disagreement before using the remaining
  // packet budget for ordinary relevance ranking.
  for (const retrieval of retrievals) {
    const strongHits = qualifyingFacetHits(retrieval.facet, retrieval.hits);
    const conflictCitations = new Set(
      numericConflictGroups(evidenceFromHits(strongHits))
        .flatMap((conflict) => conflict.citations),
    );
    for (const hit of strongHits) {
      if (conflictCitations.has(citationForHit(hit))) add(hit);
    }
  }

  // Give each facet one directly qualifying passage. If none qualifies, keep
  // at most one weaker related passage so partial support remains inspectable.
  // Never fill the packet merely because unused evidence budget remains.
  for (const retrieval of retrievals) {
    const qualified = qualifyingFacetHits(retrieval.facet, retrieval.hits);
    const first = qualified[0]
      ?? relatedFacetHits(retrieval.facet, retrieval.hits)[0];
    if (first) add(first);
  }
  const ranked = retrievals
    .flatMap((retrieval) =>
      qualifyingFacetHits(retrieval.facet, retrieval.hits))
    .sort((a, b) => b.score - a.score
      || a.documentId.localeCompare(b.documentId)
      || a.lineStart - b.lineStart);
  for (const hit of ranked) add(hit);
  return [...selected.values()].sort((a, b) => b.score - a.score
    || a.documentId.localeCompare(b.documentId)
    || a.lineStart - b.lineStart);
}

function assessEvidenceFacet(
  facet: AnswerFacet,
  hits: SearchChunk[],
): EvidenceFacetCoverage {
  const queryTokens = facetSupportTokens(facet.question);
  const queryTokenSet = new Set(queryTokens);
  const scored = hits.map((hit) => {
    const evidenceTokens = new Set(tokenize(hit.text));
    const matchedTokens = queryTokens.filter((token) =>
      evidenceTokens.has(token));
    return {
      hit,
      matchedTokens,
      tokenCoverage: queryTokens.length > 0
        ? matchedTokens.length / queryTokens.length
        : 0,
    };
  });
  const related = scored.filter((item) => item.matchedTokens.length > 0);
  const minimumMatches = Math.min(2, queryTokens.length);
  const strong = related.filter((item) =>
    item.matchedTokens.length >= minimumMatches
    && item.tokenCoverage >= SUPPORTED_PASSAGE_TOKEN_COVERAGE);
  const citable = strong.length > 0 ? strong : related;
  const citations = unique(citable.map((item) => citationForHit(item.hit)));
  const conflicts = numericConflictGroups(
    evidenceFromHits(strong.map((item) => item.hit)),
  );
  if (conflicts.length > 0) {
    return {
      id: facet.id,
      question: facet.question,
      status: "conflicting",
      citations: unique(conflicts.flatMap((conflict) => conflict.citations)),
    };
  }
  if (related.length === 0 || queryTokenSet.size === 0) {
    return {
      id: facet.id,
      question: facet.question,
      status: "unsupported",
      citations: [],
    };
  }

  const unionMatches = new Set(strong.flatMap((item) => item.matchedTokens));
  const unionCoverage = queryTokens.length > 0
    ? unionMatches.size / queryTokens.length
    : 0;
  const bestPassageCoverage = strong.reduce(
    (best, item) => Math.max(best, item.tokenCoverage),
    0,
  );
  const answerSeeking = facet.explicit || looksLikeAnswerRequest(facet.question);
  const supported = answerSeeking
    && strong.length > 0
    && unionMatches.size >= minimumMatches
    && unionCoverage >= SUPPORTED_UNION_TOKEN_COVERAGE
    && bestPassageCoverage >= SUPPORTED_PASSAGE_TOKEN_COVERAGE;
  if (supported) {
    return {
      id: facet.id,
      question: facet.question,
      status: "supported",
      citations,
    };
  }
  return {
    id: facet.id,
    question: facet.question,
    status: "partially_supported",
    citations,
  };
}

function qualifyingFacetHits(
  facet: AnswerFacet,
  hits: SearchChunk[],
): SearchChunk[] {
  const queryTokens = facetSupportTokens(facet.question);
  const minimumMatches = Math.min(2, queryTokens.length);
  if (minimumMatches === 0) return [];
  return hits.filter((hit) => {
    const evidenceTokens = new Set(tokenize(hit.text));
    const matched = queryTokens.filter((token) =>
      evidenceTokens.has(token)).length;
    return matched >= minimumMatches
      && matched / queryTokens.length >= SUPPORTED_PASSAGE_TOKEN_COVERAGE;
  });
}

function relatedFacetHits(
  facet: AnswerFacet,
  hits: SearchChunk[],
): SearchChunk[] {
  const queryTokens = facetSupportTokens(facet.question);
  if (queryTokens.length === 0) return [];
  return hits.filter((hit) => {
    const evidenceTokens = new Set(tokenize(hit.text));
    return queryTokens.some((token) => evidenceTokens.has(token));
  });
}

function aggregateFacetCoverage(
  facets: EvidenceFacetCoverage[],
): EvidencePacket["coverage"] {
  if (facets.length > 0 && facets.every((facet) =>
    facet.status === "supported")) {
    return "sufficient";
  }
  if (facets.every((facet) => facet.status === "unsupported")) return "none";
  return "partial";
}

function facetSupportTokens(value: string): string[] {
  return unique(tokenize(value).filter((token) =>
    !FACET_INSTRUCTION_TOKENS.has(token)));
}

function looksLikeAnswerRequest(value: string): boolean {
  return /\?$/.test(value.trim())
    || /^(?:what|why|how|when|where|who|which|whether|do|does|did|is|are|can|could|should|would|will|explain|describe|compare|identify)\b/i
      .test(value.trim());
}

function searchHitKey(hit: SearchChunk): string {
  return `${hit.documentId}:${hit.lineStart}:${hit.lineEnd}`;
}

function citationForHit(hit: SearchChunk): string {
  return `[${hit.documentId}#L${hit.lineStart}-L${hit.lineEnd}]`;
}

function evidenceFromHits(hits: SearchChunk[]): EvidenceExcerpt[] {
  return hits
    .filter((hit) => hit.kind === "source")
    .map((hit) => ({
      citation: citationForHit(hit),
      sourceId: hit.documentId,
      title: hit.title,
      text: hit.text,
    }));
}

interface NumericConflictGroup {
  unit: string;
  values: string[];
  citations: string[];
}

function numericConflictGroups(
  evidence: EvidenceExcerpt[],
): NumericConflictGroup[] {
  const quantities = new Map<
    string,
    Map<string, { sourceIds: Set<string>; citations: Set<string> }>
  >();
  for (const item of evidence) {
    for (const match of item.text.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(?:-| )?(seconds?|minutes?|hours?|days?|percent|%|degrees?)(?=\b|\s|[.,;:!?)]|$)/gi,
    )) {
      const value = String(Number(match[1]!));
      const unit = match[2]!.toLowerCase()
        .replace(/s$/, "")
        .replace("percent", "%");
      const byValue = quantities.get(unit)
        ?? new Map<string, { sourceIds: Set<string>; citations: Set<string> }>();
      const support = byValue.get(value) ?? {
        sourceIds: new Set<string>(),
        citations: new Set<string>(),
      };
      support.sourceIds.add(item.sourceId);
      support.citations.add(item.citation);
      byValue.set(value, support);
      quantities.set(unit, byValue);
    }
  }

  const conflicts: NumericConflictGroup[] = [];
  for (const [unit, byValue] of quantities) {
    if (byValue.size < 2) continue;
    const independentSources = new Set(
      [...byValue.values()].flatMap((support) => [...support.sourceIds]),
    );
    if (independentSources.size < 2) continue;
    conflicts.push({
      unit,
      values: [...byValue.keys()],
      citations: unique([...byValue.values()]
        .flatMap((support) => [...support.citations])),
    });
  }
  return conflicts;
}

function evidenceWarnings(
  evidence: EvidenceExcerpt[],
): EvidencePacket["warnings"] {
  const warnings: EvidencePacket["warnings"] = [];
  const sourceIds = unique(evidence.map((item) => item.sourceId));
  if (sourceIds.length > 1) warnings.push("compare_independent_sources");
  if (evidence.some((item) =>
    /\b(?:ignore|disregard)\b.{0,40}\b(?:instructions?|messages?|prompts?)\b|(?:system|assistant)\s+message/i
      .test(item.text))) {
    warnings.push("source_instructions_detected");
  }
  if (numericConflictGroups(evidence).length > 0) {
    warnings.push("possible_numeric_conflict");
  }
  return warnings;
}
