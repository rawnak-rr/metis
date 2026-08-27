import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SourceRecord,
  StudyConfig,
  StudyState,
  WikiPageRecord,
} from "../contracts/types.js";
import { parseStudyConfig, parseStudyState } from "../contracts/schema.js";
import {
  atomicWrite,
  isNodeError,
  messageOf,
  nowIso,
  safeExistingPath,
  safeWritePath,
} from "../shared/util.js";
import {
  DERIVED_TEXT_CACHE_DIRECTORY,
  PACKET_CACHE_DIRECTORY,
  SEARCH_INDEX_CACHE_DIRECTORY,
} from "./layout.js";
import {
  WIKI_SCHEMA,
  logText,
  sourcePageText,
  wikiIndexText,
  wikiPageText,
} from "./templates.js";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;

const EMPTY_STATE: StudyState = {
  sources: [],
  wikiPages: [],
  concepts: [],
};

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
        config = parseStudyConfig(
          JSON.parse(await readFile(this.configPath, "utf8")) as unknown,
        );
      } else {
        config = {
          name: name?.trim() || path.basename(this.root) || "Study Vault",
          createdAt: nowIso(),
          groundingDefault: "sources_first",
        };
        await this.writeConfigFile(config);
      }

      if (!(await this.exists(path.join(this.root, "wiki", "index.md")))) {
        await this.rebuildWikiIndexFile(await this.readStateFile());
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
          content: sourcePageText(item.source, item.preview),
        });
      }
      for (const item of requested.wikiPages ?? []) {
        writes.push({
          relativePath: path.posix.join("wiki", "concepts", `${item.page.slug}.md`),
          content: wikiPageText(item.page, item.markdown),
        });
      }
      if (requested.rebuildWikiIndex) {
        writes.push({
          relativePath: path.posix.join("wiki", "index.md"),
          content: wikiIndexText(state),
        });
      }
      if (requested.log) {
        const currentLog = await readFile(
          await safeExistingPath(this.root, path.posix.join("wiki", "log.md")),
          "utf8",
        );
        writes.push({
          relativePath: path.posix.join("wiki", "log.md"),
          content: logText(
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
      logText(existing, operation, title, details),
    );
  }

  private async rebuildWikiIndexFile(state: StudyState): Promise<void> {
    await atomicWrite(
      await safeWritePath(this.root, path.posix.join("wiki", "index.md")),
      wikiIndexText(state),
    );
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

  private async readValidatedFile<T>(
    filePath: string,
    parse: (value: unknown) => T,
  ): Promise<T> {
    return parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  }

  private async writeValidatedFile<T>(
    filePath: string,
    value: T,
    parse: (value: unknown) => T,
  ): Promise<void> {
    await atomicWrite(filePath, `${JSON.stringify(parse(value), null, 2)}\n`);
  }

  private readStateFile(): Promise<StudyState> {
    return this.readValidatedFile(this.statePath, parseStudyState);
  }

  private readConfigFile(): Promise<StudyConfig> {
    return this.readValidatedFile(this.configPath, parseStudyConfig);
  }

  private writeStateFile(state: StudyState): Promise<void> {
    return this.writeValidatedFile(this.statePath, state, parseStudyState);
  }

  private writeConfigFile(config: StudyConfig): Promise<void> {
    return this.writeValidatedFile(this.configPath, config, parseStudyConfig);
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}
