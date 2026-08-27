#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKernel } from "../kernel.js";
import type { KnowledgeRepairMode } from "../repair/knowledge.js";
import { RepairService } from "../repair/service.js";
import { createStudyServer } from "../mcp/server.js";
import { StudyStore } from "../vault/store.js";
import { METIS_VERSION } from "../shared/version.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "repair" || command === "update") {
    await runRepairCommand(process.argv.slice(3));
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${METIS_VERSION}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return;
  }
  if (command) {
    throw new Error(`Unknown Metis command '${command}'.\n\n${helpText()}`);
  }

  const root = defaultVaultRoot();
  const { server } = await createStudyServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runRepairCommand(args: string[]): Promise<void> {
  let dryRun = false;
  let mode: KnowledgeRepairMode = "incremental";
  let vaultRoot = defaultVaultRoot();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--full") {
      mode = "full";
    } else if (argument === "--vault") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--vault requires a directory path.");
      vaultRoot = value;
      index += 1;
    } else if (argument.startsWith("--vault=")) {
      const value = argument.slice("--vault=".length).trim();
      if (!value) throw new Error("--vault requires a directory path.");
      vaultRoot = value;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(repairHelpText());
      return;
    } else {
      throw new Error(`Unknown repair option '${argument}'.\n\n${repairHelpText()}`);
    }
  }

  const store = new StudyStore(vaultRoot);
  await store.initialize();
  const kernel = createKernel(store);
  const repair = new RepairService(store, kernel.knowledgeRepair, kernel.wiki);
  const result = await repair.repair({ dryRun, mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function defaultVaultRoot(): string {
  return process.env.METIS_VAULT_PATH?.trim() || process.cwd();
}

function helpText(): string {
  return `Metis ${METIS_VERSION}\n\nUsage:\n  metis                 Start the MCP stdio server\n  metis repair [options] Repair and migrate a study vault\n  metis update [options] Backward-compatible alias for repair\n  metis --version       Print the Metis version\n\n${repairHelpText()}`;
}

function repairHelpText(): string {
  return "Repair options:\n  --vault <path>  Vault directory (defaults to METIS_VAULT_PATH or cwd)\n  --dry-run       Verify and report planned work without repairing\n  --full          Rebuild every derived search index instead of reusing valid entries\n";
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Metis failed:\n${message}\n`);
  process.exitCode = 1;
});
