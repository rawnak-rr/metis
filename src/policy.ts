/**
 * Grounding rules stated to a model. These reach agents through two unrelated
 * channels — the generated skill bundle written into a vault and the MCP
 * prompt registered by the server — so they are defined once here to keep the
 * two channels from drifting apart.
 */
export const GROUNDING_POLICY = {
  unsupportedFacets:
    "Leave unsupported facets unfilled rather than inferring past the evidence.",
} as const;
