import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RetrievalDiagnostics } from "../src/knowledge.js";
import { createStudyServer } from "../src/server.js";

interface Check {
  id: string;
  passed: boolean;
  evidence: unknown;
}

interface RetrievalBenchmarkPoint {
  question: number;
  legacyCumulativeTokenWork: number;
  indexedCumulativeTokenWork: number;
  sourceTokensIndexedThisQuestion: number;
  postingsVisitedThisQuestion: number;
  responseBytes: number;
  elapsedMs: number;
}

const RELATED_RETRIEVAL_QUERIES = [
  "How does delta hedging reduce option risk?",
  "How does a delta hedge reduce an option portfolio's exposure?",
  "Why does delta hedging lower first-order option risk?",
  "How is option delta used to hedge underlying price movements?",
  "Why must a delta hedge be rebalanced over time?",
  "How does gamma affect the stability of a delta hedge?",
  "What assumptions make a Black-Scholes delta hedge work?",
  "When can delta hedging fail to eliminate option risk?",
];

const suppliedVault = process.argv[2];
if (!suppliedVault) {
  throw new Error(
    "Usage: npm run eval:real-vault -- /absolute/path/to/an/existing/metis/vault",
  );
}

const sourceVault = path.resolve(suppliedVault);
const sourceStatePath = path.join(sourceVault, ".metis", "state.json");
await lstat(sourceStatePath);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "metis-real-vault-eval-"));
const copiedVault = path.join(temporaryRoot, "vault");
const checks: Check[] = [];
let client: Client | undefined;
let server: Awaited<ReturnType<typeof createStudyServer>>["server"] | undefined;

function check(id: string, passed: boolean, evidence: unknown): void {
  checks.push({ id, passed: Boolean(passed), evidence });
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function numericDelta(
  after: RetrievalDiagnostics,
  before: RetrievalDiagnostics,
  key: keyof RetrievalDiagnostics,
): number {
  return after[key] - before[key];
}

function objectContent(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`MCP tool failed: ${JSON.stringify(result.content)}`);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((item): item is { type: "text"; text: string } =>
    Boolean(item)
    && typeof item === "object"
    && (item as { type?: unknown }).type === "text"
    && typeof (item as { text?: unknown }).text === "string");
  if (!textBlock) {
    throw new Error("MCP tool did not return compact JSON text content.");
  }
  const parsed = JSON.parse(textBlock.text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP tool JSON content was not an object.");
  }
  return parsed as Record<string, unknown>;
}

async function tool(
  connected: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return objectContent(await connected.callTool({ name, arguments: args }));
}

try {
  const originalDigestBefore = await hashTree(sourceVault);
  const originalState = JSON.parse(
    await readFile(sourceStatePath, "utf8"),
  ) as Record<string, unknown>;
  await cp(sourceVault, copiedVault, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await rm(path.join(copiedVault, ".metis", "cache"), {
    recursive: true,
    force: true,
  });
  const copiedRawBefore = await hashTree(path.join(copiedVault, "raw"));

  const created = await createStudyServer(copiedVault);
  server = created.server;
  client = new Client({ name: "metis-real-vault-evaluator", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const update = await tool(client, "metis_repair");
  const migratedState = JSON.parse(
    await readFile(path.join(copiedVault, ".metis", "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const copiedRawAfter = await hashTree(path.join(copiedVault, "raw"));
  const count = (state: Record<string, unknown>, key: string): number =>
    Array.isArray(state[key]) ? state[key].length : -1;
  check(
    "real_vault.migration_preserves_state_and_raw",
    migratedState.schemaVersion === 5
      && ["sources", "wikiPages", "concepts"]
        .every((key) => count(originalState, key) === count(migratedState, key))
      && copiedRawBefore === copiedRawAfter
      && String(update.backupRelativePath).startsWith(".metis/backups/"),
    {
      beforeVersion: originalState.schemaVersion,
      afterVersion: migratedState.schemaVersion,
      counts: Object.fromEntries(
        ["sources", "wikiPages", "concepts"]
          .map((key) => [key, count(migratedState, key)]),
      ),
      rawDigestPreserved: copiedRawBefore === copiedRawAfter,
      repaired: update.repaired,
    },
  );

  const lookupCases = [
    ["delta hedging", "delta-and-delta-hedging"],
    ["put call parity", "european-options-and-put-call-parity"],
    ["cointegration pairs trading", "pairs-trading-and-cointegration"],
    ["market making", "market-making"],
  ] as const;
  const lookupEvidence: Array<Record<string, unknown>> = [];
  for (const [query, expected] of lookupCases) {
    const result = await tool(client, "search_knowledge", { query });
    const concepts = result.concepts as Array<Record<string, unknown>>;
    lookupEvidence.push({
      query,
      expected,
      actual: concepts[0]?.key,
      match: concepts[0]?.match,
      bytes: bytes(result),
    });
  }
  check(
    "real_vault.keyed_lookup",
    lookupEvidence.every((item) =>
      item.actual === item.expected && Number(item.bytes) <= 2_500),
    lookupEvidence,
  );

  created.knowledge.resetRetrievalDiagnostics();
  const retrievalPoints: RetrievalBenchmarkPoint[] = [];
  let previousDiagnostics = created.knowledge.getRetrievalDiagnostics();
  let legacyCumulativeTokenWork = 0;
  let indexedCumulativeTokenWork = 0;
  for (
    let index = 0;
    index < RELATED_RETRIEVAL_QUERIES.length;
    index += 1
  ) {
    const startedAt = performance.now();
    const result = await tool(client, "search_knowledge", {
      query: RELATED_RETRIEVAL_QUERIES[index],
      scope: "sources",
      limit: 3,
    });
    const elapsedMs = performance.now() - startedAt;
    const currentDiagnostics = created.knowledge.getRetrievalDiagnostics();
    const legacyThisQuestion = numericDelta(
      currentDiagnostics,
      previousDiagnostics,
      "legacyEstimatedTokenVisits",
    );
    const indexedThisQuestion = numericDelta(
      currentDiagnostics,
      previousDiagnostics,
      "indexedTokenWork",
    );
    legacyCumulativeTokenWork += legacyThisQuestion;
    indexedCumulativeTokenWork += indexedThisQuestion;
    retrievalPoints.push({
      question: index + 1,
      legacyCumulativeTokenWork,
      indexedCumulativeTokenWork,
      sourceTokensIndexedThisQuestion: numericDelta(
        currentDiagnostics,
        previousDiagnostics,
        "sourceLexicalTokensIndexed",
      ),
      postingsVisitedThisQuestion: numericDelta(
        currentDiagnostics,
        previousDiagnostics,
        "postingsVisited",
      ),
      responseBytes: bytes(result),
      elapsedMs: Number(elapsedMs.toFixed(3)),
    });
    previousDiagnostics = currentDiagnostics;
  }
  const retrievalReductionPercent = legacyCumulativeTokenWork > 0
    ? Number((
        (1 - indexedCumulativeTokenWork / legacyCumulativeTokenWork) * 100
      ).toFixed(2))
    : 0;
  const finalRetrievalDiagnostics = created.knowledge
    .getRetrievalDiagnostics();
  check(
    "real_vault.incremental_index_efficiency",
    retrievalPoints.length === RELATED_RETRIEVAL_QUERIES.length
      && retrievalPoints[0]!.sourceTokensIndexedThisQuestion > 0
      && retrievalPoints.slice(1).every((point) =>
        point.sourceTokensIndexedThisQuestion === 0)
      && finalRetrievalDiagnostics.verifiedSources > 0
      && retrievalReductionPercent >= 50,
    {
      questions: retrievalPoints.length,
      indexedSources: finalRetrievalDiagnostics.indexedSourcesCurrent,
      indexedChunks: finalRetrievalDiagnostics.indexedChunksCurrent,
      legacyEstimatedTokenWork: legacyCumulativeTokenWork,
      checksumIndexedTokenWork: indexedCumulativeTokenWork,
      reductionPercent: retrievalReductionPercent,
      rawSourcesVerifiedBeforeEvidence:
        finalRetrievalDiagnostics.verifiedSources,
    },
  );

  const baselineAnswerBytes: number[] = [];
  for (const question of RELATED_RETRIEVAL_QUERIES) {
    baselineAnswerBytes.push(bytes(await tool(
      client,
      "prepare_grounded_answer",
      {
        question,
        groundingMode: "sources_first",
        evidenceLimit: 3,
      },
    )));
  }
  const reusedAnswerBytes: number[] = [];
  let priorPacketId: string | undefined;
  let reusedCitationCount = 0;
  for (const question of RELATED_RETRIEVAL_QUERIES) {
    const result = await tool(client, "prepare_grounded_answer", {
      question,
      groundingMode: "sources_first",
      evidenceLimit: 3,
      ...(priorPacketId ? { priorPacketId } : {}),
    });
    reusedAnswerBytes.push(bytes(result));
    reusedCitationCount += Array.isArray(
      (result.reusedEvidence as Record<string, unknown> | undefined)
        ?.citations,
    )
      ? (
          (result.reusedEvidence as Record<string, unknown>)
            .citations as unknown[]
        ).length
      : 0;
    priorPacketId = String(result.packetId);
  }
  const baselineModelBytes = baselineAnswerBytes
    .reduce((total, value) => total + value, 0);
  const reusedModelBytes = reusedAnswerBytes
    .reduce((total, value) => total + value, 0);
  const modelContextReductionPercent = baselineModelBytes > 0
    ? Number(((1 - reusedModelBytes / baselineModelBytes) * 100).toFixed(2))
    : 0;
  check(
    "real_vault.follow_up_evidence_reuse",
    reusedCitationCount > 0
      && reusedModelBytes < baselineModelBytes
      && modelContextReductionPercent >= 10,
    {
      questions: RELATED_RETRIEVAL_QUERIES.length,
      baselineBytes: baselineModelBytes,
      evidenceReuseBytes: reusedModelBytes,
      estimatedBaselineTokens: Math.ceil(baselineModelBytes / 4),
      estimatedEvidenceReuseTokens: Math.ceil(reusedModelBytes / 4),
      reductionPercent: modelContextReductionPercent,
      reusedCitations: reusedCitationCount,
    },
  );

  const benchmark = {
    dataset: {
      label: "MATH2991 private vault",
      sourceCount: count(migratedState, "sources"),
      sourceKinds: "PDF",
      questionCount: RELATED_RETRIEVAL_QUERIES.length,
    },
    metricDefinitions: {
      retrievalTokenWork:
        "Lexical source-token visits required by the former full-scan BM25 implementation versus source-token indexing plus posting-list visits in the checksum-keyed index.",
      modelTokens:
        "Estimated as compact MCP JSON bytes divided by four. This is a tokenizer-independent approximation, not provider billing telemetry.",
    },
    retrieval: {
      legacyEstimatedTokenWork: legacyCumulativeTokenWork,
      checksumIndexedTokenWork: indexedCumulativeTokenWork,
      reductionPercent: retrievalReductionPercent,
      points: retrievalPoints,
    },
    modelContext: {
      baselineBytes: baselineModelBytes,
      evidenceReuseBytes: reusedModelBytes,
      estimatedBaselineTokens: Math.ceil(baselineModelBytes / 4),
      estimatedEvidenceReuseTokens: Math.ceil(reusedModelBytes / 4),
      reductionPercent: modelContextReductionPercent,
      reusedCitations: reusedCitationCount,
      baselinePerQuestionBytes: baselineAnswerBytes,
      evidenceReusePerQuestionBytes: reusedAnswerBytes,
    },
    integrity: {
      sourceChecksumsPreserved: copiedRawBefore === copiedRawAfter,
      rawSourcesVerifiedBeforeEvidence:
        finalRetrievalDiagnostics.verifiedSources,
    },
  };

  const answer = await tool(client, "prepare_grounded_answer", {
    question: "How does delta hedging reduce option risk?",
    groundingMode: "sources_first",
  });
  const answerEvidence = answer.evidence as Array<Record<string, unknown>>;
  check(
    "real_vault.compact_grounded_answer",
    bytes(answer) <= 6_000
      && answerEvidence.length > 0
      && answerEvidence.every((item) =>
        /^\[src_.+#L\d+-L\d+\]$/.test(String(item.citation)))
      && !("answerContract" in answer),
    {
      bytes: bytes(answer),
      coverage: answer.coverage,
      evidence: answerEvidence.length,
      concepts: (answer.concepts as Array<Record<string, unknown>>)
        .map((concept) => concept.key),
    },
  );

  const capsuleResource = await client.readResource({
    uri: "study://wiki/delta-and-delta-hedging",
  });
  const capsuleText = capsuleResource.contents[0]
    && "text" in capsuleResource.contents[0]
    ? capsuleResource.contents[0].text
    : "";
  const capsule = JSON.parse(capsuleText) as Record<string, unknown>;
  check(
    "real_vault.bounded_capsule_resource",
    capsule.key === "delta-and-delta-hedging"
      && Buffer.byteLength(capsuleText) <= 2_500
      && !capsuleText.includes("# Delta"),
    { bytes: Buffer.byteLength(capsuleText), key: capsule.key },
  );

  const originalDigestAfter = await hashTree(sourceVault);
  check(
    "real_vault.original_untouched",
    originalDigestBefore === originalDigestAfter,
    { unchanged: originalDigestBefore === originalDigestAfter },
  );

  const report = {
    suite: "Metis private real-vault context-efficiency evaluation",
    generatedAt: new Date().toISOString(),
    passed: checks.every((item) => item.passed),
    benchmark,
    checks,
  };
  const resultDirectory = path.join(projectRoot, ".eval-results");
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(
    path.join(resultDirectory, "real-vault-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(resultDirectory, "real-vault-latest.md"),
    [
      `# ${report.suite}`,
      "",
      `Result: **${report.passed ? "PASS" : "FAIL"}**`,
      "",
      "## Retrieval efficiency",
      "",
      `- Repeated related questions: ${benchmark.dataset.questionCount}`,
      `- Former full-scan token work: ${benchmark.retrieval.legacyEstimatedTokenWork.toLocaleString("en-US")}`,
      `- Checksum-indexed token work: ${benchmark.retrieval.checksumIndexedTokenWork.toLocaleString("en-US")}`,
      `- Retrieval-work reduction: ${benchmark.retrieval.reductionPercent}%`,
      `- Estimated model-context reduction with explicit evidence reuse: ${benchmark.modelContext.reductionPercent}%`,
      "",
      "> Retrieval token work is an internal lexical-work metric. Model tokens are estimated from compact JSON bytes and are not provider billing telemetry.",
      "",
      "## Checks",
      "",
      ...checks.map((item) =>
        `- ${item.passed ? "PASS" : "FAIL"} \`${item.id}\` — \`${JSON.stringify(item.evidence)}\``),
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`${report.passed ? "PASS" : "FAIL"} ${report.suite}`);
  for (const item of checks) {
    console.log(`${item.passed ? "✓" : "✗"} ${item.id} ${JSON.stringify(item.evidence)}`);
  }
  if (!report.passed) process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => undefined);
  if (server) await server.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
      hash.update(`L\0${relative}\0${await readlink(absolute)}\0`);
      return;
    }
    if (details.isDirectory()) {
      hash.update(`D\0${relative}\0`);
      const entries = await readdir(absolute);
      for (const entry of entries.sort()) {
        await visit(path.join(absolute, entry), path.posix.join(relative, entry));
      }
      return;
    }
    if (!details.isFile()) {
      throw new Error(`Unsupported filesystem entry while hashing vault: ${absolute}`);
    }
    hash.update(`F\0${relative}\0${details.mode}\0`);
    hash.update(await readFile(absolute));
    hash.update("\0");
  };
  await visit(root, ".");
  return hash.digest("hex");
}
