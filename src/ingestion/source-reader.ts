import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { SourceRecord } from "../contracts/types.js";
import {
  descriptorForSource,
  isDerivedTextPersisted,
} from "../contracts/source-types.js";
import { MetisError } from "../shared/errors.js";
import { CONTEXT_LIMITS } from "../shared/limits.js";
import { atomicWrite, nowIso, sha256 } from "../shared/util.js";
import { DERIVED_TEXT_CACHE_DIRECTORY } from "../vault/layout.js";
import { StudyStore } from "../vault/store.js";
import { extractSourceText } from "./extract.js";
import { defaultVisionTranscriber, type VisionTranscriber } from "./vision.js";

function derivedTextRelativePath(checksum: string): string {
  return path.posix.join(DERIVED_TEXT_CACHE_DIRECTORY, `${checksum}.json`);
}

/**
 * The single way anything in Metis reads a stored source.
 *
 * Every read re-verifies the raw copy's SHA-256 before any cached or derived
 * text is trusted, so tampering with a file under `raw/` can never be masked by
 * an earlier read, and a citation can never resolve against modified evidence.
 * Ingestion, search, wiki validation, and repair all go through here rather
 * than reading bytes themselves, which is why it owns the text cache and the
 * derived-text store instead of any one of them.
 */
export class VerifiedSourceReader {
  private readonly sourceTextCache = new Map<string, {
    checksum: string;
    text: string;
  }>();

  readonly transcriber: VisionTranscriber;

  constructor(
    private readonly store: StudyStore,
    transcriber: VisionTranscriber = defaultVisionTranscriber(),
  ) {
    this.transcriber = transcriber;
  }

  /** Remember text a caller already derived, so the next read is free. */
  cacheText(source: SourceRecord, text: string): void {
    this.sourceTextCache.set(source.id, {
      checksum: source.checksum,
      text,
    });
  }

  async readVerifiedBytes(source: SourceRecord): Promise<{
    absolute: string;
    bytes: Buffer;
  }> {
    const absolute = await this.store.resolveExisting(source.relativePath);
    const bytes = await readFile(absolute);
    const actualChecksum = sha256(bytes);
    if (actualChecksum !== source.checksum) {
      throw new MetisError(
        "SOURCE_INTEGRITY_FAILED",
        `Source integrity check failed for '${source.id}': expected ${source.checksum}, received ${actualChecksum}. The immutable raw copy may have been modified.`,
      );
    }
    return { absolute, bytes };
  }

  async readSourceText(source: SourceRecord): Promise<string> {
    // Integrity is verified before any cached text is trusted, so tampering with
    // a raw copy can never be masked by an earlier read.
    const { absolute, bytes } = await this.readVerifiedBytes(source);
    const cached = this.sourceTextCache.get(source.id);
    if (cached?.checksum === source.checksum) return cached.text;
    const descriptor = descriptorForSource(source);
    const persistent = isDerivedTextPersisted(descriptor.method);
    if (persistent) {
      const stored = await this.readDerivedText(source);
      if (stored !== undefined) {
        this.sourceTextCache.set(source.id, {
          checksum: source.checksum,
          text: stored,
        });
        return stored;
      }
      if (descriptor.method === "vision") {
        // Re-running the model would produce a different transcript, so every
        // line citation into this source would silently address different text.
        // Failing loudly keeps a dead citation distinguishable from a moved one.
        throw new MetisError(
          "DERIVED_TEXT_UNRECOVERABLE",
          `The stored transcript for '${source.id}' is missing or failed its integrity check, and an image transcript cannot be reproduced. Restore ${DERIVED_TEXT_CACHE_DIRECTORY} from your own backup; re-transcribing would move every line citation into this source.`,
        );
      }
    }
    const extracted = await extractSourceText({
      descriptor,
      bytes,
      absolutePath: absolute,
      title: source.title,
      transcriber: this.transcriber,
    });
    if (persistent) await this.persistDerivedText(source, extracted.text);
    this.sourceTextCache.set(source.id, {
      checksum: source.checksum,
      text: extracted.text,
    });
    return extracted.text;
  }

  /**
   * Persist text whose derivation is expensive (PDF) or non-deterministic
   * (vision), so repeated reads are cheap and image line citations stay stable.
   * Returns whether a file was written.
   */
  async persistDerivedText(
    source: SourceRecord,
    text: string,
  ): Promise<boolean> {
    if (!isDerivedTextPersisted(source.extraction.method)) return false;
    try {
      await atomicWrite(
        await this.store.resolveForWrite(derivedTextRelativePath(source.checksum)),
        `${JSON.stringify({
          sourceChecksum: source.checksum,
          textChecksum: sha256(text),
          method: source.extraction.method,
          ...(source.extraction.model ? { model: source.extraction.model } : {}),
          extractedAt: source.extraction.extractedAt ?? nowIso(),
          text,
        })}\n`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read stored derived text. An entry is only returned when the text matches
   * its own recorded checksum, so a truncated or edited cache file is
   * indistinguishable from an absent one.
   */
  private async readDerivedText(source: SourceRecord): Promise<string | undefined> {
    try {
      const raw = await this.store.readText(derivedTextRelativePath(source.checksum));
      const value = JSON.parse(raw) as {
        sourceChecksum?: unknown;
        textChecksum?: unknown;
        method?: unknown;
        text?: unknown;
      };
      if (
        value.sourceChecksum !== source.checksum
        || value.method !== source.extraction.method
        || typeof value.text !== "string"
        || value.textChecksum !== sha256(value.text)
      ) {
        return undefined;
      }
      return value.text;
    } catch {
      return undefined;
    }
  }

  async discardDerivedText(checksum: string): Promise<void> {
    try {
      await unlink(await this.store.resolveForWrite(derivedTextRelativePath(checksum)));
    } catch {
      // A missing or unreadable cache entry needs no cleanup.
    }
  }
}

/** A source preview for its generated provenance page, bounded for context. */
export function preview(text: string): string {
  const cleaned = text.trim();
  if (cleaned.length <= CONTEXT_LIMITS.sourcePreviewCharacters) return cleaned;
  return `${cleaned.slice(0, CONTEXT_LIMITS.sourcePreviewCharacters).trimEnd()}\n\n_[Preview truncated; search reads the complete source.]_`;
}
