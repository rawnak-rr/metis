/**
 * Ceilings on what one MCP response may carry. They exist to keep a reply
 * bounded in a model's context rather than to express a retrieval preference,
 * so they are shared by ingestion previews, search results, and the server.
 */
export const CONTEXT_LIMITS = {
  conceptMatches: 3,
  sourceResultsDefault: 3,
  sourceResultsMaximum: 6,
  sourceChunkCharacters: 1_400,
  sourceSearchTextCharacters: 4_200,
  sourcePreviewCharacters: 800,
  batchSuggestedConcepts: 12,
  batchLogDetailLines: 20,
} as const;
