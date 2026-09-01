import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ENTAILMENT_SYSTEM_PROMPT,
  entailmentPrompt,
  parseEntailmentVerdicts,
  type EntailmentJudge,
  type EntailmentRequest,
  type EntailmentVerdicts,
} from "../grounding/entailment.js";
import { MetisError } from "../shared/errors.js";
import { messageOf } from "../shared/util.js";
import {
  MAX_VISION_IMAGE_BYTES,
  TRANSCRIPTION_SYSTEM_PROMPT,
  type VisionTranscriber,
} from "../ingestion/vision.js";

const SAMPLING_TIMEOUT_MILLISECONDS = 12_000;
const SAMPLING_MAX_TOKENS = 120;
const VISION_SAMPLING_TIMEOUT_MILLISECONDS = 45_000;
const VISION_SAMPLING_MAX_TOKENS = 8_000;

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

/**
 * A vision transcriber backed by MCP sampling: the connected client picks
 * whichever model it wants to run (its own cheapest vision-capable one, by
 * default) rather than Metis holding a separate Anthropic API key. `fallback`
 * only applies when the client never advertises sampling at all; a sampling
 * call that is attempted and fails (declined consent, timeout, refusal)
 * surfaces as a real error instead of silently spending against a fallback
 * the user did not choose for that call.
 */
export function samplingVisionTranscriber(
  resolveServer: () => Server | undefined,
  options: { fallback?: VisionTranscriber } = {},
): VisionTranscriber {
  return {
    async transcribe(input) {
      const server = resolveServer();
      if (!server?.getClientCapabilities()?.sampling) {
        if (options.fallback) return options.fallback.transcribe(input);
        throw new MetisError(
          "EXTRACT_VISION_UNAVAILABLE",
          `No connected MCP client advertises sampling, so '${input.title}' cannot be transcribed. Connect a client that supports sampling, or configure a fallback vision transcriber.`,
        );
      }
      if (input.bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
        throw new MetisError(
          "INGEST_SOURCE_TOO_LARGE",
          `Images must be at most ${MAX_VISION_IMAGE_BYTES} bytes to transcribe; '${input.title}' is ${input.bytes.byteLength} bytes.`,
        );
      }
      let result: Awaited<ReturnType<typeof server.createMessage>>;
      try {
        result = await server.createMessage({
          systemPrompt: TRANSCRIPTION_SYSTEM_PROMPT,
          // The image itself is the evidence; client-side context would only
          // add unverified material to a transcript stored as citable text.
          includeContext: "none",
          maxTokens: VISION_SAMPLING_MAX_TOKENS,
          temperature: 0,
          messages: [{
            role: "user",
            content: [
              { type: "image", data: input.bytes.toString("base64"), mimeType: input.mediaType },
              { type: "text", text: "Transcribe this image." },
            ],
          }],
        }, { timeout: VISION_SAMPLING_TIMEOUT_MILLISECONDS });
      } catch (error) {
        throw new MetisError(
          "EXTRACT_VISION_FAILED",
          `Sampling transcription of '${input.title}' failed.`,
          { detail: messageOf(error), cause: error },
        );
      }
      if (result.stopReason === "maxTokens") {
        throw new MetisError(
          "EXTRACT_VISION_TRUNCATED",
          `${result.model} hit its output limit before finishing the transcription of '${input.title}'. Split the image into smaller pages and ingest them individually rather than storing partial evidence.`,
        );
      }
      const content = Array.isArray(result.content) ? result.content[0] : result.content;
      const text = content?.type === "text" ? content.text : "";
      if (!text.trim()) {
        throw new MetisError(
          "EXTRACT_VISION_REFUSED",
          `${result.model} returned no transcript for '${input.title}', so it cannot be stored as evidence.`,
        );
      }
      return { text, model: result.model };
    },
  };
}
