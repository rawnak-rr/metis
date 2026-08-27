import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Dashboard,
  KnowledgeGraph,
  SourceRecord,
  StudyConfig,
  StudyState,
  WikiPageRecord,
} from "../contracts/types.js";
import { describeExtraction } from "../ingestion/extract.js";
import { migrateConfig, migrateState } from "../contracts/migrations.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_STATE_SCHEMA_VERSION,
  parseStudyConfig,
  parseStudyState,
  schemaVersionOf,
} from "../contracts/schema.js";
import {
  atomicWrite,
  clamp,
  isNodeError,
  messageOf,
  nowIso,
  safeExistingPath,
  safeWritePath,
  sha256,
  stripFrontmatter,
  yamlString,
} from "../shared/util.js";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;
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
const PACKET_RECORD_FORMAT_VERSION = 1 as const;
/** Newest packet manifests kept on disk, matching the in-memory ceiling. */
const MAX_PERSISTED_PACKETS = 32;
const BACKUP_FORMAT_VERSION = 2 as const;
const SUPPORTED_BACKUP_FORMAT_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

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

const EMPTY_STATE: StudyState = {
  schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
  sources: [],
  wikiPages: [],
  concepts: [],
};

export interface VaultInspection {
  vaultRoot: string;
  stateVersion: number;
  configVersion: number;
  targetStateVersion: number;
  targetConfigVersion: number;
  updateRequired: boolean;
  generatedSchemaCurrent: boolean;
  issues: string[];
}

export interface VaultUpdateResult extends VaultInspection {
  dryRun: boolean;
  updated: boolean;
  /** Schema versions found on disk before this call, for migration reporting. */
  previousStateVersion: number;
  previousConfigVersion: number;
  updateWasRequired: boolean;
  backupRelativePath?: string;
  actions: string[];
}

export interface VaultRestoreResult {
  restored: boolean;
  dryRun: boolean;
  restoredFrom: string;
  recoveryBackupRelativePath?: string;
  stateVersion: number;
  configVersion: number;
  actions: string[];
}

export interface VaultBackupSummary {
  relativePath: string;
  createdAt?: string;
  stateVersion?: number;
  configVersion?: number;
  integrity: "valid" | "invalid";
  issue?: string;
}

interface ValidatedBackup {
  root: string;
  stateVersion: number;
  configVersion: number;
  createdAt?: string;
}

export interface ManagedMutationEffects {
  sourcePages?: Array<{ source: SourceRecord; preview: string }>;
  wikiPages?: Array<{ page: WikiPageRecord; markdown: string }>;
  rebuildWikiIndex?: boolean;
  log?: { operation: string; title: string; details?: string[] };
}

export class StudyStore {
  readonly root: string;
  readonly metadataDir: string;
  readonly statePath: string;
  readonly configPath: string;
  private initialization: Promise<StudyConfig> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.metadataDir = path.join(this.root, ".metis");
    this.statePath = path.join(this.metadataDir, "state.json");
    this.configPath = path.join(this.metadataDir, "config.json");
  }

  async initialize(name?: string): Promise<StudyConfig> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce(name).catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initializeOnce(name?: string): Promise<StudyConfig> {
    await mkdir(this.root, { recursive: true });
    await Promise.all([
      mkdir(path.join(this.root, "raw"), { recursive: true }),
      mkdir(path.join(this.root, "wiki"), { recursive: true }),
      mkdir(this.metadataDir, { recursive: true }),
      mkdir(path.join(this.metadataDir, "cache", "search-v1"), {
        recursive: true,
      }),
      mkdir(path.join(this.metadataDir, "cache", "text-v1"), {
        recursive: true,
      }),
      mkdir(path.join(this.metadataDir, "cache", "packets-v1"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      safeExistingPath(this.root, "raw"),
      safeExistingPath(this.root, "wiki"),
      safeExistingPath(this.root, ".metis"),
      safeExistingPath(this.root, SEARCH_INDEX_CACHE_DIRECTORY),
      safeExistingPath(this.root, DERIVED_TEXT_CACHE_DIRECTORY),
      safeExistingPath(this.root, PACKET_CACHE_DIRECTORY),
    ]);
    await Promise.all([
      mkdir(path.join(this.root, "wiki", "concepts"), { recursive: true }),
      mkdir(path.join(this.root, "wiki", "sources"), { recursive: true }),
    ]);
    await Promise.all([
      safeExistingPath(this.root, "wiki/concepts"),
      safeExistingPath(this.root, "wiki/sources"),
    ]);

    return this.enqueueWrite(async () => {
      if (!(await this.exists(this.statePath))) {
        await this.writeStateFile(structuredClone(EMPTY_STATE));
      }

      let config: StudyConfig;
      if (await this.exists(this.configPath)) {
        const rawConfig = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
        config = migrateConfig(rawConfig).value;
      } else {
        config = {
          schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
          name: name?.trim() || path.basename(this.root) || "Study Vault",
          createdAt: nowIso(),
          groundingDefault: "sources_first",
        };
        await this.writeConfigFile(config);
      }

      if (!(await this.exists(path.join(this.root, "wiki", "index.md")))) {
        const rawState = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
        await this.rebuildWikiIndexFile(migrateState(rawState).value);
      }
      if (!(await this.exists(path.join(this.root, "wiki", "log.md")))) {
        await atomicWrite(
          path.join(this.root, "wiki", "log.md"),
          "# Knowledge Log\n\nAppend-only history of study-vault operations.\n",
        );
      }
      if (!(await this.exists(path.join(this.root, "wiki", "SCHEMA.md")))) {
        await atomicWrite(path.join(this.root, "wiki", "SCHEMA.md"), WIKI_SCHEMA);
      }
      return config;
    });
  }

  async getConfig(): Promise<StudyConfig> {
    await this.initialize();
    return this.readConfigFile();
  }

  async updateConfig(update: Partial<Pick<StudyConfig, "name" | "groundingDefault">>): Promise<StudyConfig> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const current = await this.readConfigFile();
      const next = parseStudyConfig({ ...current, ...update });
      await this.writeConfigFile(next);
      return next;
    });
  }

  async readState(): Promise<StudyState> {
    await this.initialize();
    return this.readStateFile();
  }

  async writeState(state: StudyState): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => this.writeStateFile(state));
  }

  async mutate<T>(mutation: (state: StudyState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const state = await this.readStateFile();
      const result = await mutation(state);
      await this.writeStateFile(state);
      return result;
    });
  }

  async mutateManaged<T>(
    mutation: (state: StudyState) => T | Promise<T>,
    effects: (state: StudyState, result: T) =>
      ManagedMutationEffects | Promise<ManagedMutationEffects>,
  ): Promise<T> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const state = await this.readStateFile();
      const result = await mutation(state);
      const requested = await effects(state, result);
      const writes: Array<{ relativePath: string; content: string }> = [];
      for (const item of requested.sourcePages ?? []) {
        writes.push({
          relativePath: path.posix.join("wiki", "sources", `${item.source.id}.md`),
          content: this.sourcePageText(item.source, item.preview),
        });
      }
      for (const item of requested.wikiPages ?? []) {
        writes.push({
          relativePath: path.posix.join("wiki", "concepts", `${item.page.slug}.md`),
          content: this.wikiPageText(item.page, item.markdown),
        });
      }
      if (requested.rebuildWikiIndex) {
        writes.push({
          relativePath: path.posix.join("wiki", "index.md"),
          content: this.wikiIndexText(state),
        });
      }
      if (requested.log) {
        const currentLog = await readFile(
          await safeExistingPath(this.root, path.posix.join("wiki", "log.md")),
          "utf8",
        );
        writes.push({
          relativePath: path.posix.join("wiki", "log.md"),
          content: this.logText(
            currentLog,
            requested.log.operation,
            requested.log.title,
            requested.log.details ?? [],
          ),
        });
      }
      await this.commitManagedMutation(state, writes);
      return result;
    });
  }

  async resolveExisting(relativePath: string): Promise<string> {
    return safeExistingPath(this.root, relativePath);
  }

  async resolveForWrite(relativePath: string): Promise<string> {
    return safeWritePath(this.root, relativePath);
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(await this.resolveExisting(relativePath), "utf8");
  }

  async appendLog(operation: string, title: string, details: string[] = []): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => this.appendLogFile(operation, title, details));
  }

  private async appendLogFile(operation: string, title: string, details: string[] = []): Promise<void> {
    const relativePath = path.posix.join("wiki", "log.md");
    const existingPath = await safeExistingPath(this.root, relativePath);
    const existing = await readFile(existingPath, "utf8");
    await atomicWrite(
      await safeWritePath(this.root, relativePath),
      this.logText(existing, operation, title, details),
    );
  }

  async writeSourcePage(source: SourceRecord, preview: string): Promise<void> {
    await this.writeManagedPage(
      path.posix.join("wiki", "sources", `${source.id}.md`),
      this.sourcePageText(source, preview),
    );
  }

  async writeWikiPage(page: WikiPageRecord, markdown: string): Promise<void> {
    await this.writeManagedPage(
      path.posix.join("wiki", "concepts", `${page.slug}.md`),
      this.wikiPageText(page, markdown),
    );
  }

  private async writeManagedPage(relativePath: string, text: string): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => {
      await atomicWrite(await safeWritePath(this.root, relativePath), text);
    });
  }

  async rebuildWikiIndex(): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => {
      const state = await this.readStateFile();
      await this.rebuildWikiIndexFile(state);
    });
  }

  private async rebuildWikiIndexFile(state: StudyState): Promise<void> {
    await atomicWrite(
      await safeWritePath(this.root, path.posix.join("wiki", "index.md")),
      this.wikiIndexText(state),
    );
  }

  private async refreshWikiConceptFrontmatter(state: StudyState): Promise<void> {
    for (const page of state.wikiPages) {
      const relativePath = path.posix.join(
        "wiki",
        "concepts",
        `${page.slug}.md`,
      );
      const markdown = await readFile(
        await safeExistingPath(this.root, relativePath),
        "utf8",
      );
      await atomicWrite(
        await safeWritePath(this.root, relativePath),
        this.wikiPageText(page, stripFrontmatter(markdown)),
      );
    }
  }

  private wikiIndexText(state: StudyState): string {
    const concepts = [...state.wikiPages]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((page) => `- [[concepts/${page.slug}|${page.title}]] — ${page.summary} (${page.sourceIds.length} source${page.sourceIds.length === 1 ? "" : "s"})`);
    const sources = [...state.sources]
      .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))
      .map((source) => `- [[sources/${source.id}|${source.title}]] — \`${source.id}\` · ${source.tags.join(", ") || "untagged"}`);
    const index = [
      "---",
      `generated: ${yamlString(nowIso())}`,
      `source_count: ${state.sources.length}`,
      `concept_count: ${state.wikiPages.length}`,
      "---",
      "",
      "# Study Wiki",
      "",
      "## Concepts",
      "",
      ...(concepts.length > 0 ? concepts : ["_No concept pages yet._"]),
      "",
      "## Sources",
      "",
      ...(sources.length > 0 ? sources : ["_No sources ingested yet._"]),
      "",
    ].join("\n");
    return index;
  }

  async inspectVault(): Promise<VaultInspection> {
    await this.initialize();
    return this.enqueueWrite(async () => this.inspectVaultFiles());
  }

  async updateVault(options: {
    dryRun?: boolean;
    deferKnowledgeRefresh?: boolean;
  } = {}): Promise<VaultUpdateResult> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const rawState = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      const rawConfig = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      const stateMigration = migrateState(rawState);
      const configMigration = migrateConfig(rawConfig);
      const schemaPath = path.join(this.root, "wiki", "SCHEMA.md");
      const existingSchema = await this.exists(schemaPath)
        ? await readFile(schemaPath, "utf8")
        : "";
      const generatedSchemaCurrent = existingSchema === WIKI_SCHEMA;
      const knowledgeRefreshAction = options.deferKnowledgeRefresh
        ? "Deferred generated knowledge refresh to the repair phase."
        : "Refreshed generated wiki schema, concept frontmatter, and index files.";
      const plannedActions = [
        ...stateMigration.actions,
        ...configMigration.actions,
        "Validated state and configuration against the current runtime schemas.",
        knowledgeRefreshAction,
        "Preserved immutable raw sources without modification.",
      ];
      const base: VaultInspection = {
        vaultRoot: this.root,
        stateVersion: stateMigration.beforeVersion,
        configVersion: configMigration.beforeVersion,
        targetStateVersion: CURRENT_STATE_SCHEMA_VERSION,
        targetConfigVersion: CURRENT_CONFIG_SCHEMA_VERSION,
        updateRequired: stateMigration.beforeVersion !== CURRENT_STATE_SCHEMA_VERSION
          || configMigration.beforeVersion !== CURRENT_CONFIG_SCHEMA_VERSION
          || !generatedSchemaCurrent,
        generatedSchemaCurrent,
        issues: [],
      };
      if (options.dryRun) {
        return {
          ...base,
          dryRun: true,
          updated: false,
          previousStateVersion: base.stateVersion,
          previousConfigVersion: base.configVersion,
          updateWasRequired: base.updateRequired,
          actions: plannedActions,
        };
      }

      const backupRelativePath = await this.backupManagedFiles(
        stateMigration.beforeVersion,
        configMigration.beforeVersion,
      );
      try {
        await this.writeStateFile(stateMigration.value);
        await this.writeConfigFile(configMigration.value);
        await atomicWrite(schemaPath, WIKI_SCHEMA);
        if (!options.deferKnowledgeRefresh) {
          await this.refreshWikiConceptFrontmatter(stateMigration.value);
          await this.rebuildWikiIndexFile(stateMigration.value);
        }
        if (!options.deferKnowledgeRefresh) {
          await this.appendLogFile("update", "Metis vault update", [
            `State schema: v${stateMigration.beforeVersion} → v${stateMigration.afterVersion}`,
            `Config schema: v${configMigration.beforeVersion} → v${configMigration.afterVersion}`,
            `Backup: \`${backupRelativePath}\``,
            "Raw sources were not modified.",
          ]);
        }
      } catch (error) {
        try {
          await this.restoreManagedFiles(
            await this.validateBackup(backupRelativePath),
          );
        } catch (restoreError) {
          throw new Error(
            `Metis schema migration failed and automatic rollback also failed. Migration error: ${messageOf(error)} Rollback error: ${messageOf(restoreError)} Manual backup: ${backupRelativePath}`,
          );
        }
        throw new Error(
          `Metis schema migration failed; managed files were automatically restored from '${backupRelativePath}'. ${messageOf(error)}`,
        );
      }
      return {
        ...base,
        stateVersion: stateMigration.afterVersion,
        configVersion: configMigration.afterVersion,
        updateRequired: false,
        generatedSchemaCurrent: true,
        dryRun: false,
        updated: true,
        previousStateVersion: base.stateVersion,
        previousConfigVersion: base.configVersion,
        updateWasRequired: base.updateRequired,
        backupRelativePath,
        actions: plannedActions,
      };
    });
  }

  async restoreVaultBackup(
    backupRelativePath: string,
    options: { dryRun?: boolean } = {},
  ): Promise<VaultRestoreResult> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const backup = await this.validateBackup(backupRelativePath);
      const actions = [
        `Validated backup '${backupRelativePath}'.`,
        `Restore state schema v${backup.stateVersion} and config schema v${backup.configVersion}.`,
        "Replace managed state, configuration, and wiki files.",
        "Preserve raw sources without modification.",
      ];
      if (options.dryRun) {
        return {
          restored: false,
          dryRun: true,
          restoredFrom: backupRelativePath,
          stateVersion: backup.stateVersion,
          configVersion: backup.configVersion,
          actions,
        };
      }

      const currentState = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      const currentConfig = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      const recoveryBackupRelativePath = await this.backupManagedFiles(
        schemaVersionOf(currentState),
        schemaVersionOf(currentConfig),
      );
      await this.restoreManagedFiles(backup);
      await this.appendLogFile("restore", "Metis vault backup restored", [
        `Restored from: \`${backupRelativePath}\``,
        `Recovery backup of replaced files: \`${recoveryBackupRelativePath}\``,
        "Raw sources were not modified.",
      ]);
      return {
        restored: true,
        dryRun: false,
        restoredFrom: backupRelativePath,
        recoveryBackupRelativePath,
        stateVersion: backup.stateVersion,
        configVersion: backup.configVersion,
        actions,
      };
    });
  }

  async listVaultBackups(): Promise<VaultBackupSummary[]> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const backupsRelative = path.posix.join(".metis", "backups");
      let entries: Dirent<string>[];
      try {
        entries = await readdir(
          await safeExistingPath(this.root, backupsRelative),
          { withFileTypes: true },
        );
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      }
      const summaries = await Promise.all(entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry): Promise<VaultBackupSummary> => {
          const relativePath = path.posix.join(backupsRelative, entry.name);
          try {
            const validated = await this.validateBackup(relativePath);
            return {
              relativePath,
              ...(validated.createdAt !== undefined
                ? { createdAt: validated.createdAt }
                : {}),
              stateVersion: validated.stateVersion,
              configVersion: validated.configVersion,
              integrity: "valid",
            };
          } catch (error) {
            return {
              relativePath,
              integrity: "invalid",
              issue: messageOf(error),
            };
          }
        }));
      return summaries.sort((a, b) =>
        (b.createdAt ?? b.relativePath).localeCompare(a.createdAt ?? a.relativePath));
    });
  }

  private async inspectVaultFiles(): Promise<VaultInspection> {
    const rawState = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
    const rawConfig = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
    const stateVersion = schemaVersionOf(rawState);
    const configVersion = schemaVersionOf(rawConfig);
    const issues: string[] = [];
    try {
      migrateState(rawState);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    try {
      migrateConfig(rawConfig);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    const schemaPath = path.join(this.root, "wiki", "SCHEMA.md");
    const generatedSchemaCurrent = await this.exists(schemaPath)
      && await readFile(schemaPath, "utf8") === WIKI_SCHEMA;
    return {
      vaultRoot: this.root,
      stateVersion,
      configVersion,
      targetStateVersion: CURRENT_STATE_SCHEMA_VERSION,
      targetConfigVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      updateRequired: stateVersion !== CURRENT_STATE_SCHEMA_VERSION
        || configVersion !== CURRENT_CONFIG_SCHEMA_VERSION
        || !generatedSchemaCurrent
        || issues.length > 0,
      generatedSchemaCurrent,
      issues,
    };
  }

  private async backupManagedFiles(
    stateVersion: number,
    configVersion: number,
  ): Promise<string> {
    const metadataRoot = await safeExistingPath(this.root, ".metis");
    const backupsRoot = path.join(metadataRoot, "backups");
    await mkdir(backupsRoot, { recursive: true });
    const canonicalBackupsRoot = await safeExistingPath(this.root, ".metis/backups");
    const directoryName = `${nowIso().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const backupRoot = path.join(canonicalBackupsRoot, directoryName);
    await mkdir(backupRoot);

    const stateSource = await safeExistingPath(this.root, ".metis/state.json");
    const configSource = await safeExistingPath(this.root, ".metis/config.json");
    const wikiSource = await safeExistingPath(this.root, "wiki");
    await Promise.all([
      cp(stateSource, path.join(backupRoot, "state.json")),
      cp(configSource, path.join(backupRoot, "config.json")),
      cp(wikiSource, path.join(backupRoot, "wiki"), { recursive: true }),
    ]);
    // A transcript cannot be re-derived byte-for-byte, so losing it moves every
    // line citation into that source. It belongs in the backup even though the
    // rest of the cache directory is disposable.
    const derivedTextIncluded = await this.backupDerivedText(backupRoot);
    await atomicWrite(
      path.join(backupRoot, "manifest.json"),
      `${JSON.stringify({
        backupFormatVersion: BACKUP_FORMAT_VERSION,
        createdAt: nowIso(),
        vaultRoot: this.root,
        stateVersion,
        configVersion,
        includes: [
          "state.json",
          "config.json",
          "wiki/",
          ...(derivedTextIncluded ? [`${DERIVED_TEXT_CACHE_DIRECTORY}/`] : []),
        ],
        excludes: ["raw/"],
        files: await this.backupChecksums(backupRoot),
      }, null, 2)}\n`,
    );
    return path.posix.join(".metis", "backups", directoryName);
  }

  private async validateBackup(
    backupRelativePath: string,
  ): Promise<ValidatedBackup> {
    const normalized = backupRelativePath.replaceAll("\\", "/");
    if (!/^\.metis\/backups\/[^/]+$/.test(normalized)) {
      throw new Error("Backup path must name one direct child of '.metis/backups/'.");
    }
    const backupRoot = await safeExistingPath(this.root, normalized);
    const manifestPath = await safeExistingPath(
      this.root,
      path.posix.join(normalized, "manifest.json"),
    );
    const statePath = await safeExistingPath(
      this.root,
      path.posix.join(normalized, "state.json"),
    );
    const configPath = await safeExistingPath(
      this.root,
      path.posix.join(normalized, "config.json"),
    );
    await safeExistingPath(this.root, path.posix.join(normalized, "wiki"));
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
    const actualChecksums = await this.backupChecksums(backupRoot);
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
  private async backupDerivedText(backupRoot: string): Promise<boolean> {
    const source = path.join(this.root, DERIVED_TEXT_CACHE_DIRECTORY);
    if (!(await this.directoryExists(source))) return false;
    const target = path.join(backupRoot, DERIVED_TEXT_CACHE_DIRECTORY);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
    return (await listRegularFilesIfPresent(target)).length > 0;
  }

  private async backupChecksums(backupRoot: string): Promise<Record<string, string>> {
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

  private async restoreManagedFiles(backup: ValidatedBackup): Promise<void> {
    const stateText = await readFile(path.join(backup.root, "state.json"), "utf8");
    const configText = await readFile(path.join(backup.root, "config.json"), "utf8");
    const stagedWiki = path.join(
      this.metadataDir,
      `.restore-${randomUUID().slice(0, 12)}-wiki`,
    );
    const replacedWiki = path.join(
      this.metadataDir,
      `.restore-${randomUUID().slice(0, 12)}-previous-wiki`,
    );
    await cp(path.join(backup.root, "wiki"), stagedWiki, { recursive: true });
    await atomicWrite(this.statePath, stateText);
    await atomicWrite(this.configPath, configText);
    await rename(path.join(this.root, "wiki"), replacedWiki);
    try {
      await rename(stagedWiki, path.join(this.root, "wiki"));
    } catch (error) {
      await rename(replacedWiki, path.join(this.root, "wiki")).catch(() => undefined);
      await rm(stagedWiki, { recursive: true, force: true });
      throw error;
    }
    await rm(replacedWiki, { recursive: true, force: true });
    await this.restoreDerivedText(backup);
  }

  /**
   * Restore the backed-up derived-text cache. A backup taken before the cache
   * was covered has none, and in that case the current cache is left alone:
   * deleting it would strand every line citation into a PDF or image source,
   * which is the failure this backup coverage exists to prevent.
   */
  private async restoreDerivedText(backup: ValidatedBackup): Promise<void> {
    const source = path.join(backup.root, DERIVED_TEXT_CACHE_DIRECTORY);
    if (!(await this.directoryExists(source))) return;
    const target = path.join(this.root, DERIVED_TEXT_CACHE_DIRECTORY);
    const staged = path.join(
      this.metadataDir,
      `.restore-${randomUUID().slice(0, 12)}-text`,
    );
    const replaced = path.join(
      this.metadataDir,
      `.restore-${randomUUID().slice(0, 12)}-previous-text`,
    );
    await cp(source, staged, { recursive: true });
    const hadTarget = await this.directoryExists(target);
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
   * Persist one evidence packet's citation manifest, so packet reuse survives a
   * restart instead of depending on a process-lifetime map. Packets are a
   * bounded convenience, so a write failure is reported by absence on the next
   * read rather than failing the answer that produced it.
   */
  async savePacketRecord(record: PacketRecord): Promise<boolean> {
    try {
      await atomicWrite(
        await this.resolveForWrite(packetRecordRelativePath(record.packetId)),
        `${JSON.stringify({
          formatVersion: PACKET_RECORD_FORMAT_VERSION,
          ...record,
        })}\n`,
      );
      await this.prunePacketRecords();
      return true;
    } catch {
      return false;
    }
  }

  async readPacketRecord(packetId: string): Promise<PacketRecord | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(packetId)) return undefined;
    try {
      const raw = await this.readText(packetRecordRelativePath(packetId));
      const value = JSON.parse(raw) as {
        formatVersion?: unknown;
        packetId?: unknown;
        groundingMode?: unknown;
        citations?: unknown;
        createdAt?: unknown;
      };
      if (
        value.formatVersion !== PACKET_RECORD_FORMAT_VERSION
        || value.packetId !== packetId
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
  private async prunePacketRecords(): Promise<void> {
    const directory = path.join(this.root, PACKET_CACHE_DIRECTORY);
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

  async dashboard(): Promise<Dashboard> {
    const state = await this.readState();
    return {
      generatedAt: nowIso(),
      counts: {
        sources: state.sources.length,
        wikiPages: state.wikiPages.length,
        concepts: state.concepts.length,
      },
    };
  }

  async knowledgeGraph(options: {
    focusId?: string;
    limit?: number;
    includeMermaid?: boolean;
  } = {}): Promise<KnowledgeGraph> {
    const state = await this.readState();
    const nodes: KnowledgeGraph["nodes"] = [
      ...state.concepts.map((concept) => ({
        id: concept.id,
        type: "concept" as const,
        label: concept.title.slice(0, 120),
      })),
      ...state.sources.map((source) => ({
        id: source.id,
        type: "source" as const,
        label: source.title.slice(0, 120),
      })),
    ];
    const edges: KnowledgeGraph["edges"] = [];
    for (const page of state.wikiPages) {
      for (const link of page.links) {
        if (state.concepts.some((concept) => concept.id === link)) {
          edges.push({ from: page.slug, to: link, type: "relates_to" });
        }
      }
      for (const sourceId of page.sourceIds) {
        edges.push({ from: page.slug, to: sourceId, type: "supported_by" });
      }
    }
    const limit = clamp(Math.round(options.limit ?? 30), 1, 75);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    if (options.focusId && !nodesById.has(options.focusId)) {
      throw new Error(`Unknown graph focus ID: ${options.focusId}`);
    }
    const selectedIds = new Set<string>();
    if (options.focusId) {
      const queue = [options.focusId];
      while (queue.length > 0 && selectedIds.size < limit) {
        const current = queue.shift()!;
        if (selectedIds.has(current) || !nodesById.has(current)) continue;
        selectedIds.add(current);
        const neighbors = edges.flatMap((edge) => {
          if (edge.from === current) return [edge.to];
          if (edge.to === current) return [edge.from];
          return [];
        });
        for (const neighbor of neighbors) {
          if (!selectedIds.has(neighbor)) queue.push(neighbor);
        }
      }
    } else {
      for (const node of nodes.slice(0, limit)) selectedIds.add(node.id);
    }
    const selectedNodes = [...selectedIds]
      .map((id) => nodesById.get(id))
      .filter((node): node is KnowledgeGraph["nodes"][number] => Boolean(node));
    const connectingEdges = edges.filter((edge) =>
      selectedIds.has(edge.from) && selectedIds.has(edge.to));
    const selectedEdges = connectingEdges.slice(0, 150);
    const mermaid = options.includeMermaid
      ? renderMermaidGraph(selectedNodes, selectedEdges)
      : undefined;
    return {
      generatedAt: nowIso(),
      totalNodes: nodes.length,
      totalEdges: edges.length,
      truncated: selectedNodes.length < nodes.length
        || selectedEdges.length < connectingEdges.length,
      nodes: selectedNodes,
      edges: selectedEdges,
      ...(mermaid ? { mermaid } : {}),
    };
  }

  private sourcePageText(source: SourceRecord, preview: string): string {
    return [
      "---",
      `metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`,
      `id: ${yamlString(source.id)}`,
      `title: ${yamlString(source.title)}`,
      `type: "source"`,
      `ingested: ${yamlString(source.ingestedAt)}`,
      `kind: ${yamlString(source.kind)}`,
      `extraction: ${yamlString(describeExtraction(source))}`,
      `tags: [${source.tags.map(yamlString).join(", ")}]`,
      "---",
      "",
      `# ${source.title}`,
      "",
      `> [!source] Immutable source`,
      `> ID: \`${source.id}\`  `,
      `> Raw file: [${source.relativePath}](../../${source.relativePath})  `,
      `> SHA-256: \`${source.checksum}\``,
      `> Text extraction: \`${describeExtraction(source)}\``,
      "",
      "## Preview",
      "",
      preview.trim() || "_No text preview is available._",
      "",
      "## Notes",
      "",
      "This page records provenance. Create or update concept pages with `upsert_wiki_page` after synthesizing the source.",
      "",
    ].join("\n");
  }

  private wikiPageText(page: WikiPageRecord, markdown: string): string {
    const frontmatter = [
      "---",
      `metis_generated: ${GENERATED_WIKI_FORMAT_VERSION}`,
      `title: ${yamlString(page.title)}`,
      `summary: ${yamlString(page.summary)}`,
      `aliases: [${page.aliases.map(yamlString).join(", ")}]`,
      `updated: ${yamlString(page.updatedAt)}`,
      `sources: [${page.sourceIds.map(yamlString).join(", ")}]`,
      `links: [${page.links.map(yamlString).join(", ")}]`,
      `tags: [${page.tags.map(yamlString).join(", ")}]`,
      "---",
      "",
    ].join("\n");
    return `${frontmatter}${markdown.trim()}\n`;
  }

  private logText(
    existing: string,
    operation: string,
    title: string,
    details: string[],
  ): string {
    const entry = [
      "",
      `## [${nowIso()}] ${operation} | ${title}`,
      "",
      ...details.map((detail) => `- ${detail}`),
      "",
    ].join("\n");
    return `${existing.trimEnd()}\n${entry}`;
  }

  private async commitManagedMutation(
    state: StudyState,
    writes: Array<{ relativePath: string; content: string }>,
  ): Promise<void> {
    parseStudyState(state);
    const seen = new Set<string>();
    const snapshots: Array<{
      absolutePath: string;
      existed: boolean;
      previousContent: string;
    }> = [];
    for (const write of writes) {
      const normalized = write.relativePath.replaceAll("\\", "/");
      if (!normalized.startsWith("wiki/")) {
        throw new Error(`Managed transactions may only write under 'wiki/': ${normalized}`);
      }
      if (seen.has(normalized)) {
        throw new Error(`Managed transaction contains duplicate write '${normalized}'.`);
      }
      seen.add(normalized);
      const absolutePath = await safeWritePath(this.root, normalized);
      const existed = await this.exists(absolutePath);
      const previousContent = existed
        ? await readFile(await safeExistingPath(this.root, normalized), "utf8")
        : "";
      snapshots.push({ absolutePath, existed, previousContent });
    }

    try {
      for (let index = 0; index < writes.length; index += 1) {
        await atomicWrite(snapshots[index]!.absolutePath, writes[index]!.content);
      }
      await this.writeStateFile(state);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const snapshot of [...snapshots].reverse()) {
        try {
          if (snapshot.existed) {
            await atomicWrite(snapshot.absolutePath, snapshot.previousContent);
          } else {
            await unlink(snapshot.absolutePath).catch((unlinkError: unknown) => {
              if (!isNodeError(unlinkError, "ENOENT")) throw unlinkError;
            });
          }
        } catch (rollbackError) {
          rollbackErrors.push(messageOf(rollbackError));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Managed transaction failed and file rollback was incomplete. Original error: ${messageOf(error)} Rollback errors: ${rollbackErrors.join(" | ")}`,
        );
      }
      throw error;
    }
  }

  private async readVersionedFile<T>(
    filePath: string,
    label: "state" | "config",
    expectedVersion: number,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const version = schemaVersionOf(value);
    if (version !== expectedVersion) {
      throw new Error(
        `Vault ${label} schema v${version} requires repair to v${expectedVersion}. Run 'metis repair' or ask the connected LLM to call metis_repair.`,
      );
    }
    return parse(value);
  }

  private async writeVersionedFile<T>(
    filePath: string,
    value: T,
    parse: (value: unknown) => T,
  ): Promise<void> {
    await atomicWrite(filePath, `${JSON.stringify(parse(value), null, 2)}\n`);
  }

  private readStateFile(): Promise<StudyState> {
    return this.readVersionedFile(
      this.statePath,
      "state",
      CURRENT_STATE_SCHEMA_VERSION,
      parseStudyState,
    );
  }

  private readConfigFile(): Promise<StudyConfig> {
    return this.readVersionedFile(
      this.configPath,
      "config",
      CURRENT_CONFIG_SCHEMA_VERSION,
      parseStudyConfig,
    );
  }

  private writeStateFile(state: StudyState): Promise<void> {
    return this.writeVersionedFile(this.statePath, state, parseStudyState);
  }

  private writeConfigFile(config: StudyConfig): Promise<void> {
    return this.writeVersionedFile(this.configPath, config, parseStudyConfig);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(
      () => this.withVaultLock(operation),
      () => this.withVaultLock(operation),
    );
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withVaultLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.metadataDir, "write.lock");
    const token = `${process.pid}:${randomUUID()}`;
    const startedAt = Date.now();
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        let stale = false;
        try {
          const details = await stat(lockPath);
          const oldEnough = Date.now() - details.mtimeMs > STALE_LOCK_MS;
          let ownerActive = false;
          if (oldEnough) {
            try {
              const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
              ownerActive = typeof lock.pid === "number"
                && Number.isInteger(lock.pid)
                && lock.pid > 0
                && processIsAlive(lock.pid);
            } catch {
              ownerActive = false;
            }
          }
          stale = oldEnough && !ownerActive;
        } catch (statError) {
          if (!isNodeError(statError, "ENOENT")) throw statError;
        }
        if (stale) {
          await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!isNodeError(unlinkError, "ENOENT")) throw unlinkError;
          });
          continue;
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for the Metis vault write lock at '${lockPath}'. Another process may still be writing.`,
          );
        }
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      await handle.writeFile(`${JSON.stringify({
        token,
        pid: process.pid,
        acquiredAt: nowIso(),
      })}\n`, "utf8");
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      try {
        const lock = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
        if (lock.token === token) await unlink(lockPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      const details = await stat(filePath);
      return details.isFile();
    } catch {
      return false;
    }
  }

  private async directoryExists(directoryPath: string): Promise<boolean> {
    try {
      return (await stat(directoryPath)).isDirectory();
    } catch {
      return false;
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
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

function packetRecordRelativePath(packetId: string): string {
  return path.posix.join(PACKET_CACHE_DIRECTORY, `${packetId}.json`);
}

function renderMermaidGraph(
  nodes: KnowledgeGraph["nodes"],
  edges: KnowledgeGraph["edges"],
): string {
  const identifiers = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const mermaidNodes = nodes.map((node) => {
    const detail = node.type === "concept" ? " · concept" : " · source";
    return `  ${identifiers.get(node.id)}["${mermaidLabel(`${node.label}${detail}`)}"]:::${node.type}`;
  });
  const mermaidEdges = edges.flatMap((edge) => {
    const from = identifiers.get(edge.from);
    const to = identifiers.get(edge.to);
    return from && to
      ? [`  ${from} -->|${edge.type.replaceAll("_", " ")}| ${to}`]
      : [];
  });
  return [
    "flowchart LR",
    ...mermaidNodes,
    ...mermaidEdges,
    "  classDef concept fill:#e8eefc,stroke:#2457c5,color:#17202a;",
    "  classDef source fill:#f2f4f4,stroke:#7b8a8b,color:#17202a;",
  ].join("\n");
}

function mermaidLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "'").replaceAll("\n", " ");
}

const WIKI_SCHEMA = `# Study Wiki Schema

This vault separates evidence from synthesis so its knowledge stays inspectable.

## Layers

1. \`raw/\` contains immutable source copies. Never edit a file after ingestion; ingest a changed document as a new source.
2. \`wiki/sources/\` contains provenance pages generated from raw sources.
3. \`wiki/concepts/\` contains compiled, cross-linked explanations maintained through the MCP.
4. \`wiki/index.md\` is the content map. \`wiki/log.md\` is the append-only operation timeline.
5. \`.metis/\` contains portable machine state: the source, wiki page, and concept records, the derived-text and search caches, and managed backups.

## Concept page contract

- YAML frontmatter lists title, summary, aliases, updated time, source IDs, links, and tags.
- Every factual prose block includes an inline raw-source line-span token returned by search, such as \`[src_ab12#L8-L14]\`.
- Citation source IDs and ranges must exist, and at least half of each block's distinctive terms must occur in the cited excerpts.
- Direct evidence, inference, contradiction, and open questions are distinguished explicitly.
- Related concepts are linked with Obsidian wikilinks.
- A page is updated when newly ingested evidence changes or challenges its synthesis.

## Answering

- Use the compiled wiki for navigation and synthesis, but use checksum-verified raw sources as the authoritative evidence behind every answer.
- Default to sources-first grounding. Outside knowledge is added only when the vault is insufficient and is clearly labelled.
- Never invent citations.
- Quote numerical results from the cited excerpt. A figure the sources do not contain is derived work, and is labelled as such alongside the evidence it rests on.

## Maintenance

Run the wiki health check after material updates. Resolve missing provenance and broken links first, then connect orphan pages and revisit stale synthesis.
`;
