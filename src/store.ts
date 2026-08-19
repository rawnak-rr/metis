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
} from "./types.js";
import { describeExtraction } from "./extract.js";
import { migrateConfig, migrateState } from "./migrations.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_STATE_SCHEMA_VERSION,
  parseStudyConfig,
  parseStudyState,
  schemaVersionOf,
} from "./schema.js";
import {
  atomicWrite,
  clamp,
  nowIso,
  safeExistingPath,
  safeWritePath,
  sha256,
  yamlString,
} from "./util.js";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;
export const GENERATED_WIKI_FORMAT_VERSION = 2 as const;

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
    ]);
    await Promise.all([
      safeExistingPath(this.root, "raw"),
      safeExistingPath(this.root, "wiki"),
      safeExistingPath(this.root, ".metis"),
      safeExistingPath(this.root, ".metis/cache/search-v1"),
      safeExistingPath(this.root, ".metis/cache/text-v1"),
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
    await this.initialize();
    await this.enqueueWrite(async () => {
      await atomicWrite(
        await safeWritePath(
          this.root,
          path.posix.join("wiki", "sources", `${source.id}.md`),
        ),
        this.sourcePageText(source, preview),
      );
    });
  }

  async writeWikiPage(page: WikiPageRecord, markdown: string): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => {
      await atomicWrite(
        await safeWritePath(
          this.root,
          path.posix.join("wiki", "concepts", `${page.slug}.md`),
        ),
        this.wikiPageText(page, markdown),
      );
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
        this.wikiPageText(page, stripWikiFrontmatter(markdown)),
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
          await this.restoreManagedFiles(backupRelativePath);
        } catch (restoreError) {
          throw new Error(
            `Metis schema migration failed and automatic rollback also failed. Migration error: ${errorMessage(error)} Rollback error: ${errorMessage(restoreError)} Manual backup: ${backupRelativePath}`,
          );
        }
        throw new Error(
          `Metis schema migration failed; managed files were automatically restored from '${backupRelativePath}'. ${errorMessage(error)}`,
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
      await this.restoreManagedFiles(backupRelativePath);
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
            const manifest = JSON.parse(
              await readFile(path.join(validated.root, "manifest.json"), "utf8"),
            ) as { createdAt?: unknown };
            return {
              relativePath,
              ...(typeof manifest.createdAt === "string"
                ? { createdAt: manifest.createdAt }
                : {}),
              stateVersion: validated.stateVersion,
              configVersion: validated.configVersion,
              integrity: "valid",
            };
          } catch (error) {
            return {
              relativePath,
              integrity: "invalid",
              issue: errorMessage(error),
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
    await atomicWrite(
      path.join(backupRoot, "manifest.json"),
      `${JSON.stringify({
        backupFormatVersion: 1,
        createdAt: nowIso(),
        vaultRoot: this.root,
        stateVersion,
        configVersion,
        includes: ["state.json", "config.json", "wiki/"],
        excludes: ["raw/"],
        files: await this.backupChecksums(backupRoot),
      }, null, 2)}\n`,
    );
    return path.posix.join(".metis", "backups", directoryName);
  }

  private async validateBackup(backupRelativePath: string): Promise<{
    root: string;
    stateVersion: number;
    configVersion: number;
  }> {
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
    if (manifest.backupFormatVersion !== 1) {
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
    return { root: backupRoot, stateVersion, configVersion };
  }

  private async backupChecksums(backupRoot: string): Promise<Record<string, string>> {
    const files = [
      path.join(backupRoot, "state.json"),
      path.join(backupRoot, "config.json"),
      ...await listRegularFiles(path.join(backupRoot, "wiki")),
    ];
    const entries = await Promise.all(files.map(async (filePath) => [
      path.relative(backupRoot, filePath).split(path.sep).join("/"),
      sha256(await readFile(filePath)),
    ] as const));
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  private async restoreManagedFiles(backupRelativePath: string): Promise<void> {
    const backup = await this.validateBackup(backupRelativePath);
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
          rollbackErrors.push(errorMessage(rollbackError));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Managed transaction failed and file rollback was incomplete. Original error: ${errorMessage(error)} Rollback errors: ${rollbackErrors.join(" | ")}`,
        );
      }
      throw error;
    }
  }

  private async readStateFile(): Promise<StudyState> {
    const value = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
    const version = schemaVersionOf(value);
    if (version !== CURRENT_STATE_SCHEMA_VERSION) {
      throw new Error(
        `Vault state schema v${version} requires repair to v${CURRENT_STATE_SCHEMA_VERSION}. Run 'metis repair' or ask the connected LLM to call metis_repair.`,
      );
    }
    return parseStudyState(value);
  }

  private async readConfigFile(): Promise<StudyConfig> {
    const value = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
    const version = schemaVersionOf(value);
    if (version !== CURRENT_CONFIG_SCHEMA_VERSION) {
      throw new Error(
        `Vault config schema v${version} requires repair to v${CURRENT_CONFIG_SCHEMA_VERSION}. Run 'metis repair' or ask the connected LLM to call metis_repair.`,
      );
    }
    return parseStudyConfig(value);
  }

  private async writeStateFile(state: StudyState): Promise<void> {
    const validated = parseStudyState(state);
    await atomicWrite(this.statePath, `${JSON.stringify(validated, null, 2)}\n`);
  }

  private async writeConfigFile(config: StudyConfig): Promise<void> {
    const validated = parseStudyConfig(config);
    await atomicWrite(this.configPath, `${JSON.stringify(validated, null, 2)}\n`);
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
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
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
    "  classDef goal fill:#fff3cd,stroke:#c58a00,color:#17202a;",
  ].join("\n");
}

function mermaidLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "'").replaceAll("\n", " ");
}

function stripWikiFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

const WIKI_SCHEMA = `# Study Wiki Schema

This vault separates evidence from synthesis so its knowledge stays inspectable.

## Layers

1. \`raw/\` contains immutable source copies. Never edit a file after ingestion; ingest a changed document as a new source.
2. \`wiki/sources/\` contains provenance pages generated from raw sources.
3. \`wiki/concepts/\` contains compiled, cross-linked explanations maintained through the MCP.
4. \`wiki/index.md\` is the content map. \`wiki/log.md\` is the append-only operation timeline.
5. \`.metis/\` contains portable machine state for reviews, mastery, and goals.

## Concept page contract

- YAML frontmatter lists title, summary, aliases, updated time, source IDs, links, and tags.
- Every factual prose block includes an inline raw-source line-span token returned by search, such as \`[src_ab12#L8-L14]\`.
- Citation source IDs and ranges must exist, and at least half of each block's distinctive terms must occur in the cited excerpts.
- Direct evidence, inference, contradiction, and open questions are distinguished explicitly.
- Related concepts are linked with Obsidian wikilinks.
- A page is updated when newly ingested evidence changes or challenges its synthesis.

## Answering

- Use the compiled wiki for navigation and synthesis, but use checksum-verified raw sources as authoritative answer and practice evidence.
- Default to sources-first grounding. Outside knowledge is added only when the vault is insufficient and is clearly labelled.
- Never invent citations.
- Verify all numerical mathematics through the Python verifier before presenting results.

## Learning loop

- Retrieval precedes rereading.
- Practice mixes recall, explanation, application, comparison, debugging, and transfer.
- Reviews and scored attempts update calibrated mastery; structured misconceptions retain recurrence and resolution as adaptive study signals.
- Session plans prioritize due reviews, active goals, and low-mastery concepts.

## Maintenance

Run the wiki health check after material updates. Resolve missing provenance and broken links first, then connect orphan pages and revisit stale synthesis.
`;
