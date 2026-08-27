import {
  KnowledgeService,
  type KnowledgeRepairMode,
  type KnowledgeRepairResult,
  type WikiLintResult,
} from "../ingestion/knowledge.js";
import { SEARCH_INDEX_DERIVATION_VERSION } from "../search/retrieval.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_STATE_SCHEMA_VERSION,
} from "../contracts/schema.js";
import {
  METIS_SKILL_BUNDLE_VERSION,
  syncMetisSkills,
  type SkillSyncResult,
} from "./skills.js";
import { StudyStore, type VaultUpdateResult } from "../vault/store.js";
import { atomicWrite, messageOf, nowIso, sha256 } from "../shared/util.js";
import { METIS_VERSION } from "../shared/version.js";

export interface VaultRepairResult {
  metisVersion: string;
  vaultRoot: string;
  mode: KnowledgeRepairMode;
  dryRun: boolean;
  repaired: boolean;
  backupRelativePath?: string;
  migration: {
    previousStateVersion: number;
    previousConfigVersion: number;
    stateVersion: number;
    configVersion: number;
    targetStateVersion: number;
    targetConfigVersion: number;
    required: boolean;
    actions: string[];
  };
  skills: SkillSyncResult;
  knowledge?: KnowledgeRepairResult;
  knowledgeInspectionDeferred?: string;
  wikiHealth?: WikiLintResult;
}

export class RepairService {
  constructor(
    private readonly store: StudyStore,
    private readonly knowledge: KnowledgeService,
  ) {}

  async repair(options: {
    dryRun?: boolean;
    mode?: KnowledgeRepairMode;
  } = {}): Promise<VaultRepairResult> {
    const dryRun = options.dryRun ?? false;
    const mode = options.mode ?? "incremental";
    if (dryRun) return this.preview(mode);

    let update: VaultUpdateResult | undefined;
    try {
      update = await this.store.updateVault({ deferKnowledgeRefresh: true });
      const knowledge = await this.knowledge.repairKnowledge({ mode });
      const wikiHealth = await this.knowledge.lintWiki({ log: false });
      if (!wikiHealth.healthy) {
        const errors = wikiHealth.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.page}: ${issue.message}`)
          .join(" | ");
        throw new Error(`Wiki repair did not reach a healthy state. ${errors}`);
      }
      const skills = await syncMetisSkills(this.store);
      await this.store.appendLog("repair", "Metis vault repair", [
        `Metis version: ${METIS_VERSION}`,
        `State schema: v${update.previousStateVersion} → v${update.stateVersion}`,
        `Config schema: v${update.previousConfigVersion} → v${update.configVersion}`,
        `Knowledge mode: ${mode}`,
        `Search indexes reused: ${knowledge.searchIndex.reused}`,
        `Search indexes rebuilt: ${knowledge.searchIndex.rebuilt}`,
        `Evidence stubs rebuilt: ${knowledge.wiki.evidenceStubsRebuilt}`,
        `Derived text verified: ${knowledge.derivedText.verified}/${knowledge.derivedText.expected}`,
        ...(knowledge.derivedText.upgraded > 0
          ? [`Derived text checksummed: ${knowledge.derivedText.upgraded}`]
          : []),
        ...(knowledge.derivedText.missingSourceIds.length > 0
          ? [`Derived text missing for: ${knowledge.derivedText.missingSourceIds.join(", ")}. Line citations into these sources cannot be resolved until the cache is restored from a backup.`]
          : []),
        `Skill bundle: v${skills.version}`,
        `Backup: \`${update.backupRelativePath}\``,
        "Raw sources were checksum-verified and not modified.",
      ]);
      await this.writeRepairManifest(mode, update.backupRelativePath!);
      return {
        metisVersion: METIS_VERSION,
        vaultRoot: this.store.root,
        mode,
        dryRun: false,
        repaired: true,
        backupRelativePath: update.backupRelativePath,
        migration: migrationSummary(update),
        skills,
        knowledge,
        wikiHealth,
      };
    } catch (error) {
      if (!update?.backupRelativePath) throw error;
      try {
        await this.store.restoreVaultBackup(update.backupRelativePath);
      } catch (restoreError) {
        throw new Error(
          `Metis repair failed and rollback also failed. Repair error: ${messageOf(error)} Rollback error: ${messageOf(restoreError)} Manual backup: ${update.backupRelativePath}`,
        );
      }
      throw new Error(
        `Metis repair failed; managed state and wiki files were restored from '${update.backupRelativePath}'. ${messageOf(error)}`,
      );
    }
  }

  private async preview(mode: KnowledgeRepairMode): Promise<VaultRepairResult> {
    const update = await this.store.updateVault({
      dryRun: true,
      deferKnowledgeRefresh: true,
    });
    const skills = await syncMetisSkills(this.store, { dryRun: true });
    const schemasCurrent = update.stateVersion === CURRENT_STATE_SCHEMA_VERSION
      && update.configVersion === CURRENT_CONFIG_SCHEMA_VERSION;
    if (!schemasCurrent) {
      return {
        metisVersion: METIS_VERSION,
        vaultRoot: this.store.root,
        mode,
        dryRun: true,
        repaired: false,
        migration: migrationSummary(update),
        skills,
        knowledgeInspectionDeferred:
          "Knowledge verification and rebuild planning will run after the required schema migrations.",
      };
    }
    const knowledge = await this.knowledge.repairKnowledge({ mode, dryRun: true });
    const wikiHealth = await this.knowledge.lintWiki({ log: false });
    return {
      metisVersion: METIS_VERSION,
      vaultRoot: this.store.root,
      mode,
      dryRun: true,
      repaired: false,
      migration: migrationSummary(update),
      skills,
      knowledge,
      wikiHealth,
    };
  }

  private async writeRepairManifest(
    mode: KnowledgeRepairMode,
    backupRelativePath: string,
  ): Promise<void> {
    const skillManifestChecksum = sha256(await this.store.readText(
      ".metis/skills/manifest.json",
    ));
    const target = await this.store.resolveForWrite(".metis/repair.json");
    await atomicWrite(target, `${JSON.stringify({
      metisVersion: METIS_VERSION,
      repairedAt: nowIso(),
      stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      configSchemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      skillBundleVersion: METIS_SKILL_BUNDLE_VERSION,
      skillManifestChecksum,
      searchIndexDerivationVersion: SEARCH_INDEX_DERIVATION_VERSION,
      knowledgeMode: mode,
      backupRelativePath,
    }, null, 2)}\n`);
  }
}

function migrationSummary(
  update: VaultUpdateResult,
): VaultRepairResult["migration"] {
  return {
    previousStateVersion: update.previousStateVersion,
    previousConfigVersion: update.previousConfigVersion,
    stateVersion: update.dryRun
      ? update.targetStateVersion
      : update.stateVersion,
    configVersion: update.dryRun
      ? update.targetConfigVersion
      : update.configVersion,
    targetStateVersion: update.targetStateVersion,
    targetConfigVersion: update.targetConfigVersion,
    required: update.updateWasRequired,
    actions: update.actions,
  };
}
