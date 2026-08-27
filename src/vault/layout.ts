/**
 * Fixed vault-relative locations and format versions.
 *
 * Every one of these is a promise to a vault on disk: change a directory and an
 * existing vault's derived data becomes invisible, change a format version and
 * `metis_repair` has to migrate. They are declared apart from the store so a
 * consumer can name a location without depending on the write protocol.
 */
export const GENERATED_WIKI_FORMAT_VERSION = 2 as const;

/**
 * Text derived from PDF and image sources. It is the only record of where a
 * line citation points for a source whose text cannot be recomputed from the
 * raw bytes, so unlike the search index it is backed up rather than treated as
 * disposable.
 */
export const DERIVED_TEXT_CACHE_DIRECTORY = ".metis/cache/text-v1";
export const SEARCH_INDEX_CACHE_DIRECTORY = ".metis/cache/search-v1";
/** Evidence packet citation manifests, so packet reuse survives a restart. */
export const PACKET_CACHE_DIRECTORY = ".metis/cache/packets-v1";

/** The filesystem facts the backup mechanics need, without the write queue. */
export interface VaultPaths {
  readonly root: string;
  readonly metadataDir: string;
  readonly statePath: string;
  readonly configPath: string;
}
