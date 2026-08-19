export type GroundingMode = "sources_only" | "sources_first" | "open";

export interface StudyConfig {
  schemaVersion: 1;
  name: string;
  createdAt: string;
  groundingDefault: GroundingMode;
  dailyReviewLimit: number;
}

export interface SourceRecord {
  id: string;
  title: string;
  kind: "text" | "markdown" | "pdf" | "data" | "latex";
  relativePath: string;
  checksum: string;
  tags: string[];
  ingestedAt: string;
  originalPath?: string;
}

export interface WikiPageRecord {
  slug: string;
  title: string;
  summary: string;
  aliases: string[];
  sourceIds: string[];
  links: string[];
  tags: string[];
  updatedAt: string;
}

export interface MisconceptionRecord {
  id: string;
  text: string;
  recordedAt: string;
  occurrences: number;
  resolvedAt?: string;
}

export interface ConceptRecord {
  id: string;
  title: string;
  mastery: number;
  confidence: number;
  attempts: number;
  correct: number;
  lastStudiedAt?: string;
  notes: string[];
  misconceptions: MisconceptionRecord[];
  sourceIds: string[];
}

export interface CardRecord {
  id: string;
  front: string;
  back: string;
  conceptId?: string;
  sourceIds: string[];
  tags: string[];
  createdAt: string;
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
  suspended: boolean;
}

export interface ReviewRecord {
  id: string;
  cardId: string;
  grade: number;
  reviewedAt: string;
  elapsedMs?: number;
  note?: string;
  previousIntervalDays: number;
  nextIntervalDays: number;
}

export interface GoalRecord {
  id: string;
  title: string;
  conceptIds: string[];
  targetMastery: number;
  deadline?: string;
  minutesPerWeek: number;
  status: "active" | "completed" | "paused";
  createdAt: string;
}

export interface StudyState {
  schemaVersion: 3;
  sources: SourceRecord[];
  wikiPages: WikiPageRecord[];
  concepts: ConceptRecord[];
  cards: CardRecord[];
  reviews: ReviewRecord[];
  goals: GoalRecord[];
}

export interface SearchChunk {
  id: string;
  documentId: string;
  title: string;
  kind: "source" | "wiki";
  text: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  sourceIds: string[];
  uri: string;
}

export interface LearnerConceptOverlay {
  mastery: number;
  confidence: number;
  attempts: number;
  dueCards: number;
  lastStudiedAt?: string;
  activeMisconceptions: Array<Pick<
    MisconceptionRecord,
    "id" | "text" | "occurrences" | "recordedAt"
  >>;
}

export interface ConceptCapsule {
  key: string;
  title: string;
  summary: string;
  aliases: string[];
  related: string[];
  tags: string[];
  sourceIds: string[];
  match: "exact" | "alias" | "fuzzy" | "related";
  learner?: LearnerConceptOverlay;
}

export interface CompactConceptCapsule {
  key: string;
  title: string;
  summary: string;
  match: ConceptCapsule["match"];
  related?: string[];
  learner?: Pick<
    LearnerConceptOverlay,
    "mastery" | "confidence" | "attempts"
  > & {
    dueCards?: number;
    lastStudiedAt?: string;
    activeMisconceptions?: LearnerConceptOverlay["activeMisconceptions"];
  };
}

export interface EvidenceExcerpt {
  citation: string;
  sourceId: string;
  title: string;
  text: string;
}

export interface Dashboard {
  generatedAt: string;
  counts: {
    sources: number;
    wikiPages: number;
    concepts: number;
    cards: number;
    dueCards: number;
    reviews: number;
    activeGoals: number;
  };
  mastery: {
    average: number;
    weakest: Array<Pick<ConceptRecord, "id" | "title" | "mastery" | "attempts">>;
  };
  recentReviews: Array<Pick<
    ReviewRecord,
    "cardId" | "grade" | "reviewedAt" | "elapsedMs"
  >>;
  activeGoals: Array<Pick<
    GoalRecord,
    "id" | "title" | "targetMastery" | "deadline"
  >>;
}

export interface KnowledgeGraph {
  generatedAt: string;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  nodes: Array<{
    id: string;
    type: "concept" | "source" | "goal";
    label: string;
    mastery?: number;
    dueCards?: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: "relates_to" | "supported_by" | "targets";
  }>;
  mermaid?: string;
}
