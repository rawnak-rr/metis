import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { migrateConfig, migrateState } from "../contracts/migrations.js";
import { schemaVersionOf } from "../contracts/schema.js";
import {
  atomicWrite,
  isNodeError,
  nowIso,
  safeExistingPath,
  sha256,
} from "../shared/util.js";
import {
  DERIVED_TEXT_CACHE_DIRECTORY,
  type VaultPaths,
} from "./layout.js";

const BACKUP_FORMAT_VERSION = 2 as const;
const SUPPORTED_BACKUP_FORMAT_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

export interface ValidatedBackup {
  root: string;
  stateVersion: number;
  configVersion: number;
  createdAt?: string;
}

/**
 * Checksummed managed-file backup and restore.
 *
 * These are the file mechanics only. The store keeps the public entry points,
 * because a backup or restore has to run inside its write queue and vault lock
 * to be atomic against concurrent Metis instances.
 *
 * Raw sources are never copied or replaced: they are immutable, verified by
 * checksum on every read, and far larger than the managed files. The
 * derived-text cache is copied even though the rest of the cache is disposable,
 * because an image transcript cannot be re-derived and losing it moves every
 * line citation into that source.
 */
export async function backupManagedFiles(
  paths: VaultPaths,
  stateVersion: number,
  configVersion: number,
): Promise<string> {
  const metadataRoot = await safeExistingPath(paths.root, ".metis");
  const backupsRoot = path.join(metadataRoot, "backups");
  await mkdir(backupsRoot, { recursive: true });
  const canonicalBackupsRoot = await safeExistingPath(paths.root, ".metis/backups");
  const directoryName = `${nowIso().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const backupRoot = path.join(canonicalBackupsRoot, directoryName);
  await mkdir(backupRoot);

  const stateSource = await safeExistingPath(paths.root, ".metis/state.json");
  const configSource = await safeExistingPath(paths.root, ".metis/config.json");
  const wikiSource = await safeExistingPath(paths.root, "wiki");
  await Promise.all([
    cp(stateSource, path.join(backupRoot, "state.json")),
    cp(configSource, path.join(backupRoot, "config.json")),
    cp(wikiSource, path.join(backupRoot, "wiki"), { recursive: true }),
  ]);
  // A transcript cannot be re-derived byte-for-byte, so losing it moves every
  // line citation into that source. It belongs in the backup even though the
  // rest of the cache directory is disposable.
  const derivedTextIncluded = await backupDerivedText(paths, backupRoot);
  await atomicWrite(
    path.join(backupRoot, "manifest.json"),
    `${JSON.stringify({
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      createdAt: nowIso(),
      vaultRoot: paths.root,
      stateVersion,
      configVersion,
      includes: [
        "state.json",
        "config.json",
        "wiki/",
        ...(derivedTextIncluded ? [`${DERIVED_TEXT_CACHE_DIRECTORY}/`] : []),
      ],
      excludes: ["raw/"],
      files: await backupChecksums(backupRoot),
    }, null, 2)}\n`,
  );
  return path.posix.join(".metis", "backups", directoryName);
}

export async function validateBackup(
  paths: VaultPaths,
  backupRelativePath: string,
): Promise<ValidatedBackup> {
  const normalized = backupRelativePath.replaceAll("\\", "/");
  if (!/^\.metis\/backups\/[^/]+$/.test(normalized)) {
    throw new Error("Backup path must name one direct child of '.metis/backups/'.");
  }
  const backupRoot = await safeExistingPath(paths.root, normalized);
  const manifestPath = await safeExistingPath(
    paths.root,
    path.posix.join(normalized, "manifest.json"),
  );
  const statePath = await safeExistingPath(
    paths.root,
    path.posix.join(normalized, "state.json"),
  );
  const configPath = await safeExistingPath(
    paths.root,
    path.posix.join(normalized, "config.json"),
  );
  await safeExistingPath(paths.root, path.posix.join(normalized, "wiki"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    backupFormatVersion?: unknown;
    createdAt?: unknown;
    stateVersion?: unknown;
    configVersion?: unknown;
    files?: unknown;
  };
  const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const stateVersion = schemaVersionOf(state);
  const configVersion = schemaVersionOf(config);
  migrateState(state);
  migrateConfig(config);
  if (
    typeof manifest.backupFormatVersion !== "number"
    || !SUPPORTED_BACKUP_FORMAT_VERSIONS.has(manifest.backupFormatVersion)
  ) {
    throw new Error("Unsupported or missing Metis backup format version.");
  }
  if (manifest.stateVersion !== stateVersion || manifest.configVersion !== configVersion) {
    throw new Error("Backup manifest versions do not match the backed-up state and config.");
  }
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Backup manifest is missing its managed-file checksum inventory.");
  }
  const expectedChecksums = manifest.files as Record<string, unknown>;
  const actualChecksums = await backupChecksums(backupRoot);
  const expectedEntries = Object.entries(expectedChecksums)
    .sort(([a], [b]) => a.localeCompare(b));
  const actualEntries = Object.entries(actualChecksums)
    .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)) {
    throw new Error("Backup integrity check failed: managed-file checksums do not match.");
  }
  return {
    root: backupRoot,
    stateVersion,
    configVersion,
    ...(typeof manifest.createdAt === "string"
      ? { createdAt: manifest.createdAt }
      : {}),
  };
}

/**
 * Copy the derived-text cache into a backup. Returns whether anything was
 * copied, which is false for a vault with no PDF or image sources.
 */
async function backupDerivedText(
  paths: VaultPaths,
  backupRoot: string,
): Promise<boolean> {
  const source = path.join(paths.root, DERIVED_TEXT_CACHE_DIRECTORY);
  if (!(await directoryExists(source))) return false;
  const target = path.join(backupRoot, DERIVED_TEXT_CACHE_DIRECTORY);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return (await listRegularFilesIfPresent(target)).length > 0;
}

async function backupChecksums(backupRoot: string): Promise<Record<string, string>> {
  const files = [
    path.join(backupRoot, "state.json"),
    path.join(backupRoot, "config.json"),
    ...await listRegularFiles(path.join(backupRoot, "wiki")),
    ...await listRegularFilesIfPresent(
      path.join(backupRoot, DERIVED_TEXT_CACHE_DIRECTORY),
    ),
  ];
  const entries = await Promise.all(files.map(async (filePath) => [
    path.relative(backupRoot, filePath).split(path.sep).join("/"),
    sha256(await readFile(filePath)),
  ] as const));
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export async function restoreManagedFiles(
  paths: VaultPaths,
  backup: ValidatedBackup,
): Promise<void> {
  const stateText = await readFile(path.join(backup.root, "state.json"), "utf8");
  const configText = await readFile(path.join(backup.root, "config.json"), "utf8");
  const stagedWiki = path.join(
    paths.metadataDir,
    `.restore-${randomUUID().slice(0, 12)}-wiki`,
  );
  const replacedWiki = path.join(
    paths.metadataDir,
    `.restore-${randomUUID().slice(0, 12)}-previous-wiki`,
  );
  await cp(path.join(backup.root, "wiki"), stagedWiki, { recursive: true });
  await atomicWrite(paths.statePath, stateText);
  await atomicWrite(paths.configPath, configText);
  await rename(path.join(paths.root, "wiki"), replacedWiki);
  try {
    await rename(stagedWiki, path.join(paths.root, "wiki"));
  } catch (error) {
    await rename(replacedWiki, path.join(paths.root, "wiki")).catch(() => undefined);
    await rm(stagedWiki, { recursive: true, force: true });
    throw error;
  }
  await rm(replacedWiki, { recursive: true, force: true });
  await restoreDerivedText(paths, backup);
}

/**
 * Restore the backed-up derived-text cache. A backup taken before the cache
 * was covered has none, and in that case the current cache is left alone:
 * deleting it would strand every line citation into a PDF or image source,
 * which is the failure this backup coverage exists to prevent.
 */
async function restoreDerivedText(
  paths: VaultPaths,
  backup: ValidatedBackup,
): Promise<void> {
  const source = path.join(backup.root, DERIVED_TEXT_CACHE_DIRECTORY);
  if (!(await directoryExists(source))) return;
  const target = path.join(paths.root, DERIVED_TEXT_CACHE_DIRECTORY);
  const staged = path.join(
    paths.metadataDir,
    `.restore-${randomUUID().slice(0, 12)}-text`,
  );
  const replaced = path.join(
    paths.metadataDir,
    `.restore-${randomUUID().slice(0, 12)}-previous-text`,
  );
  await cp(source, staged, { recursive: true });
  const hadTarget = await directoryExists(target);
  if (hadTarget) await rename(target, replaced);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await rename(staged, target);
  } catch (error) {
    if (hadTarget) {
      await rename(replaced, target).catch(() => undefined);
    }
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  if (hadTarget) await rm(replaced, { recursive: true, force: true });
}

/**
 * Like `listRegularFiles`, but an absent directory is empty rather than an
 * error. A vault with no PDF or image sources has no derived-text cache, and a
 * backup taken before the cache was covered has none either.
 */
async function listRegularFilesIfPresent(root: string): Promise<string[]> {
  try {
    return await listRegularFiles(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function listRegularFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Managed backup cannot contain symbolic link '${absolute}'.`);
    }
    if (entry.isDirectory()) {
      files.push(...await listRegularFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    } else {
      throw new Error(`Managed backup contains unsupported filesystem entry '${absolute}'.`);
    }
  }
  return files;
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}
