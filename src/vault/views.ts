import type {
  Dashboard,
  KnowledgeGraph,
  StudyState,
} from "../contracts/types.js";
import { clamp, nowIso } from "../shared/util.js";

/**
 * Read-only projections over a state snapshot.
 *
 * These answer "what is in this vault" rather than changing it, so they are
 * pure functions of a snapshot the caller already loaded, not store methods
 * that read state a second time.
 */
export function dashboard(state: StudyState): Dashboard {
  return {
    generatedAt: nowIso(),
    counts: {
      sources: state.sources.length,
      wikiPages: state.wikiPages.length,
      concepts: state.concepts.length,
    },
  };
}

export function knowledgeGraph(
  state: StudyState,
  options: {
    focusId?: string;
    limit?: number;
    includeMermaid?: boolean;
  } = {},
): KnowledgeGraph {
  const nodes: KnowledgeGraph["nodes"] = [
    ...state.concepts.map((concept) => ({
      id: concept.id,
      type: "concept" as const,
      label: concept.title.slice(0, 120),
    })),
    ...state.sources.map((source) => ({
      id: source.id,
      type: "source" as const,
      label: source.title.slice(0, 120),
    })),
  ];
  const edges: KnowledgeGraph["edges"] = [];
  for (const page of state.wikiPages) {
    for (const link of page.links) {
      if (state.concepts.some((concept) => concept.id === link)) {
        edges.push({ from: page.slug, to: link, type: "relates_to" });
      }
    }
    for (const sourceId of page.sourceIds) {
      edges.push({ from: page.slug, to: sourceId, type: "supported_by" });
    }
  }
  const limit = clamp(Math.round(options.limit ?? 30), 1, 75);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (options.focusId && !nodesById.has(options.focusId)) {
    throw new Error(`Unknown graph focus ID: ${options.focusId}`);
  }
  const selectedIds = new Set<string>();
  if (options.focusId) {
    const queue = [options.focusId];
    while (queue.length > 0 && selectedIds.size < limit) {
      const current = queue.shift()!;
      if (selectedIds.has(current) || !nodesById.has(current)) continue;
      selectedIds.add(current);
      const neighbors = edges.flatMap((edge) => {
        if (edge.from === current) return [edge.to];
        if (edge.to === current) return [edge.from];
        return [];
      });
      for (const neighbor of neighbors) {
        if (!selectedIds.has(neighbor)) queue.push(neighbor);
      }
    }
  } else {
    for (const node of nodes.slice(0, limit)) selectedIds.add(node.id);
  }
  const selectedNodes = [...selectedIds]
    .map((id) => nodesById.get(id))
    .filter((node): node is KnowledgeGraph["nodes"][number] => Boolean(node));
  const connectingEdges = edges.filter((edge) =>
    selectedIds.has(edge.from) && selectedIds.has(edge.to));
  const selectedEdges = connectingEdges.slice(0, 150);
  const mermaid = options.includeMermaid
    ? renderMermaidGraph(selectedNodes, selectedEdges)
    : undefined;
  return {
    generatedAt: nowIso(),
    totalNodes: nodes.length,
    totalEdges: edges.length,
    truncated: selectedNodes.length < nodes.length
      || selectedEdges.length < connectingEdges.length,
    nodes: selectedNodes,
    edges: selectedEdges,
    ...(mermaid ? { mermaid } : {}),
  };
}

function renderMermaidGraph(
  nodes: KnowledgeGraph["nodes"],
  edges: KnowledgeGraph["edges"],
): string {
  const identifiers = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const mermaidNodes = nodes.map((node) => {
    const detail = node.type === "concept" ? " · concept" : " · source";
    return `  ${identifiers.get(node.id)}["${mermaidLabel(`${node.label}${detail}`)}"]:::${node.type}`;
  });
  const mermaidEdges = edges.flatMap((edge) => {
    const from = identifiers.get(edge.from);
    const to = identifiers.get(edge.to);
    return from && to
      ? [`  ${from} -->|${edge.type.replaceAll("_", " ")}| ${to}`]
      : [];
  });
  return [
    "flowchart LR",
    ...mermaidNodes,
    ...mermaidEdges,
    "  classDef concept fill:#e8eefc,stroke:#2457c5,color:#17202a;",
    "  classDef source fill:#f2f4f4,stroke:#7b8a8b,color:#17202a;",
  ].join("\n");
}

function mermaidLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "'").replaceAll("\n", " ");
}
