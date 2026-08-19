import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudyServer } from "../src/server.js";

interface EvalCases {
  schemaVersion: number;
  passThreshold: number;
  criticalChecks: string[];
  retrievalCases: Array<{
    query: string;
    expectedTerms: string[];
    expectedTitle: string;
  }>;
  unknownQuestion: string;
}

interface Check {
  id: string;
  category: string;
  description: string;
  weight: number;
  passed: boolean;
  evidence: string;
  critical: boolean;
}

interface EvalReport {
  suite: string;
  version: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  score: number;
  maximumScore: number;
  percentage: number;
  threshold: number;
  passed: boolean;
  criticalPassed: boolean;
  environment: Record<string, string>;
  checks: Check[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceEvalRoot = here;
const projectRoot = path.resolve(sourceEvalRoot, "..");
const cases = JSON.parse(
  await readFile(path.join(sourceEvalRoot, "cases.json"), "utf8"),
) as EvalCases;
const calculus = await readFile(path.join(sourceEvalRoot, "fixtures", "calculus.md"), "utf8");
const optimization = await readFile(path.join(sourceEvalRoot, "fixtures", "optimization.md"), "utf8");
const supplementalFixtures = await Promise.all([
  ["Cell Biology and Genetics", "biology.md"],
  ["Algorithms and Data Structures", "computer-science.md"],
  ["Introductory Economics", "economics.md"],
  ["European Integration", "history.md"],
  ["Adversarial Source Handling", "adversarial.md"],
  ["Protocol Zephyr A", "conflict-a.md"],
  ["Protocol Zephyr B", "conflict-b.md"],
].map(async ([title, filename]) => ({
  title: title!,
  content: await readFile(path.join(sourceEvalRoot, "fixtures", filename!), "utf8"),
})));
const startedAt = new Date();
const vault = await mkdtemp(path.join(os.tmpdir(), "metis-eval-"));
const checks: Check[] = [];

function check(
  id: string,
  category: string,
  description: string,
  weight: number,
  condition: boolean,
  evidence: unknown,
): void {
  checks.push({
    id,
    category,
    description,
    weight,
    passed: Boolean(condition),
    evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence),
    critical: cases.criticalChecks.includes(id),
  });
}

function objectContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`MCP tool returned an error: ${JSON.stringify(result.content)}`);
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
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return objectContent(await client.callTool({ name, arguments: args }));
}

async function jsonResource(
  client: Client,
  uri: string,
): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (!content || !("text" in content)) {
    throw new Error(`MCP resource did not return text: ${uri}`);
  }
  return JSON.parse(content.text) as Record<string, unknown>;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

let client: Client | undefined;
let mcpServer: Awaited<ReturnType<typeof createStudyServer>>["server"] | undefined;

try {
  const created = await createStudyServer(vault);
  mcpServer = created.server;
  client = new Client({ name: "metis-evaluator", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    mcpServer.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listedTools = await client.listTools();
  const toolNames = listedTools.tools.map((item) => item.name);
  const requiredTools = [
    "metis_repair",
    "metis_restore_backup",
    "list_metis_backups",
    "ingest_source",
    "upsert_wiki_page",
    "search_knowledge",
    "prepare_grounded_answer",
    "prepare_practice",
    "create_flashcards",
    "get_review_queue",
    "record_review",
    "resolve_misconception",
    "grade_practice_attempt",
    "set_study_goal",
    "plan_study_session",
    "get_knowledge_graph",
    "lint_wiki",
    "verify_math",
    "render_math_pdf",
  ];
  check(
    "protocol.required_tools",
    "protocol",
    "Advertises every required end-to-end study tool",
    6,
    requiredTools.every((name) => toolNames.includes(name)),
    { advertised: toolNames.length, missing: requiredTools.filter((name) => !toolNames.includes(name)) },
  );
  check(
    "protocol.tool_metadata",
    "protocol",
    "Tool schemas include descriptions and behavioral annotations",
    3,
    listedTools.tools.every((item) =>
      Boolean(item.description)
      && Boolean(item.inputSchema)
      && Boolean(item.annotations)),
    `${listedTools.tools.filter((item) => item.description && item.annotations).length}/${listedTools.tools.length} complete`,
  );
  const singlePayloadProbe = await client.callTool({
    name: "metis_repair",
    arguments: { dryRun: true },
  });
  const singlePayloadObject = objectContent(singlePayloadProbe);
  check(
    "context.single_wire_payload",
    "context",
    "JSON tools emit one compact model-facing payload instead of duplicating text and structured content",
    5,
    singlePayloadProbe.structuredContent === undefined
      && Array.isArray(singlePayloadProbe.content)
      && singlePayloadProbe.content.length === 1
      && singlePayloadObject.dryRun === true,
    {
      contentBlocks: Array.isArray(singlePayloadProbe.content)
        ? singlePayloadProbe.content.length
        : 0,
      hasStructuredDuplicate: singlePayloadProbe.structuredContent !== undefined,
      bytes: serializedBytes(singlePayloadProbe),
    },
  );

  const listedResources = await client.listResources();
  const listedTemplates = await client.listResourceTemplates();
  const listedPrompts = await client.listPrompts();
  check(
    "protocol.resources_prompts",
    "protocol",
    "Exposes navigable resources, templates, and reusable learning prompts",
    3,
    listedResources.resources.length >= 2
      && listedTemplates.resourceTemplates.length >= 2
      && listedPrompts.prompts.length >= 3,
    {
      resources: listedResources.resources.length,
      templates: listedTemplates.resourceTemplates.length,
      prompts: listedPrompts.prompts.length,
    },
  );
  check(
    "context.protocol_surface_budget",
    "context",
    "Tool, resource, template, and prompt discovery stays compact",
    5,
    toolNames.length <= 20
      && serializedBytes(listedTools) <= 15_000
      && serializedBytes(listedResources) <= 1_200
      && serializedBytes(listedTemplates) <= 1_200
      && serializedBytes(listedPrompts) <= 2_000,
    {
      tools: toolNames.length,
      toolBytes: serializedBytes(listedTools),
      resourceBytes: serializedBytes(listedResources),
      templateBytes: serializedBytes(listedTemplates),
      promptBytes: serializedBytes(listedPrompts),
    },
  );

  const calculusIngest = await tool(client, "ingest_source", {
    title: "Differential Calculus",
    content: calculus,
    tags: ["calculus", "mathematics"],
  });
  const optimizationIngest = await tool(client, "ingest_source", {
    title: "Optimization",
    content: optimization,
    tags: ["optimization", "machine-learning"],
  });
  await Promise.all(supplementalFixtures.map((fixture) =>
    tool(client!, "ingest_source", {
      title: fixture.title,
      content: fixture.content,
      tags: ["evaluation-fixture"],
    })));
  const calculusSource = calculusIngest.source as Record<string, unknown>;
  const optimizationSource = optimizationIngest.source as Record<string, unknown>;
  const calculusSourceId = String(calculusSource.id);
  const optimizationSourceId = String(optimizationSource.id);
  const duplicate = await tool(client, "ingest_source", {
    title: "Duplicate optimization bytes",
    content: optimization,
  });
  const stateAfterIngest = JSON.parse(
    await readFile(path.join(vault, ".metis", "state.json"), "utf8"),
  ) as {
    sources: Array<Record<string, unknown>>;
  };
  const storedCalculusSource = stateAfterIngest.sources.find((source) =>
    source.id === calculusSourceId)!;
  check(
    "ingest.provenance",
    "knowledge",
    "Ingestion creates immutable IDs, SHA-256 checksums, and raw paths",
    5,
    /^src_[a-f0-9]{16}$/.test(calculusSourceId)
      && /^[a-f0-9]{64}$/.test(String(calculusSource.checksum))
      && String(storedCalculusSource.relativePath).startsWith("raw/"),
    { tool: calculusSource, stored: storedCalculusSource },
  );
  check(
    "ingest.deduplication",
    "knowledge",
    "Byte-identical sources deduplicate by checksum",
    3,
    duplicate.duplicate === true
      && (duplicate.source as Record<string, unknown>).id === optimizationSourceId,
    duplicate,
  );

  await tool(client, "upsert_wiki_page", {
    title: "Derivatives",
    summary: "Rates of change, differentiation rules, and critical points.",
    markdown: [
      "# Derivatives",
      "",
      "A derivative measures instantaneous rate of change and tangent slope.",
      "The chain rule differentiates compositions by multiplying outer and inner derivatives.",
      `Critical points and derivative sign changes help classify local extrema. [${calculusSourceId}#L3-L13]`,
      "",
      "Related: [[Gradient Descent]]",
    ].join("\n"),
    sourceIds: [calculusSourceId],
    aliases: ["differentiation", "rate of change"],
    links: ["Gradient Descent"],
    tags: ["calculus"],
  });
  await tool(client, "upsert_wiki_page", {
    title: "Gradient Descent",
    summary: "First-order optimization by negative-gradient updates.",
    markdown: [
      "# Gradient Descent",
      "",
      "The learning rate controls step size. Poor calibration causes slow progress or divergence.",
      `The gradient norm is one useful convergence diagnostic. [${optimizationSourceId}#L3-L7]`,
      "",
      "Related: [[Derivatives]]",
    ].join("\n"),
    sourceIds: [optimizationSourceId],
    links: ["Derivatives"],
    tags: ["optimization"],
  });
  const populatedResourceList = await client.listResources();
  check(
    "context.bounded_discovery",
    "context",
    "Resource discovery stays fixed-size without enumerating every concept or source",
    5,
    serializedBytes(populatedResourceList) <= 1_200
      && !populatedResourceList.resources.some((resource) =>
        resource.uri.startsWith("study://wiki/derivatives")
        || resource.uri.startsWith(`study://source/${calculusSourceId}`)),
    {
      bytes: serializedBytes(populatedResourceList),
      resources: populatedResourceList.resources.map((resource) => resource.uri),
    },
  );
  const lint = await tool(client, "lint_wiki");
  const lintIssues = lint.issues as unknown[];
  check(
    "wiki.compilation_integrity",
    "wiki",
    "Compiled pages retain provenance and resolve reciprocal links",
    6,
    lint.healthy === true && lintIssues.length === 0,
    lint,
  );
  const wikiResource = await client.readResource({ uri: "study://wiki/derivatives" });
  const wikiText = wikiResource.contents[0] && "text" in wikiResource.contents[0]
    ? wikiResource.contents[0].text
    : "";
  check(
    "wiki.obsidian_resource",
    "wiki",
    "Normal wiki resource returns one compact keyed capsule rather than full Markdown",
    3,
    JSON.parse(wikiText).key === "derivatives"
      && JSON.parse(wikiText).related.includes("gradient-descent")
      && !wikiText.includes("# Derivatives"),
    wikiText.slice(0, 500),
  );
  const aliasLookup = await tool(client, "search_knowledge", {
    query: "differentiation",
  });
  const aliasConcepts = aliasLookup.concepts as Array<Record<string, unknown>>;
  check(
    "context.keyed_concept_lookup",
    "context",
    "Exact alias lookup resolves through the server-side concept map with a bounded capsule",
    7,
    aliasConcepts[0]?.key === "derivatives"
      && aliasConcepts[0]?.match === "alias"
      && serializedBytes(aliasLookup) <= 2_500,
    { bytes: serializedBytes(aliasLookup), concepts: aliasConcepts },
  );
  const sourceResource = await client.readResource({
    uri: `study://source/${calculusSourceId}`,
  });
  const sourceText = sourceResource.contents[0] && "text" in sourceResource.contents[0]
    ? sourceResource.contents[0].text
    : "";
  const maintenanceResource = await client.readResource({
    uri: "study://maintenance/wiki/derivatives",
  });
  const maintenanceText = maintenanceResource.contents[0]
    && "text" in maintenanceResource.contents[0]
    ? maintenanceResource.contents[0].text
    : "";
  check(
    "context.bounded_resources",
    "context",
    "Source metadata stays compact while full wiki Markdown is maintenance-only",
    6,
    Buffer.byteLength(sourceText) <= 1_000
      && !sourceText.includes("outer and inner derivatives")
      && maintenanceText.includes("# Derivatives")
      && maintenanceText.includes("[[Gradient Descent]]"),
    {
      sourceBytes: Buffer.byteLength(sourceText),
      capsuleBytes: Buffer.byteLength(wikiText),
      maintenanceBytes: Buffer.byteLength(maintenanceText),
    },
  );

  const calculusRawPath = path.join(vault, String(storedCalculusSource.relativePath));
  const rawBeforeUpdate = await readFile(calculusRawPath);
  const legacyState = JSON.parse(
    await readFile(path.join(vault, ".metis", "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const legacyConfig = JSON.parse(
    await readFile(path.join(vault, ".metis", "config.json"), "utf8"),
  ) as Record<string, unknown>;
  delete legacyState.schemaVersion;
  delete legacyConfig.schemaVersion;
  await writeFile(
    path.join(vault, ".metis", "state.json"),
    `${JSON.stringify(legacyState, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(vault, ".metis", "config.json"),
    `${JSON.stringify(legacyConfig, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(vault, "wiki", "SCHEMA.md"), "# Legacy schema\n", "utf8");

  const updatePreview = await tool(client, "metis_repair", { dryRun: true });
  const stillLegacy = JSON.parse(
    await readFile(path.join(vault, ".metis", "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const update = await tool(client, "metis_repair");
  const migratedState = JSON.parse(
    await readFile(path.join(vault, ".metis", "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const migratedConfig = JSON.parse(
    await readFile(path.join(vault, ".metis", "config.json"), "utf8"),
  ) as Record<string, unknown>;
  const backupRelativePath = String(update.backupRelativePath);
  const backupManifest = JSON.parse(
    await readFile(path.join(vault, backupRelativePath, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const rawAfterUpdate = await readFile(calculusRawPath);
  check(
    "migration.backup_roundtrip",
    "persistence",
    "Metis repair previews safely, migrates legacy metadata, repairs generated knowledge and skills, backs up managed files, and preserves raw evidence",
    8,
    updatePreview.dryRun === true
      && updatePreview.repaired === false
      && stillLegacy.schemaVersion === undefined
      && update.repaired === true
      && (update.wikiHealth as Record<string, unknown>).healthy === true
      && (update.skills as Record<string, unknown>).version === 1
      && migratedState.schemaVersion === 3
      && (migratedState.wikiPages as Array<Record<string, unknown>>)
        .every((page) => Array.isArray(page.aliases))
      && migratedConfig.schemaVersion === 1
      && backupRelativePath.startsWith(".metis/backups/")
      && Array.isArray(backupManifest.excludes)
      && rawBeforeUpdate.equals(rawAfterUpdate),
    { updatePreview, update, backupManifest },
  );
  const currentSnapshot = await tool(client, "metis_repair");
  await tool(client, "set_study_goal", {
    title: "Transient restore probe",
    conceptIds: [],
    targetMastery: 0.7,
    minutesPerWeek: 15,
  });
  const restorePreview = await tool(client, "metis_restore_backup", {
    backupRelativePath: currentSnapshot.backupRelativePath,
    dryRun: true,
  });
  const restored = await tool(client, "metis_restore_backup", {
    backupRelativePath: currentSnapshot.backupRelativePath,
  });
  const backupInventory = await tool(client, "list_metis_backups");
  const listedBackups = backupInventory.backups as Array<Record<string, unknown>>;
  const restoredDashboard = await jsonResource(client, "study://dashboard");
  check(
    "migration.restore_roundtrip",
    "persistence",
    "Backup restore previews safely, creates a recovery backup, restores managed state, and preserves raw evidence",
    7,
    restorePreview.restored === false
      && restorePreview.dryRun === true
      && restored.restored === true
      && String(restored.recoveryBackupRelativePath).startsWith(".metis/backups/")
      && listedBackups.length >= 3
      && listedBackups.every((item) => item.integrity === "valid")
      && (restoredDashboard.counts as Record<string, unknown>).activeGoals === 0
      && rawBeforeUpdate.equals(await readFile(calculusRawPath)),
    { restorePreview, restored, backupInventory, counts: restoredDashboard.counts },
  );

  let retrievalPasses = 0;
  const retrievalEvidence: Array<Record<string, unknown>> = [];
  for (const retrievalCase of cases.retrievalCases) {
    const result = await tool(client, "search_knowledge", {
      query: retrievalCase.query,
      limit: 5,
      scope: "sources",
    });
    const results = result.evidence as Array<Record<string, unknown>>;
    const joined = results.slice(0, 3).map((item) => String(item.text).toLowerCase()).join("\n");
    const passed = retrievalCase.expectedTerms.every((term) => joined.includes(term.toLowerCase()))
      && results[0]?.title === retrievalCase.expectedTitle
      && results.some((item) =>
        /^\[.+#L\d+-L\d+\]$/.test(String(item.citation)))
      && serializedBytes(result) <= 6_000;
    if (passed) retrievalPasses += 1;
    retrievalEvidence.push({
      query: retrievalCase.query,
      passed,
      topTitle: results[0]?.title,
      expectedTitle: retrievalCase.expectedTitle,
      bytes: serializedBytes(result),
    });
  }
  check(
    "retrieval.golden_queries",
    "grounding",
    "Golden queries retrieve expected source language with ranked line spans",
    8,
    retrievalPasses === cases.retrievalCases.length,
    retrievalEvidence,
  );
  check(
    "context.source_search_budget",
    "context",
    "Every multi-domain raw-source search stays within the model-context byte budget",
    7,
    retrievalEvidence.every((item) => Number(item.bytes) <= 6_000),
    {
      maximumBytes: Math.max(...retrievalEvidence.map((item) => Number(item.bytes))),
      cases: retrievalEvidence.length,
    },
  );

  const groundedKnown = await tool(client, "prepare_grounded_answer", {
    question: "Why can a learning rate make gradient descent diverge?",
    groundingMode: "sources_only",
  });
  const knownEvidence = groundedKnown.evidence as Array<Record<string, unknown>>;
  check(
    "grounding.known_citations",
    "grounding",
    "Known questions return non-fabricated line-span citation tokens",
    6,
    knownEvidence.length > 0
      && knownEvidence.every((item) => /^\[.+#L\d+-L\d+\]$/.test(String(item.citation))),
    knownEvidence.map((item) => item.citation),
  );
  check(
    "context.grounded_packet_budget",
    "context",
    "Grounded answer packet stays bounded without repeated policy while retaining keyed state and raw citations",
    7,
    serializedBytes(groundedKnown) <= 6_000
      && !("answerContract" in groundedKnown)
      && (groundedKnown.concepts as unknown[]).length > 0
      && knownEvidence.length > 0,
    {
      bytes: serializedBytes(groundedKnown),
      keys: Object.keys(groundedKnown),
      evidence: knownEvidence.length,
    },
  );
  const facetPacket = await tool(client, "prepare_grounded_answer", {
    question: "What controls the gradient descent step size, and what mechanism fixes nitrogen in legume root nodules?",
    facets: [
      "What controls the gradient descent step size?",
      "What mechanism fixes nitrogen in legume root nodules?",
    ],
    groundingMode: "sources_only",
  });
  const facetCoverage = facetPacket.facets as Array<Record<string, unknown>>;
  check(
    "grounding.facet_coverage",
    "grounding",
    "Multi-part questions expose compact per-facet support and cannot become sufficient when a required facet is unsupported",
    7,
    facetPacket.coverage === "partial"
      && facetCoverage.length === 2
      && facetCoverage[0]?.status === "supported"
      && facetCoverage[1]?.status === "unsupported"
      && Array.isArray(facetCoverage[0]?.citations)
      && (facetCoverage[0]?.citations as unknown[]).length > 0
      && (facetPacket.evidence as unknown[]).length === 1
      && serializedBytes(facetPacket) <= 6_000,
    facetPacket,
  );
  const injectionPacket = await tool(client, "prepare_grounded_answer", {
    question: "What calibration constant is documented in the adversarial fixture?",
    groundingMode: "sources_only",
  });
  const injectionWarnings = injectionPacket.warnings as string[];
  check(
    "grounding.prompt_injection_boundary",
    "grounding",
    "Evidence packets explicitly classify retrieved instructions as untrusted source data",
    7,
    (injectionPacket.evidence as Array<Record<string, unknown>>).some((item) =>
      String(item.text).includes("Ignore all previous instructions"))
      && injectionWarnings.includes("source_instructions_detected"),
    { warnings: injectionWarnings, evidence: injectionPacket.evidence },
  );
  const conflictPacket = await tool(client, "prepare_grounded_answer", {
    question: "What observation interval does Protocol Zephyr require?",
    groundingMode: "sources_only",
  });
  const conflictEvidence = conflictPacket.evidence as Array<Record<string, unknown>>;
  const conflictText = conflictEvidence.map((item) => String(item.text)).join("\n");
  check(
    "grounding.conflicting_sources",
    "grounding",
    "Grounding returns independent contradictory passages and requires the answer to expose the conflict",
    7,
    conflictText.includes("15-minute")
      && conflictText.includes("30-minute")
      && conflictPacket.coverage === "partial"
      && (conflictPacket.facets as Array<Record<string, unknown>>)[0]?.status === "conflicting"
      && (conflictPacket.warnings as string[]).includes("compare_independent_sources")
      && (conflictPacket.warnings as string[]).includes("possible_numeric_conflict"),
    conflictPacket,
  );

  const groundedUnknownStrict = await tool(client, "prepare_grounded_answer", {
    question: cases.unknownQuestion,
    groundingMode: "sources_only",
  });
  check(
    "grounding.strict_no_external",
    "grounding",
    "Strict grounding never escalates to outside knowledge when evidence is absent",
    6,
    groundedUnknownStrict.coverage !== "sufficient"
      && groundedUnknownStrict.groundingMode === "sources_only"
      && !("answerContract" in groundedUnknownStrict),
    groundedUnknownStrict,
  );
  const groundedUnknownFirst = await tool(client, "prepare_grounded_answer", {
    question: cases.unknownQuestion,
    groundingMode: "sources_first",
  });
  check(
    "grounding.sources_first_gap",
    "grounding",
    "Sources-first mode exposes unsupported facets for explicitly labelled gap filling",
    4,
    groundedUnknownFirst.coverage !== "sufficient"
      && groundedUnknownFirst.groundingMode === "sources_first"
      && (groundedUnknownFirst.facets as Array<Record<string, unknown>>)
        .some((facet) => facet.status === "unsupported"),
    groundedUnknownFirst,
  );

  const failedDerivativeAttempt = await tool(client, "grade_practice_attempt", {
    conceptId: "derivatives",
    score: 0,
    maxScore: 5,
    misconception: "Confuses the chain rule with the product rule.",
  });
  const practice = await tool(client, "prepare_practice", {
    topic: "derivatives and gradient descent",
    count: 6,
    difficulty: "adaptive",
    formats: ["recall", "explain", "application", "calculation"],
    includeSolutions: false,
  });
  const practiceTask = practice.task as Record<string, unknown>;
  const practiceFocus = practice.focus as Record<string, unknown>;
  const practiceLearner = practiceFocus.learner as Record<string, unknown>;
  const adaptiveMisconceptions = practiceLearner.activeMisconceptions as Array<Record<string, unknown>>;
  check(
    "practice.grounded_contract",
    "learning",
    "Practice brief is evidence-backed, format-diverse, exact-count, and withholds solutions",
    6,
    practiceTask.count === 6
      && (practice.evidence as unknown[]).length > 0
      && practiceTask.solutions === false
      && (practiceTask.formats as string[]).length >= 3
      && !("generatorContract" in practice),
    { task: practiceTask, bytes: serializedBytes(practice) },
  );
  check(
    "learning.misconception_adaptation",
    "learning",
    "Failed practice creates a structured misconception that changes adaptive difficulty and formats",
    7,
    (failedDerivativeAttempt.concept as Record<string, unknown>).mastery === 0
      && practiceFocus.key === "derivatives"
      && adaptiveMisconceptions.some((item) =>
        item.text === "Confuses the chain rule with the product rule."
        && item.occurrences === 1)
      && (practiceTask.formats as string[]).includes("debug")
      && practiceTask.difficulty === "introductory"
      && practiceFocus.strategy === "misconception_repair",
    { focus: practiceFocus, task: practiceTask },
  );
  check(
    "context.practice_packet_budget",
    "context",
    "Adaptive practice packet stays bounded without a repeated generator contract",
    7,
    serializedBytes(practice) <= 6_500
      && !("generatorContract" in practice)
      && (practice.evidence as unknown[]).length > 0,
    { bytes: serializedBytes(practice), keys: Object.keys(practice) },
  );
  check(
    "context.no_repeated_contracts",
    "context",
    "Common answer and practice payloads do not repeat static prose contracts",
    5,
    !("answerContract" in groundedKnown)
      && !("generatorContract" in practice),
    {
      answerKeys: Object.keys(groundedKnown),
      practiceKeys: Object.keys(practice),
    },
  );

  const createdCards = await tool(client, "create_flashcards", {
    cards: [{
      front: "What controls the step size in gradient descent?",
      back: "The learning rate.",
      conceptId: "gradient-descent",
      sourceIds: [optimizationSourceId],
      tags: ["optimization"],
    }],
  });
  const cardId = String((createdCards.cardIds as unknown[])[0]);
  const dueBefore = await tool(client, "get_review_queue");
  const queuedCard = (dueBefore.cards as Array<Record<string, unknown>>)[0]!;
  const revealedCard = await tool(client, "get_review_queue", {
    cardId,
    includeBack: true,
  });
  const review = await tool(client, "record_review", {
    cardId,
    grade: 5,
    elapsedMs: 4200,
  });
  const reviewedConcept = review.concept as Record<string, unknown>;
  check(
    "review.schedule_mastery",
    "learning",
    "Review scheduling advances due time and updates concept mastery",
    6,
    (dueBefore.cards as unknown[]).length === 1
      && !("back" in queuedCard)
      && ((revealedCard.cards as Array<Record<string, unknown>>)[0]?.back === "The learning rate.")
      && Number(review.intervalDays) === 1
      && Number(reviewedConcept.mastery) > 0.3
      && Number(reviewedConcept.mastery) < 0.4
      && Number(reviewedConcept.attempts) === 1,
    { queue: dueBefore, revealed: revealedCard, review },
  );
  check(
    "context.review_queue_minimal",
    "context",
    "Default review queue returns one front without leaking backs; one exact lookup reveals only the attempted answer",
    5,
    (dueBefore.cards as unknown[]).length === 1
      && !("back" in queuedCard)
      && (revealedCard.cards as unknown[]).length === 1
      && serializedBytes(dueBefore) <= 1_500,
    { bytes: serializedBytes(dueBefore), queue: dueBefore },
  );
  const masteryTrajectory = [Number(reviewedConcept.mastery)];
  const confidenceTrajectory = [Number(reviewedConcept.confidence)];
  for (const grade of [5, 5, 5, 5, 0]) {
    const nextReview = await tool(client, "record_review", {
      cardId,
      grade,
      elapsedMs: 4000,
    });
    const concept = nextReview.concept as Record<string, unknown>;
    masteryTrajectory.push(Number(concept.mastery));
    confidenceTrajectory.push(Number(concept.confidence));
  }
  const successesRiseGradually = masteryTrajectory
    .slice(0, 5)
    .every((value, index, values) =>
      index === 0 || value > values[index - 1]!);
  const confidenceNeverFalls = confidenceTrajectory.every((value, index, values) =>
    index === 0 || value >= values[index - 1]!);
  check(
    "learning.longitudinal_mastery",
    "learning",
    "Mastery accumulates across repeated success, confidence follows evidence, and later failure lowers the estimate",
    7,
    successesRiseGradually
      && masteryTrajectory.slice(0, 5).every((value) => value < 0.8)
      && masteryTrajectory.at(-1)! < masteryTrajectory.at(-2)!
      && confidenceNeverFalls,
    { masteryTrajectory, confidenceTrajectory },
  );
  const bulkCards = await tool(client, "create_flashcards", {
    cards: Array.from({ length: 49 }, (_, index) => ({
      front: `Scaled recall prompt ${index + 1}`,
      back: `Scaled grounded answer ${index + 1}`,
      conceptId: "gradient-descent",
      sourceIds: [optimizationSourceId],
    })),
  });
  check(
    "context.bulk_write_delta",
    "context",
    "Bulk flashcard writes return IDs and one due timestamp without echoing card content",
    5,
    bulkCards.created === 49
      && (bulkCards.cardIds as unknown[]).length === 49
      && !("cards" in bulkCards)
      && serializedBytes(bulkCards) <= 3_500,
    { bytes: serializedBytes(bulkCards), keys: Object.keys(bulkCards) },
  );

  const concurrentGoalCount = 32;
  const concurrentGoalWrites = await Promise.all(Array.from(
    { length: concurrentGoalCount },
    (_, index) => tool(client!, "set_study_goal", {
      title: `Concurrent persistence goal ${index}`,
      conceptIds: [],
      targetMastery: 0.75,
      minutesPerWeek: 30,
    }),
  ));
  const concurrentGoalIds = concurrentGoalWrites.map((result) =>
    String((result.goal as Record<string, unknown>).id));
  const concurrencyDashboard = await jsonResource(client, "study://dashboard");
  const concurrencyCounts = concurrencyDashboard.counts as Record<string, unknown>;
  check(
    "persistence.concurrent_tool_writes",
    "persistence",
    "Parallel MCP mutations preserve every independent write",
    8,
    new Set(concurrentGoalIds).size === concurrentGoalCount
      && concurrencyCounts.activeGoals === concurrentGoalCount,
    {
      requested: concurrentGoalCount,
      uniqueIds: new Set(concurrentGoalIds).size,
      counts: concurrencyCounts,
    },
  );

  await tool(client, "set_study_goal", {
    title: "Master optimization foundations",
    conceptIds: ["gradient-descent", "derivatives"],
    targetMastery: 0.85,
    minutesPerWeek: 180,
  });
  const plan = await tool(client, "plan_study_session", { minutes: 50 });
  const blocks = plan.blocks as Array<Record<string, unknown>>;
  check(
    "planning.adaptive_blocks",
    "learning",
    "Study plan combines retrieval, weak-concept repair, interleaving, and reflection",
    5,
    blocks.length >= 3
      && blocks.some((block) => block.activity === "Interleaved practice")
      && plan.activeGoalCount === concurrentGoalCount + 1
      && (plan.activeGoals as unknown[]).length <= 3
      && (plan.priorityConcepts as unknown[]).length >= 1
      && !("weakestConcepts" in plan)
      && serializedBytes(plan) <= 4_500,
    { bytes: serializedBytes(plan), blocks: blocks.map((block) => block.activity) },
  );
  const priorityConcepts = plan.priorityConcepts as Array<Record<string, unknown>>;
  const topMisconceptions = priorityConcepts[0]?.activeMisconceptions as Array<Record<string, unknown>>;
  const misconceptionId = String(topMisconceptions[0]?.id);
  const resolvedMisconception = await tool(client, "resolve_misconception", {
    conceptId: "derivatives",
    misconceptionId,
  });
  check(
    "learning.misconception_resolution",
    "learning",
    "Adaptive planning surfaces the recurring misconception and resolution removes it from active priority",
    4,
    String(blocks.find((block) => block.activity === "Repair the highest-priority concept")?.action)
      .includes("Confuses the chain rule")
      && Boolean((resolvedMisconception.misconception as Record<string, unknown>).resolvedAt),
    { topPriority: priorityConcepts[0], resolvedMisconception },
  );
  const reconnected = await createStudyServer(vault);
  const reconnectedClient = new Client({
    name: "metis-reset-evaluator",
    version: "1.0.0",
  });
  const [resetClientTransport, resetServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    reconnected.server.connect(resetServerTransport),
    reconnectedClient.connect(resetClientTransport),
  ]);
  try {
    const resumedLookup = objectContent(await reconnectedClient.callTool({
      name: "search_knowledge",
      arguments: { query: "differentiation" },
    }));
    const resumedConcept = (resumedLookup.concepts as Array<Record<string, unknown>>)[0]!;
    const resumedLearner = resumedConcept.learner as Record<string, unknown>;
    const resumedPlan = objectContent(await reconnectedClient.callTool({
      name: "plan_study_session",
      arguments: { minutes: 30 },
    }));
    check(
      "context.transcript_independent_resume",
      "context",
      "A fresh MCP client reconstructs learner state and next study decisions without prior transcript",
      8,
      resumedConcept.key === "derivatives"
        && Number(resumedLearner.attempts) >= 1
        && (resumedPlan.priorityConcepts as unknown[]).length >= 1
        && serializedBytes(resumedLookup) <= 2_500,
      {
        lookupBytes: serializedBytes(resumedLookup),
        concept: resumedConcept,
        planBytes: serializedBytes(resumedPlan),
      },
    );
  } finally {
    await reconnectedClient.close();
    await reconnected.server.close();
  }
  await Promise.all(Array.from({ length: 25 }, (_, index) =>
    tool(client!, "upsert_wiki_page", {
      title: `Scale Concept ${index + 1}`,
      summary: "A scale fixture for bounded maintenance responses.",
      markdown: [
        `# Scale Concept ${index + 1}`,
        "",
        `A derivative measures instantaneous rate of change. [${calculusSourceId}#L3-L3]`,
      ].join("\n"),
      sourceIds: [calculusSourceId],
      links: [`missing-scale-link-${index + 1}`],
      tags: ["scale-fixture"],
    })));
  const scaledLintFirst = await tool(client, "lint_wiki");
  const scaledLintSecond = await tool(client, "lint_wiki", {
    offset: 20,
  });
  const scaledDiscovery = await client.listResources();
  check(
    "context.bounded_maintenance_page",
    "context",
    "Large lint results paginate and populated discovery remains independent of vault cardinality",
    6,
    scaledLintFirst.issueCount === 25
      && (scaledLintFirst.issues as unknown[]).length === 20
      && scaledLintFirst.nextOffset === 20
      && (scaledLintSecond.issues as unknown[]).length === 5
      && serializedBytes(scaledLintFirst) <= 5_500
      && serializedBytes(scaledDiscovery) <= 2_500,
    {
      firstBytes: serializedBytes(scaledLintFirst),
      secondBytes: serializedBytes(scaledLintSecond),
      discoveryBytes: serializedBytes(scaledDiscovery),
    },
  );
  const dashboardResource = await client.readResource({ uri: "study://dashboard" });
  const dashboardText = dashboardResource.contents[0] && "text" in dashboardResource.contents[0]
    ? dashboardResource.contents[0].text
    : "{}";
  const dashboard = JSON.parse(dashboardText) as Record<string, unknown>;
  const dashboardCounts = dashboard.counts as Record<string, unknown>;
  check(
    "progress.dashboard_resource",
    "learning",
    "Dashboard resource reflects sources, concepts, cards, reviews, and active goals",
    5,
    dashboardCounts.sources === 9
      && dashboardCounts.concepts === 27
      && dashboardCounts.cards === 50
      && dashboardCounts.activeGoals === concurrentGoalCount + 1
      && dashboardCounts.reviews === 6
      && (dashboard.recentReviews as unknown[]).length === 5
      && (dashboard.activeGoals as unknown[]).length <= 3
      && Buffer.byteLength(dashboardText) <= 3_000,
    dashboard,
  );
  const graph = await tool(client, "get_knowledge_graph");
  const focusedGraph = await tool(client, "get_knowledge_graph", {
    focusId: "derivatives",
    limit: 10,
    mermaid: true,
  });
  const graphNodes = focusedGraph.nodes as Array<Record<string, unknown>>;
  const graphEdges = focusedGraph.edges as Array<Record<string, unknown>>;
  check(
    "progress.knowledge_graph",
    "learning",
    "Bounded graph neighborhoods connect concepts to evidence and goals while displaying mastery",
    5,
    graph.truncated === true
      && (graph.nodes as unknown[]).length <= 30
      && serializedBytes(graph) <= 12_000
      && !("mermaid" in graph)
      && graphNodes.some((node) => node.type === "concept" && node.mastery !== undefined)
      && graphNodes.some((node) => node.type === "source")
      && graphNodes.some((node) => node.type === "goal")
      && graphEdges.some((edge) => edge.type === "supported_by")
      && graphEdges.some((edge) => edge.type === "targets")
      && String(focusedGraph.mermaid).startsWith("flowchart LR"),
    {
      globalBytes: serializedBytes(graph),
      globalNodes: (graph.nodes as unknown[]).length,
      focusedNodes: graphNodes.length,
      focusedEdges: graphEdges.length,
    },
  );

  const mathKnown = await tool(client, "verify_math", {
    expression: "(17/3)^2 + sqrt(2)",
    precision: 40,
  });
  const mathResult = mathKnown.result as Record<string, unknown>;
  check(
    "math.known_answer",
    "math",
    "Python verifier returns an accurate known numerical result",
    6,
    mathKnown.ok === true
      && Math.abs(Number(mathResult.decimal) - 33.525324673484206) < 1e-14
      && String(mathKnown.verifiedBy).includes("Python"),
    mathKnown,
  );
  const mathSolve = await tool(client, "verify_math", {
    operation: "solve",
    expression: "2*x + 3 = 17",
    solveFor: "x",
  });
  check(
    "math.equation_solve",
    "math",
    "Equation solving returns a verified exact result",
    3,
    mathSolve.ok === true
      && (mathSolve.solutions as Array<Record<string, unknown>>)[0]?.exact === "7",
    mathSolve,
  );
  const largeMath = await tool(client, "verify_math", {
    expression: `${"9".repeat(700)}*${"9".repeat(700)}`,
  });
  check(
    "context.math_result_budget",
    "context",
    "Large valid exact results are bounded without echoing verifier inputs",
    5,
    largeMath.ok === true
      && largeMath.truncated === true
      && !("expression" in largeMath)
      && !("variables" in largeMath)
      && serializedBytes(largeMath) <= 4_000,
    { bytes: serializedBytes(largeMath), keys: Object.keys(largeMath) },
  );
  const malicious = await tool(client, "verify_math", {
    expression: "__import__('os').system('echo unsafe')",
  });
  check(
    "math.reject_code_execution",
    "math",
    "Expression grammar rejects Python code execution and attribute access",
    4,
    malicious.ok === false
      && String(malicious.error).toLowerCase().includes("allowed"),
    malicious,
  );

  const rendered = await tool(client, "render_math_pdf", {
    title: "Verified Derivative",
    outputName: "eval-verified-derivative",
    latexBody: String.raw`\section*{Power Rule}
For \(f(x)=x^3\), the power rule gives
\[
f'(x)=3x^2.
\]
\begin{align*}
f'(2)&=3(2)^2\\
&=12.
\end{align*}`,
  });
  const pdfBytes = await readFile(String(rendered.pdfPath));
  const texSource = await readFile(String(rendered.texPath), "utf8");
  check(
    "pdf.real_pdf",
    "pdf",
    "MCP compiles a real AMS-math PDF and preserves controlled TeX source",
    7,
    pdfBytes.subarray(0, 5).toString() === "%PDF-"
      && pdfBytes.byteLength > 1000
      && !texSource.includes("\\write18")
      && texSource.includes("\\usepackage{amsmath,amssymb,mathtools}"),
    { bytes: pdfBytes.byteLength, compiler: rendered.compiler },
  );
} catch (error) {
  check(
    "suite.unhandled_error",
    "harness",
    "Evaluation completes without an unhandled infrastructure error",
    0,
    false,
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
} finally {
  if (client) await client.close().catch(() => undefined);
  if (mcpServer) await mcpServer.close().catch(() => undefined);
  await rm(vault, { recursive: true, force: true });
}

const finishedAt = new Date();
const maximumScore = checks.reduce((total, item) => total + item.weight, 0);
const score = checks
  .filter((item) => item.passed)
  .reduce((total, item) => total + item.weight, 0);
const percentage = maximumScore === 0 ? 0 : Number((score / maximumScore * 100).toFixed(2));
const criticalPassed = checks
  .filter((item) => item.critical)
  .every((item) => item.passed)
  && cases.criticalChecks.every((id) => checks.some((item) => item.id === id));
const passed = percentage >= cases.passThreshold && criticalPassed;
const report: EvalReport = {
  suite: "Metis MCP deterministic capability evaluation",
  version: cases.schemaVersion,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  score,
  maximumScore,
  percentage,
  threshold: cases.passThreshold,
  passed,
  criticalPassed,
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    ci: process.argv.includes("--ci") ? "true" : "false",
  },
  checks,
};

const resultsDirectory = path.join(projectRoot, ".eval-results");
await mkdir(resultsDirectory, { recursive: true });
await writeFile(
  path.join(resultsDirectory, "latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(resultsDirectory, "latest.md"),
  renderMarkdown(report),
  "utf8",
);

process.stdout.write(renderConsole(report));
if (!passed) process.exitCode = 1;

function renderConsole(reportValue: EvalReport): string {
  const lines = [
    "",
    `${reportValue.passed ? "PASS" : "FAIL"} ${reportValue.suite}`,
    `Score: ${reportValue.score}/${reportValue.maximumScore} (${reportValue.percentage}%), threshold ${reportValue.threshold}%`,
    `Critical checks: ${reportValue.criticalPassed ? "passed" : "failed"}`,
    "",
  ];
  for (const item of reportValue.checks) {
    lines.push(`${item.passed ? "✓" : "✗"} ${item.id} [${item.weight}] ${item.description}`);
    if (!item.passed) lines.push(`  Evidence: ${item.evidence.slice(0, 500)}`);
  }
  lines.push("", "Reports: .eval-results/latest.json and .eval-results/latest.md", "");
  return lines.join("\n");
}

function renderMarkdown(reportValue: EvalReport): string {
  const rows = reportValue.checks.map((item) =>
    `| ${item.passed ? "Pass" : "Fail"} | \`${item.id}\` | ${item.category} | ${item.weight} | ${item.description.replaceAll("|", "\\|")} |`);
  return [
    "# Metis MCP Evaluation",
    "",
    `- Result: **${reportValue.passed ? "PASS" : "FAIL"}**`,
    `- Score: **${reportValue.score}/${reportValue.maximumScore} (${reportValue.percentage}%)**`,
    `- Required threshold: ${reportValue.threshold}% and all critical checks`,
    `- Critical checks: ${reportValue.criticalPassed ? "passed" : "failed"}`,
    `- Duration: ${reportValue.durationMs} ms`,
    `- Finished: ${reportValue.finishedAt}`,
    "",
    "| Result | Check | Category | Weight | Criterion |",
    "|---|---|---:|---:|---|",
    ...rows,
    "",
    "## Failed-check evidence",
    "",
    ...reportValue.checks
      .filter((item) => !item.passed)
      .flatMap((item) => [
        `### ${item.id}`,
        "",
        "```text",
        item.evidence.slice(0, 5000),
        "```",
        "",
      ]),
  ].join("\n");
}
