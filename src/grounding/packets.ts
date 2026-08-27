import path from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { PACKET_CACHE_DIRECTORY } from "../vault/layout.js";
import { StudyStore } from "../vault/store.js";
import { atomicWrite } from "../shared/util.js";

/** Newest packet manifests kept on disk, matching the in-memory ceiling. */
const MAX_PERSISTED_PACKETS = 32;

export interface PacketRecord {
  packetId: string;
  groundingMode: string;
  /**
   * Citation tokens only. Excerpt bodies are deliberately absent: a token plus
   * a checksum-verified source is enough to rehydrate the text, and storing
   * bodies would make the cache a second, unverified copy of the evidence.
   */
  citations: string[];
  createdAt: string;
}

/**
 * On-disk citation manifests for evidence packets, so packet reuse survives a
 * reconnect instead of depending on a process-lifetime map.
 *
 * This is grounding's own cache, not vault state: a manifest is a bounded
 * convenience, every failure is a miss that costs the caller nothing but a
 * second full evidence list, and nothing else in the vault reads it.
 */
export class PacketStore {
  constructor(private readonly store: StudyStore) {}

  /**
   * Persist one evidence packet's citation manifest, so packet reuse survives a
   * restart instead of depending on a process-lifetime map. Packets are a
   * bounded convenience, so a write failure is reported by absence on the next
   * read rather than failing the answer that produced it.
   */
  async save(record: PacketRecord): Promise<boolean> {
    try {
      await atomicWrite(
        await this.store.resolveForWrite(packetRecordRelativePath(record.packetId)),
        `${JSON.stringify(record)}\n`,
      );
      await this.prune();
      return true;
    } catch {
      return false;
    }
  }

  async read(packetId: string): Promise<PacketRecord | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(packetId)) return undefined;
    try {
      const raw = await this.store.readText(packetRecordRelativePath(packetId));
      const value = JSON.parse(raw) as {
        packetId?: unknown;
        groundingMode?: unknown;
        citations?: unknown;
        createdAt?: unknown;
      };
      if (
        value.packetId !== packetId
        || typeof value.groundingMode !== "string"
        || typeof value.createdAt !== "string"
        || !Array.isArray(value.citations)
        || value.citations.some((citation) => typeof citation !== "string")
      ) {
        return undefined;
      }
      return {
        packetId,
        groundingMode: value.groundingMode,
        citations: value.citations as string[],
        createdAt: value.createdAt,
      };
    } catch {
      return undefined;
    }
  }

  /** Keep the newest manifests, so an unbounded session cannot grow the cache. */
  private async prune(): Promise<void> {
    const directory = path.join(this.store.root, PACKET_CACHE_DIRECTORY);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (entries.length <= MAX_PERSISTED_PACKETS) return;
    const dated = await Promise.all(entries.map(async (entry) => ({
      name: entry.name,
      modifiedMs: await stat(path.join(directory, entry.name))
        .then((stats) => stats.mtimeMs)
        .catch(() => 0),
    })));
    const stale = dated
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(MAX_PERSISTED_PACKETS);
    for (const entry of stale) {
      await unlink(path.join(directory, entry.name)).catch(() => undefined);
    }
  }
}

function packetRecordRelativePath(packetId: string): string {
  return path.posix.join(PACKET_CACHE_DIRECTORY, `${packetId}.json`);
}
