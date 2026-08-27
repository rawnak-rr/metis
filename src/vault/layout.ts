/**
 * Fixed vault-relative locations.
 *
 * Each one is a promise to a vault on disk: change a directory and an existing
 * vault's derived data becomes invisible. They are declared apart from the
 * store so a consumer can name a location without depending on the write
 * protocol.
 */
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
