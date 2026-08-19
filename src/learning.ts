import type {
  CardRecord,
  CompactConceptCapsule,
  ConceptCapsule,
  ConceptRecord,
  EvidenceExcerpt,
  GoalRecord,
  GroundingMode,
  MisconceptionRecord,
  ReviewRecord,
  SearchChunk,
  StudyState,
} from "./types.js";
import {
  KnowledgeService,
  compactConceptCapsule,
  tokenize,
} from "./knowledge.js";
import { StudyStore } from "./store.js";
import { clamp, newId, nowIso, unique } from "./util.js";

const DAY_MS = 86_400_000;
const MASTERY_PRIOR_ATTEMPTS = 2;
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

export class LearningService {
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
    const concepts = await this.knowledge.lookupConcepts(question, 2);
    const answerFacets = buildAnswerFacets(question, requestedFacets);
    const facetRetrievals: FacetRetrieval[] = [];
    for (const facet of answerFacets) {
      const facetConcepts = await this.knowledge.lookupConcepts(
        facet.retrievalQuery,
        2,
      );
      const routedConcepts = mergeConceptCapsules(facetConcepts, concepts);
      facetRetrievals.push({
        facet,
        hits: await this.routedEvidence(
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

  async preparePractice(input: {
    topic: string;
    count: number;
    difficulty: "introductory" | "intermediate" | "advanced" | "adaptive";
    formats?: Array<"recall" | "explain" | "application" | "calculation" | "compare" | "debug">;
    includeSolutions?: boolean;
  }): Promise<Record<string, unknown>> {
    const count = clamp(Math.round(input.count), 1, 30);
    const concepts = await this.knowledge.lookupConcepts(input.topic, 2);
    const hits = await this.routedEvidence(
      input.topic,
      concepts,
      Math.min(5, Math.max(3, Math.ceil(count / 2))),
    );
    if (hits.length === 0) {
      throw new Error("No vault evidence matches this topic. Ingest relevant resources before generating grounded practice.");
    }
    const state = await this.store.readState();
    const priorities = prioritizeConcepts(state);
    const matchingConceptIds = new Set(concepts.map((concept) => concept.key));
    const focus = priorities.find((item) =>
      matchingConceptIds.has(item.concept.id));
    const formats = input.formats && input.formats.length > 0
      ? unique(input.formats)
      : ["recall", "explain", "application", "compare"] as const;
    const recommendedFormats = focus
      ? practiceFormatsFor(focus.concept)
      : [...formats];
    const effectiveDifficulty = input.difficulty === "adaptive" && focus
      ? difficultyFor(focus.concept)
      : input.difficulty;
    const focusCapsule = focus
      ? concepts.find((concept) => concept.key === focus.concept.id)
        ?? (await this.knowledge.lookupConcepts(focus.concept.id, 1))[0]
      : undefined;
    const evidence = this.knowledge.evidenceExcerpts(hits);
    return {
      task: {
        count,
        difficulty: effectiveDifficulty,
        formats: input.formats && input.formats.length > 0
          ? unique([...formats, ...recommendedFormats])
          : recommendedFormats,
        solutions: Boolean(input.includeSolutions),
      },
      ...(focusCapsule
        ? {
            focus: {
              ...compactConceptCapsule(focusCapsule),
              strategy: strategyFor(focus!.concept),
            },
          }
        : {}),
      evidence,
      warnings: evidenceWarnings(evidence),
    };
  }

  private async routedEvidence(
    query: string,
    concepts: ConceptCapsule[],
    limit: number,
  ): Promise<SearchChunk[]> {
    const sourceIds = await this.knowledge
      .sourceIdsForConcepts(concepts.map((concept) => concept.key));
    const routed = sourceIds.size > 0
      ? await this.knowledge.search(query, limit, "sources", { sourceIds })
      : [];
    if (routed.filter((hit) => hit.score >= 2).length >= Math.min(2, limit)) {
      return routed;
    }
    const broader = await this.knowledge.search(query, limit, "sources");
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

  async createCards(cards: Array<{
    front: string;
    back: string;
    conceptId?: string;
    sourceIds?: string[];
    tags?: string[];
  }>): Promise<CardRecord[]> {
    if (cards.length === 0 || cards.length > 50) {
      throw new Error("Create between 1 and 50 cards at a time.");
    }
    const now = nowIso();
    return this.store.mutate((state) => {
      const created = cards.map((input): CardRecord => {
        const front = input.front.trim();
        const back = input.back.trim();
        if (!front || !back) throw new Error("Every card needs a non-empty front and back.");
        if (front.length > 500 || back.length > 2_000) {
          throw new Error("Flashcard fronts must be at most 500 characters and backs at most 2,000 characters.");
        }
        const sourceIds = unique(input.sourceIds ?? []);
        const unknownSources = sourceIds.filter((id) => !state.sources.some((source) => source.id === id));
        if (unknownSources.length > 0) throw new Error(`Unknown source IDs: ${unknownSources.join(", ")}`);
        if (input.conceptId && !state.concepts.some((concept) => concept.id === input.conceptId)) {
          throw new Error(`Unknown concept ID: ${input.conceptId}`);
        }
        return {
          id: newId("card"),
          front,
          back,
          conceptId: input.conceptId,
          sourceIds,
          tags: unique((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
          createdAt: now,
          dueAt: now,
          intervalDays: 0,
          easeFactor: 2.5,
          repetitions: 0,
          lapses: 0,
          suspended: false,
        };
      });
      state.cards.push(...created);
      return created;
    });
  }

  async reviewQueue(
    limit?: number,
    conceptId?: string,
    cardId?: string,
  ): Promise<CardRecord[]> {
    const config = await this.store.getConfig();
    const state = await this.store.readState();
    const now = Date.now();
    return state.cards
      .filter((card) => !card.suspended
        && (card.id === cardId || Date.parse(card.dueAt) <= now)
        && (!cardId || card.id === cardId)
        && (!conceptId || card.conceptId === conceptId))
      .sort((a, b) => {
        const aConcept = state.concepts.find((concept) => concept.id === a.conceptId);
        const bConcept = state.concepts.find((concept) => concept.id === b.conceptId);
        const masteryDifference = (aConcept?.mastery ?? 0) - (bConcept?.mastery ?? 0);
        return masteryDifference !== 0 ? masteryDifference : Date.parse(a.dueAt) - Date.parse(b.dueAt);
      })
      .slice(0, clamp(limit ?? config.dailyReviewLimit, 1, 200));
  }

  async recordReview(input: {
    cardId: string;
    grade: number;
    elapsedMs?: number;
    note?: string;
  }): Promise<{ card: CardRecord; review: ReviewRecord; concept?: ConceptRecord }> {
    const grade = Math.round(input.grade);
    if (grade < 0 || grade > 5) throw new Error("Grade must be an integer from 0 to 5.");
    return this.store.mutate((state) => {
      const card = state.cards.find((candidate) => candidate.id === input.cardId);
      if (!card) throw new Error(`Unknown card ID: ${input.cardId}`);
      const previousIntervalDays = card.intervalDays;
      if (grade < 3) {
        card.repetitions = 0;
        card.intervalDays = grade <= 1 ? 0.04 : 1;
        card.lapses += 1;
      } else {
        if (card.repetitions === 0) card.intervalDays = 1;
        else if (card.repetitions === 1) card.intervalDays = 6;
        else card.intervalDays = Math.max(1, Math.round(card.intervalDays * card.easeFactor));
        card.repetitions += 1;
      }
      card.easeFactor = clamp(
        card.easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)),
        1.3,
        3.0,
      );
      card.dueAt = new Date(Date.now() + card.intervalDays * DAY_MS).toISOString();

      const review: ReviewRecord = {
        id: newId("review"),
        cardId: card.id,
        grade,
        reviewedAt: nowIso(),
        ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        previousIntervalDays,
        nextIntervalDays: card.intervalDays,
      };
      state.reviews.push(review);

      const concept = card.conceptId
        ? state.concepts.find((candidate) => candidate.id === card.conceptId)
        : undefined;
      if (concept) {
        const performance = grade / 5;
        const weight = masteryEvidenceWeight(concept.attempts);
        concept.mastery = Number(clamp(concept.mastery * (1 - weight) + performance * weight, 0, 1).toFixed(3));
        concept.confidence = Number(clamp(1 - Math.exp(-(concept.attempts + 1) / 5), 0, 1).toFixed(3));
        concept.attempts += 1;
        if (grade >= 3) concept.correct += 1;
        concept.lastStudiedAt = review.reviewedAt;
        if (review.note) {
          concept.notes.push(review.note);
          if (grade < 3) upsertMisconception(concept, review.note, review.reviewedAt);
        }
      }
      return { card: { ...card }, review, ...(concept ? { concept: { ...concept } } : {}) };
    });
  }

  async gradeAttempt(input: {
    conceptId: string;
    score: number;
    maxScore: number;
    misconception?: string;
  }): Promise<ConceptRecord> {
    if (!(input.maxScore > 0) || input.score < 0 || input.score > input.maxScore) {
      throw new Error("Score must be between zero and a positive maxScore.");
    }
    return this.store.mutate((state) => {
      const concept = state.concepts.find((candidate) => candidate.id === input.conceptId);
      if (!concept) throw new Error(`Unknown concept ID: ${input.conceptId}`);
      const performance = input.score / input.maxScore;
      const weight = masteryEvidenceWeight(concept.attempts);
      concept.mastery = Number(clamp(concept.mastery * (1 - weight) + performance * weight, 0, 1).toFixed(3));
      concept.confidence = Number(clamp(1 - Math.exp(-(concept.attempts + 1) / 5), 0, 1).toFixed(3));
      concept.attempts += 1;
      if (performance >= 0.6) concept.correct += 1;
      concept.lastStudiedAt = nowIso();
      if (input.misconception?.trim()) {
        const misconception = input.misconception.trim();
        concept.notes.push(misconception);
        upsertMisconception(concept, misconception, concept.lastStudiedAt);
      }
      return { ...concept };
    });
  }

  async resolveMisconception(input: {
    conceptId: string;
    misconceptionId: string;
  }): Promise<MisconceptionRecord> {
    return this.store.mutate((state) => {
      const concept = state.concepts.find((candidate) => candidate.id === input.conceptId);
      if (!concept) throw new Error(`Unknown concept ID: ${input.conceptId}`);
      const misconception = concept.misconceptions.find((candidate) =>
        candidate.id === input.misconceptionId);
      if (!misconception) {
        throw new Error(
          `Unknown misconception ID '${input.misconceptionId}' for concept '${input.conceptId}'.`,
        );
      }
      misconception.resolvedAt = nowIso();
      return { ...misconception };
    });
  }

  async setGoal(input: {
    title: string;
    conceptIds: string[];
    targetMastery: number;
    deadline?: string;
    minutesPerWeek: number;
  }): Promise<GoalRecord> {
    if (input.targetMastery <= 0 || input.targetMastery > 1) {
      throw new Error("targetMastery must be greater than 0 and at most 1.");
    }
    if (input.deadline && Number.isNaN(Date.parse(input.deadline))) {
      throw new Error("deadline must be an ISO date or datetime.");
    }
    return this.store.mutate((state) => {
      const conceptIds = unique(input.conceptIds);
      const missing = conceptIds.filter((id) => !state.concepts.some((concept) => concept.id === id));
      if (missing.length > 0) throw new Error(`Unknown concept IDs: ${missing.join(", ")}`);
      const goal: GoalRecord = {
        id: newId("goal"),
        title: input.title.trim(),
        conceptIds,
        targetMastery: input.targetMastery,
        ...(input.deadline ? { deadline: new Date(input.deadline).toISOString() } : {}),
        minutesPerWeek: Math.round(input.minutesPerWeek),
        status: "active",
        createdAt: nowIso(),
      };
      if (!goal.title || goal.minutesPerWeek < 1) {
        throw new Error("Goal title and positive minutesPerWeek are required.");
      }
      state.goals.push(goal);
      return goal;
    });
  }

  async planSession(minutes: number): Promise<Record<string, unknown>> {
    const duration = clamp(Math.round(minutes), 10, 240);
    const state = await this.store.readState();
    const dueCount = state.cards.filter((card) =>
      !card.suspended && Date.parse(card.dueAt) <= Date.now()).length;
    const priorities = prioritizeConcepts(state).slice(0, 5);
    const priorityConcepts = priorities.map((item) => item.concept);
    const focus = priorities[0];
    const focusMisconception = focus
      ? activeMisconceptions(focus.concept)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
      : undefined;
    const reviewMinutes = dueCount > 0
      ? Math.min(Math.round(duration * 0.4), Math.max(5, dueCount * 2))
      : 0;
    const learnMinutes = Math.max(0, Math.round(duration * 0.35));
    const practiceMinutes = Math.max(5, duration - reviewMinutes - learnMinutes - 5);
    return {
      durationMinutes: duration,
      strategy: "retrieval_repair_interleave_reflect",
      dueCards: dueCount,
      blocks: [
        {
          minutes: reviewMinutes,
          activity: "Spaced retrieval",
          action: `Use get_review_queue one card at a time for up to ${dueCount} due cards; grade each from 0–5.`,
        },
        {
          minutes: learnMinutes,
          activity: "Repair the highest-priority concept",
          action: focus
            ? `Explain ${focus.concept.title.slice(0, 200)} from memory, compare against cited raw evidence, and ${focusMisconception ? `diagnose this recurring misconception: "${focusMisconception.text.slice(0, 240)}"` : "record one uncertainty or corrected misconception"}.`
            : "Ingest a source and create the first cited concept page.",
          conceptId: focus?.concept.id,
          priorityScore: focus?.score,
          misconceptionId: focusMisconception?.id,
        },
        {
          minutes: practiceMinutes,
          activity: "Interleaved practice",
          action: priorityConcepts.length > 0
            ? `Generate ${practiceFormatsFor(priorityConcepts[0]!).join(", ")} questions across ${priorityConcepts.slice(0, 3).map((concept) => concept.title.slice(0, 120)).join(", ")}.`
            : "Generate a calibrated mix of recall and application questions from the ingested source.",
          conceptIds: priorityConcepts.slice(0, 3).map((concept) => concept.id),
        },
        {
          minutes: 5,
          activity: "Close the loop",
          action: "Grade attempts, capture misconceptions, and state the next concrete study action.",
        },
      ].filter((block) => block.minutes > 0),
      activeGoals: state.goals
        .filter((goal) => goal.status === "active")
        .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"))
        .slice(0, 3)
        .map(({ id, title, targetMastery, deadline }) => ({
          id,
          title,
          targetMastery,
          ...(deadline ? { deadline } : {}),
        })),
      activeGoalCount: state.goals.filter((goal) => goal.status === "active").length,
      priorityConcepts: priorities.map((item) => ({
        id: item.concept.id,
        title: item.concept.title.slice(0, 200),
        mastery: item.concept.mastery,
        confidence: item.concept.confidence,
        attempts: item.concept.attempts,
        priorityScore: item.score,
        activeMisconceptions: activeMisconceptions(item.concept)
          .slice(0, 2)
          .map(({ id, text, occurrences }) => ({
            id,
            text: text.slice(0, 240),
            occurrences,
          })),
      })),
    };
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

interface PrioritizedConcept {
  concept: ConceptRecord;
  score: number;
  signals: string[];
}

function prioritizeConcepts(state: StudyState, now = Date.now()): PrioritizedConcept[] {
  return state.concepts
    .map((concept) => {
      const masteryGap = 1 - concept.mastery;
      const confidenceGap = 1 - concept.confidence;
      const daysSinceStudy = concept.lastStudiedAt
        ? Math.max(0, (now - Date.parse(concept.lastStudiedAt)) / DAY_MS)
        : Number.POSITIVE_INFINITY;
      const recencyPressure = Number.isFinite(daysSinceStudy)
        ? clamp(daysSinceStudy / 30, 0, 1)
        : 1;
      const misconceptions = activeMisconceptions(concept);
      const misconceptionPressure = clamp(
        misconceptions.reduce((total, item) => total + item.occurrences, 0),
        0,
        1,
      );
      const goalPressure = conceptGoalPressure(concept, state.goals, now);
      const score = Number((
        masteryGap * 0.35
        + confidenceGap * 0.2
        + recencyPressure * 0.15
        + misconceptionPressure * 0.2
        + goalPressure * 0.1
      ).toFixed(4));
      const signals = [
        `mastery ${Math.round(concept.mastery * 100)}%`,
        `confidence ${Math.round(concept.confidence * 100)}%`,
        Number.isFinite(daysSinceStudy)
          ? `last studied ${Math.round(daysSinceStudy)} day${Math.round(daysSinceStudy) === 1 ? "" : "s"} ago`
          : "never studied",
        ...(misconceptions.length > 0
          ? [`${misconceptions.length} active misconception${misconceptions.length === 1 ? "" : "s"}`]
          : []),
        ...(goalPressure > 0 ? ["below an active goal target"] : []),
      ];
      return { concept, score, signals };
    })
    .sort((a, b) => b.score - a.score
      || a.concept.mastery - b.concept.mastery
      || a.concept.title.localeCompare(b.concept.title));
}

function conceptGoalPressure(
  concept: ConceptRecord,
  goals: GoalRecord[],
  now: number,
): number {
  let pressure = 0;
  for (const goal of goals) {
    if (goal.status !== "active" || !goal.conceptIds.includes(concept.id)) continue;
    const gap = clamp(goal.targetMastery - concept.mastery, 0, 1);
    let urgency = 0.35;
    if (goal.deadline) {
      const daysRemaining = (Date.parse(goal.deadline) - now) / DAY_MS;
      urgency = daysRemaining <= 7 ? 1 : daysRemaining <= 30 ? 0.7 : 0.4;
    }
    pressure = Math.max(pressure, gap * urgency);
  }
  return pressure;
}

function activeMisconceptions(concept: ConceptRecord): MisconceptionRecord[] {
  return concept.misconceptions.filter((item) => !item.resolvedAt);
}

function upsertMisconception(
  concept: ConceptRecord,
  text: string,
  recordedAt: string,
): void {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const existing = concept.misconceptions.find((item) =>
    item.text.toLowerCase().replace(/\s+/g, " ").trim() === normalized);
  if (existing) {
    existing.occurrences += 1;
    existing.recordedAt = recordedAt;
    delete existing.resolvedAt;
    return;
  }
  concept.misconceptions.push({
    id: newId("mis"),
    text,
    recordedAt,
    occurrences: 1,
  });
}

function masteryEvidenceWeight(attempts: number): number {
  return attempts < 5
    ? 1 / (attempts + MASTERY_PRIOR_ATTEMPTS + 1)
    : 0.2;
}

function difficultyFor(
  concept: ConceptRecord,
): "introductory" | "intermediate" | "advanced" {
  if (concept.mastery < 0.35 || concept.attempts < 2) return "introductory";
  if (concept.mastery < 0.75 || concept.confidence < 0.65) return "intermediate";
  return "advanced";
}

function practiceFormatsFor(
  concept: ConceptRecord,
): Array<"recall" | "explain" | "application" | "calculation" | "compare" | "debug"> {
  if (activeMisconceptions(concept).length > 0) {
    return ["debug", "explain", "application"];
  }
  if (concept.attempts < 2 || concept.mastery < 0.35) {
    return ["recall", "explain", "application"];
  }
  if (concept.mastery < 0.75 || concept.confidence < 0.65) {
    return ["explain", "application", "compare"];
  }
  return ["application", "compare", "debug"];
}

function strategyFor(
  concept: ConceptRecord,
): "misconception_repair" | "foundation" | "consolidation" | "transfer" {
  if (activeMisconceptions(concept).length > 0) {
    return "misconception_repair";
  }
  if (concept.attempts < 2 || concept.mastery < 0.35) {
    return "foundation";
  }
  if (concept.mastery < 0.75 || concept.confidence < 0.65) {
    return "consolidation";
  }
  return "transfer";
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
