import type {
  CompactConceptCapsule,
  ConceptCapsule,
  EvidenceExcerpt,
  GroundingMode,
  SearchChunk,
} from "../contracts/types.js";
import { compactConceptCapsule } from "../search/concepts.js";
import { tokenize } from "../shared/lexicon.js";
import {
  SearchService,
  evidenceExcerpts,
  type RetrievalSession,
} from "../search/service.js";
import {
  MAX_JUDGED_PASSAGES,
  type EntailmentJudge,
  type EntailmentRequest,
  type EntailmentVerdicts,
} from "./entailment.js";
import { StudyStore } from "../vault/store.js";
import { PacketStore } from "./packets.js";
import { groundingModeSchema } from "../contracts/schema.js";
import { newId, nowIso, unique } from "../shared/util.js";

const MAX_REUSABLE_CITATIONS = 18;
const MAX_ANSWER_FACETS = 5;
const MAX_ANSWER_EVIDENCE = 6;
const SUPPORTED_UNION_TOKEN_COVERAGE = 0.7;
const SUPPORTED_PASSAGE_TOKEN_COVERAGE = 0.5;
const MAX_BORDERLINE_EVIDENCE = 2;

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
  /**
   * Set when an entailment verdict decided this status instead of token
   * coverage. Omitted for a lexical status, which is the default.
   */
  statusMethod?: "entailment";
  /**
   * Packet citations that did not support this facet, whichever method
   * judged it. Omitted when empty.
   */
  borderlineCitations?: string[];
}

export interface PacketEvidenceExcerpt extends EvidenceExcerpt {
  /**
   * Set when no facet's lexical check confirmed this excerpt. It is present
   * because retrieval ranked it highly for a facet, and the connected model
   * decides whether it supports the answer.
   */
  lexicalSupport?: "related";
}

export interface EvidencePacket {
  packetId: string;
  groundingMode: GroundingMode;
  coverage: "sufficient" | "partial" | "none";
  facets: EvidenceFacetCoverage[];
  concepts: CompactConceptCapsule[];
  evidence: PacketEvidenceExcerpt[];
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

/**
 * What a packet carries forward between turns: the grounding mode it was built
 * under and the citations it already showed. Excerpt bodies are deliberately
 * absent, because a citation plus a checksum-verified source rehydrates the
 * text on demand and storing bodies would make the cache a second, unverified
 * copy of the evidence.
 */
interface CachedEvidencePacket {
  groundingMode: GroundingMode;
  citations: string[];
}

interface AnswerFacet {
  id: string;
  question: string;
  retrievalQuery: string;
  explicit: boolean;
}

type FacetHitTier = "qualifying" | "related" | "unrelated";

interface ScoredFacetHit {
  hit: SearchChunk;
  matchedTokens: string[];
  tokenCoverage: number;
  tier: FacetHitTier;
}

interface FacetRetrieval {
  facet: AnswerFacet;
  scored: ScoredFacetHit[];
}

interface FacetEvidenceSelection {
  hits: SearchChunk[];
  borderlineCitations: Set<string>;
}
export class GroundingService {
  private readonly answerPackets = new Map<string, CachedEvidencePacket>();
  private entailment?: EntailmentJudge;

  constructor(
    private readonly store: StudyStore,
    private readonly search: SearchService,
    private readonly packets: PacketStore,
  ) {}

  /**
   * Wired after the MCP server exists, because a sampling-backed judge
   * depends on the client that connects to it. Grounding stays lexical until
   * then and whenever the judge returns no verdict.
   */
  useEntailmentJudge(judge: EntailmentJudge): void {
    this.entailment = judge;
  }

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
    const retrieval = await this.search.openRetrieval();
    const concepts = retrieval.lookupConcepts(question, 2);
    const answerFacets = buildAnswerFacets(question, requestedFacets);
    const facetRetrievals: FacetRetrieval[] = [];
    for (const facet of answerFacets) {
      const facetConcepts = retrieval.lookupConcepts(facet.retrievalQuery, 2);
      const routedConcepts = mergeConceptCapsules(facetConcepts, concepts);
      facetRetrievals.push({
        facet,
        scored: scoreFacetHits(
          facet,
          await this.routedEvidence(
            retrieval,
            facet.retrievalQuery,
            routedConcepts,
            Math.max(2, evidenceLimit),
          ),
        ),
      });
    }
    const selection = selectFacetEvidence(facetRetrievals, evidenceLimit);
    const selectedHitKeys = new Set(selection.hits.map(searchHitKey));
    const lexicalFacets = facetRetrievals.map(({ facet, scored }) =>
      assessEvidenceFacet(
        facet,
        scored.filter((item) => selectedHitKeys.has(searchHitKey(item.hit))),
      ));
    const facets = applyEntailmentVerdicts(
      lexicalFacets,
      await this.judgeFacets(facetRetrievals, lexicalFacets, selectedHitKeys),
    );
    const coverage = aggregateFacetCoverage(facets);
    const completeEvidence: PacketEvidenceExcerpt[] = evidenceExcerpts(selection.hits)
      .map((item) => selection.borderlineCitations.has(item.citation)
        ? { ...item, lexicalSupport: "related" as const }
        : item);
    const priorPacket = priorPacketId
      ? await this.recallAnswerPacket(priorPacketId)
      : undefined;
    const compatiblePriorPacket = priorPacket?.groundingMode === groundingMode
      ? priorPacket
      : undefined;
    const reusableCitations = new Set(compatiblePriorPacket?.citations ?? []);
    const reusedCitations = completeEvidence
      .filter((item) => reusableCitations.has(item.citation))
      .map((item) => item.citation);
    const evidence = completeEvidence
      .filter((item) => !reusableCitations.has(item.citation));
    const packetId = newId("packet");
    const carriedCitations = unique([
      ...(compatiblePriorPacket?.citations ?? []),
      ...completeEvidence.map((item) => item.citation),
    ]).slice(-MAX_REUSABLE_CITATIONS);
    await this.rememberAnswerPacket(packetId, {
      groundingMode,
      citations: carriedCitations,
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

  /**
   * Ask the connected model whether each packet passage answers its facet.
   * Only passages already in the packet are judged, so a verdict never widens
   * what the caller sees, and a facet decided by a mechanical numeric conflict
   * is left alone.
   */
  private async judgeFacets(
    retrievals: FacetRetrieval[],
    facets: EvidenceFacetCoverage[],
    selectedHitKeys: Set<string>,
  ): Promise<EntailmentVerdicts[]> {
    const judge = this.entailment;
    if (!judge) return [];
    const statusById = new Map(facets.map((facet) => [facet.id, facet.status]));
    const requests: EntailmentRequest[] = retrievals
      .filter((retrieval) =>
        statusById.get(retrieval.facet.id) !== "conflicting")
      .map((retrieval) => ({
        facetId: retrieval.facet.id,
        question: retrieval.facet.question,
        passages: retrieval.scored
          .filter((item) => item.hit.kind === "source"
            && selectedHitKeys.has(searchHitKey(item.hit)))
          .sort((a, b) => compareHits(a.hit, b.hit))
          .slice(0, MAX_JUDGED_PASSAGES)
          .map((item) => ({
            citation: citationForHit(item.hit),
            text: item.hit.text,
          })),
      }))
      .filter((request) => request.passages.length > 0);
    if (requests.length === 0) return [];
    try {
      return await judge.judge(requests);
    } catch {
      return [];
    }
  }

  /**
   * Look up a prior packet, falling back to the vault when this process did not
   * build it. A packet is a bounded convenience, so an unreadable record is a
   * miss and the caller receives full evidence again.
   */
  private async recallAnswerPacket(
    packetId: string,
  ): Promise<CachedEvidencePacket | undefined> {
    const cached = this.answerPackets.get(packetId);
    if (cached) return cached;
    const stored = await this.packets.read(packetId);
    if (!stored) return undefined;
    const groundingMode = groundingModeSchema.safeParse(stored.groundingMode);
    if (!groundingMode.success) return undefined;
    const packet: CachedEvidencePacket = {
      groundingMode: groundingMode.data,
      citations: stored.citations,
    };
    this.answerPackets.set(packetId, packet);
    return packet;
  }

  private async rememberAnswerPacket(
    packetId: string,
    packet: CachedEvidencePacket,
  ): Promise<void> {
    this.answerPackets.set(packetId, packet);
    while (this.answerPackets.size > 32) {
      const oldest = this.answerPackets.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.answerPackets.delete(oldest);
    }
    await this.packets.save({
      packetId,
      groundingMode: packet.groundingMode,
      citations: packet.citations,
      createdAt: nowIso(),
    });
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
): FacetEvidenceSelection {
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
    const strongHits = tieredHits(retrieval, "qualifying");
    const conflictCitations = new Set(
      numericConflictGroups(evidenceFromHits(strongHits))
        .flatMap((conflict) => conflict.citations),
    );
    for (const hit of strongHits) {
      if (conflictCitations.has(citationForHit(hit))) add(hit);
    }
  }

  // Give each facet its best directly qualifying passage. If none qualifies,
  // keep its best related passage so partial support remains inspectable.
  for (const retrieval of retrievals) {
    const ranked = [...retrieval.scored]
      .sort((a, b) => compareHits(a.hit, b.hit));
    const first = ranked.find((item) => item.tier === "qualifying")
      ?? ranked.find((item) => item.tier === "related");
    if (first) add(first.hit);
  }
  for (const hit of rankHits(retrievals.flatMap((retrieval) =>
    tieredHits(retrieval, "qualifying")))) {
    add(hit);
  }

  // Unused budget goes to the best-scoring passages token overlap could not
  // confirm. Excluding them is unrecoverable downstream, since the connected
  // model cannot weigh evidence it never sees, while a bounded number of extra
  // excerpts only costs context.
  let borderlineAdded = 0;
  for (const hit of rankHits(borderlineCandidates(retrievals))) {
    if (borderlineAdded >= MAX_BORDERLINE_EVIDENCE) break;
    if (selected.size >= limit) break;
    if (selected.has(searchHitKey(hit))) continue;
    const before = selected.size;
    add(hit);
    if (selected.size > before) borderlineAdded += 1;
  }

  const confirmed = new Set(retrievals.flatMap((retrieval) =>
    tieredHits(retrieval, "qualifying").map(citationForHit)));
  const hits = rankHits([...selected.values()]);
  return {
    hits,
    borderlineCitations: new Set(hits
      .map(citationForHit)
      .filter((citation) => !confirmed.has(citation))),
  };
}

/**
 * Passages eligible for unused packet budget: everything retrieval returned
 * for a facet that the qualifying passes did not already take. Token overlap
 * decides no part of visibility, because it cannot rank a paraphrase against a
 * decoy that repeats the question's wording; retrieval has already ranked and
 * truncated these candidates, and the packet cap bounds what a weak one costs.
 */
function borderlineCandidates(retrievals: FacetRetrieval[]): SearchChunk[] {
  return retrievals.flatMap((retrieval) => retrieval.scored
    .filter((item) => item.tier !== "qualifying")
    .map((item) => item.hit));
}

function tieredHits(
  retrieval: FacetRetrieval,
  tier: FacetHitTier,
): SearchChunk[] {
  return retrieval.scored
    .filter((item) => item.tier === tier)
    .map((item) => item.hit);
}

function rankHits(hits: SearchChunk[]): SearchChunk[] {
  return [...hits].sort(compareHits);
}

function compareHits(a: SearchChunk, b: SearchChunk): number {
  return b.score - a.score
    || a.documentId.localeCompare(b.documentId)
    || a.lineStart - b.lineStart;
}

/**
 * Tier every retrieved passage against one facet once. Selection and status
 * assessment both read these tiers, so the coverage thresholds are applied in
 * a single place and each passage is tokenized once per facet.
 */
function scoreFacetHits(
  facet: AnswerFacet,
  hits: SearchChunk[],
): ScoredFacetHit[] {
  const queryTokens = facetSupportTokens(facet.question);
  const minimumMatches = Math.min(2, queryTokens.length);
  return hits.map((hit) => {
    const evidenceTokens = new Set(tokenize(hit.text));
    const matchedTokens = queryTokens.filter((token) =>
      evidenceTokens.has(token));
    const tokenCoverage = queryTokens.length > 0
      ? matchedTokens.length / queryTokens.length
      : 0;
    const qualifying = minimumMatches > 0
      && matchedTokens.length >= minimumMatches
      && tokenCoverage >= SUPPORTED_PASSAGE_TOKEN_COVERAGE;
    return {
      hit,
      matchedTokens,
      tokenCoverage,
      tier: qualifying
        ? "qualifying"
        : matchedTokens.length > 0
          ? "related"
          : "unrelated",
    };
  });
}

function assessEvidenceFacet(
  facet: AnswerFacet,
  scored: ScoredFacetHit[],
): EvidenceFacetCoverage {
  const queryTokens = facetSupportTokens(facet.question);
  const minimumMatches = Math.min(2, queryTokens.length);
  const related = scored.filter((item) => item.tier !== "unrelated");
  const strong = scored.filter((item) => item.tier === "qualifying");
  const citable = strong.length > 0 ? strong : related;
  const citations = unique(citable.map((item) => citationForHit(item.hit)));
  const borderline = unique(scored
    .filter((item) => item.tier === "related")
    .map((item) => citationForHit(item.hit)));
  const coverageOf = (
    status: EvidenceFacetStatus,
    statusCitations: string[],
  ): EvidenceFacetCoverage => {
    const unconfirmed = borderline
      .filter((citation) => !statusCitations.includes(citation));
    return {
      id: facet.id,
      question: facet.question,
      status,
      citations: statusCitations,
      ...(unconfirmed.length > 0
        ? { borderlineCitations: unconfirmed }
        : {}),
    };
  };

  const conflicts = numericConflictGroups(
    evidenceFromHits(strong.map((item) => item.hit)),
  );
  if (conflicts.length > 0) {
    return coverageOf(
      "conflicting",
      unique(conflicts.flatMap((conflict) => conflict.citations)),
    );
  }
  if (related.length === 0) return coverageOf("unsupported", []);

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
  return coverageOf(
    supported ? "supported" : "partially_supported",
    citations,
  );
}

/**
 * Replace a lexical status with an entailment verdict where one came back.
 * Citations follow the verdict, so a passage that only repeats the question's
 * wording drops to borderline instead of being cited as support.
 */
function applyEntailmentVerdicts(
  facets: EvidenceFacetCoverage[],
  judged: EntailmentVerdicts[],
): EvidenceFacetCoverage[] {
  if (judged.length === 0) return facets;
  const byFacet = new Map(judged.map((item) => [item.facetId, item.verdicts]));
  return facets.map((facet) => {
    const verdicts = byFacet.get(facet.id);
    if (!verdicts || verdicts.length === 0) return facet;
    const judgedCitations = verdicts.map((item) => item.citation);
    const supported = verdicts
      .filter((item) => item.verdict === "supported")
      .map((item) => item.citation);
    const conflicting = verdicts
      .filter((item) => item.verdict === "conflicting")
      .map((item) => item.citation);
    const citations = conflicting.length > 0
      ? unique([...supported, ...conflicting])
      : supported;
    const borderline = unique([
      ...(facet.borderlineCitations ?? [])
        .filter((citation) => !judgedCitations.includes(citation)),
      ...judgedCitations.filter((citation) => !citations.includes(citation)),
    ]);
    return {
      id: facet.id,
      question: facet.question,
      status: conflicting.length > 0
        ? "conflicting"
        : supported.length > 0
          ? "supported"
          : "unsupported",
      citations,
      statusMethod: "entailment",
      ...(borderline.length > 0 ? { borderlineCitations: borderline } : {}),
    };
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
