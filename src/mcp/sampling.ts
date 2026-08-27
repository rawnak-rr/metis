import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ENTAILMENT_SYSTEM_PROMPT,
  entailmentPrompt,
  parseEntailmentVerdicts,
  type EntailmentJudge,
  type EntailmentRequest,
  type EntailmentVerdicts,
} from "../grounding/entailment.js";

const SAMPLING_TIMEOUT_MILLISECONDS = 12_000;
const SAMPLING_MAX_TOKENS = 120;

/**
 * An entailment judge backed by MCP sampling. The client owns the model and
 * the user's consent prompt, so this asks for capability at call time rather
 * than at construction: a vault opened by the CLI, or by a client without
 * sampling, simply never produces verdicts and grounding stays lexical.
 */
export function samplingEntailmentJudge(
  resolveServer: () => Server | undefined,
): EntailmentJudge {
  return {
    async judge(requests: EntailmentRequest[]): Promise<EntailmentVerdicts[]> {
      const server = resolveServer();
      if (!server?.getClientCapabilities()?.sampling) return [];
      const judged = await Promise.all(requests.map(async (request) => {
        try {
          const result = await server.createMessage({
            systemPrompt: ENTAILMENT_SYSTEM_PROMPT,
            // The vault is the evidence; client-side context would only add
            // unverified text to a support judgment.
            includeContext: "none",
            maxTokens: SAMPLING_MAX_TOKENS,
            temperature: 0,
            messages: [{
              role: "user",
              content: { type: "text", text: entailmentPrompt(request) },
            }],
          }, { timeout: SAMPLING_TIMEOUT_MILLISECONDS });
          const reply = result.content.type === "text" ? result.content.text : "";
          const verdicts = parseEntailmentVerdicts(reply, request.passages);
          return verdicts.length > 0
            ? { facetId: request.facetId, verdicts }
            : undefined;
        } catch {
          // A refused, timed out, or malformed sampling call must not fail the
          // answer; the lexical status already covers this facet.
          return undefined;
        }
      }));
      return judged.filter((item): item is EntailmentVerdicts => Boolean(item));
    },
  };
}
