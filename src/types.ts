export type GroundingMode = "sources_only" | "sources_first" | "open";

export interface StudyConfig {
  schemaVersion: 1;
  name: string;
  createdAt: string;
  groundingDefault: GroundingMode;
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

export interface ConceptRecord {
  id: string;
  title: string;
  notes: string[];
  sourceIds: string[];
}

export interface StudyState {
  schemaVersion: 4;
  sources: SourceRecord[];
  wikiPages: WikiPageRecord[];
  concepts: ConceptRecord[];
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

export interface ConceptCapsule {
  key: string;
  title: string;
  summary: string;
  aliases: string[];
  related: string[];
  tags: string[];
  sourceIds: string[];
  match: "exact" | "alias" | "fuzzy" | "related";
}

export interface CompactConceptCapsule {
  key: string;
  title: string;
  summary: string;
  match: ConceptCapsule["match"];
  related?: string[];
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
  };
}

export interface KnowledgeGraph {
  generatedAt: string;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  nodes: Array<{
    id: string;
    type: "concept" | "source";
    label: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: "relates_to" | "supported_by";
  }>;
  mermaid?: string;
}
