#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStudyServer } from "../mcp/server.js";
import { METIS_VERSION } from "../shared/version.js";

async function main(): Promise<void> {
  const command = process.argv[2];
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

  const { server } = await createStudyServer(defaultVaultRoot());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function defaultVaultRoot(): string {
  return process.env.METIS_VAULT_PATH?.trim() || process.cwd();
}

function helpText(): string {
  return `Metis ${METIS_VERSION}\n\nUsage:\n  metis            Start the MCP stdio server\n  metis --version  Print the Metis version\n\nThe vault directory is METIS_VAULT_PATH, or the current directory.\n`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Metis failed:\n${message}\n`);
  process.exitCode = 1;
});
