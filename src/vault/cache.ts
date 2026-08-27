import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { StudyStore } from "./store.js";

/**
 * Remove entries a cache directory no longer needs.
 *
 * Both derived caches are keyed by source checksum, so an entry no state record
 * names can never be read again. Returns how many entries are stale, and
 * removes them unless this is a dry run.
 */
export async function pruneCacheDirectory(
  store: StudyStore,
  relativeDirectory: string,
  expectedEntries: ReadonlySet<string>,
  dryRun: boolean,
): Promise<number> {
  const cacheRoot = await store.resolveExisting(relativeDirectory);
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const stale = entries.filter((entry) =>
    (entry.isFile() || entry.isSymbolicLink())
    && !expectedEntries.has(entry.name));
  if (!dryRun) {
    for (const entry of stale) {
      await unlink(await store.resolveForWrite(
        path.posix.join(relativeDirectory, entry.name),
      ));
    }
  }
  return stale.length;
}
